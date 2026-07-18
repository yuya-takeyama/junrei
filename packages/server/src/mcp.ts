import {
  buildSourceCompleteness,
  type ClaudeSessionAnalysis,
  listReconstructableRequests,
  loadReconstructionInput,
  localClaudeSessionStore,
  type ReconstructedMessageBlock,
  type ReconstructedRequest,
  type ReconstructedSection,
  type ReconstructedSystemBlock,
  type ReconstructionProviders,
  type RecordDetail,
  reconstructRequest,
  type SourceKind,
  type ToolCallDetail,
} from "@junrei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRepoOverview } from "./overview.js";
import {
  DEFAULT_MAX_MATCHES_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  MAX_MATCHES_PER_SESSION,
  MAX_MAX_SESSIONS,
  searchSessions,
} from "./search.js";
import {
  type CodexSessionAnalysisWithSubagents,
  getCodexSession,
  getCodexSessionRecordDetail,
  getCodexSessionToolCallDetail,
  getSession,
  getSessionRecordDetail,
  getSessionToolCallDetail,
  listSessions,
  MAX_LIST_LIMIT,
} from "./sessions.js";
import {
  createFilesystemDiskContextProvider,
  createFilesystemTemplateProvider,
} from "./sources/reconstruction.js";

const sessionRef = {
  source: z.enum(["claude-code", "codex"]).describe("Which harness the session came from"),
  sessionId: z.string().describe("Session UUID (from list_sessions)"),
};

/** Both source kinds — every multi-source tool (list_sessions, search_sessions, get_repo_overview) passes this. */
const BOTH_SOURCES: SourceKind[] = ["claude-session-jsonl", "codex-session-jsonl"];

/** Which `sourceCompleteness` kind a resolved session's harness maps to. */
function sourceKindFor(source: "claude-code" | "codex"): SourceKind {
  return source === "codex" ? "codex-session-jsonl" : "claude-session-jsonl";
}

/**
 * Map a multi-source tool's `source` filter arg to the kinds its response
 * actually draws from — a response filtered to one harness must not declare
 * completeness for the other.
 */
function kindsForFilter(source: "claude-code" | "codex" | "all" | undefined): SourceKind[] {
  if (source === "claude-code") return ["claude-session-jsonl"];
  if (source === "codex") return ["codex-session-jsonl"];
  return BOTH_SOURCES;
}

/**
 * JSON-encode a tool payload, always stamping a top-level `sourceCompleteness`
 * (see `@junrei/core`'s `buildSourceCompleteness`) so every response declares
 * what its underlying session source(s) cannot show — attached here, not
 * per-handler, so no tool can forget it. `kinds` is the caller's static
 * declaration of which source(s) the payload was built from (see call sites
 * below for the mapping); `value` must be a plain object so its own fields
 * survive the merge untouched (additive only).
 */
function jsonResult<T extends object>(value: T, kinds: SourceKind[]) {
  const payload = { ...value, sourceCompleteness: buildSourceCompleteness(kinds) };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function notFound(sessionId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Session not found: ${sessionId}. Use list_sessions to discover sessions.`,
      },
    ],
    isError: true,
  };
}

/**
 * `repo` blank/whitespace-only. A `repo` that's well-formed but simply
 * matches no session is NOT an error — `computeRepoOverview` returns a
 * zeroed overview for that case (see its doc comment), so an agent can
 * safely probe candidate keys without a not-found round-trip.
 */
function missingRepo() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "repo is required — pass a repoRoot path or fallback bucket key " +
          "(claude-project:<projectDirName> / codex-repo:<repoUrl> / codex-cwd:<cwd>) " +
          "from list_sessions items.",
      },
    ],
    isError: true,
  };
}

/**
 * Claude-only tools (repetition detection, task executions) have no Codex
 * analog. `get_subagent_tree` USED to be Claude-only too, but Codex sub-agent
 * threads (`codex/orchestration.ts` in `@junrei/core`) now have a real tree
 * — see `resolveAnalysis`/`get_subagent_tree` below.
 */
function notAvailableForCodex() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "not available for Codex sessions (source: codex) — Codex CLI has no repetition " +
          "detection or task-execution log in Junrei today.",
      },
    ],
    isError: true,
  };
}

/**
 * `get_reconstructed_request` is Claude-Code-only: the "virtual wire"
 * reconstruction rules (`@junrei/core`'s `claude/reconstruction/`) are
 * calibrated specifically against Claude Code's session-log shape and
 * harness-injected reminders — Codex CLI has no equivalent module.
 */
function notAvailableForReconstruction() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "not available for Codex sessions (source: codex) — request reconstruction is a " +
          "Claude-Code-specific capability (session-log shape, harness reminder injections, " +
          "and per-CLI-version templates all assume the Claude Code harness); Codex CLI has no " +
          "equivalent in Junrei today.",
      },
    ],
    isError: true,
  };
}

type SessionRefArgs = {
  source: "claude-code" | "codex";
  sessionId: string;
};

type ResolvedAnalysis =
  | { source: "claude-code"; analysis: ClaudeSessionAnalysis }
  | { source: "codex"; analysis: CodexSessionAnalysisWithSubagents }
  | { error: ReturnType<typeof notFound> };

/**
 * Resolve either harness's analysis from `{source, sessionId}` — both sources
 * now look up by bare session id alone (Claude used to also require
 * `project`, but session ids are UUIDv4, so a bare id resolves unambiguously;
 * see `ClaudeSessionKey`'s doc comment in `sources/claude.ts`).
 */
async function resolveAnalysis(args: SessionRefArgs): Promise<ResolvedAnalysis> {
  if (args.source === "codex") {
    const analysis = await getCodexSession(args.sessionId);
    return analysis === undefined
      ? { error: notFound(args.sessionId) }
      : { source: "codex", analysis };
  }
  const analysis = await getSession(args.sessionId);
  return analysis === undefined
    ? { error: notFound(args.sessionId) }
    : { source: "claude-code", analysis };
}

/** Compact summary: the full analysis minus bulky series (fetch those via dedicated tools). */
function toSummary(analysis: ClaudeSessionAnalysis) {
  const {
    contextTimeline,
    subagents,
    toolStats,
    repetitions,
    taskExecutions,
    turnUsage,
    apiErrors,
    ...rest
  } = analysis;
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const task of taskExecutions) {
    byKind[task.kind] = (byKind[task.kind] ?? 0) + 1;
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  }
  const errorsByStatus: Record<string, number> = {};
  for (const error of apiErrors) {
    const key = error.status === undefined ? "unknown" : String(error.status);
    errorsByStatus[key] = (errorsByStatus[key] ?? 0) + 1;
  }
  return {
    ...rest,
    toolStats,
    repetitionCount: repetitions.length,
    taskExecutions: { total: taskExecutions.length, byKind, byStatus },
    contextTimeline: {
      points: contextTimeline.length,
      peakContextTokens: Math.max(0, ...contextTimeline.map((p) => p.contextTokens)),
      lastContextTokens: contextTimeline.at(-1)?.contextTokens ?? 0,
    },
    turnUsage: {
      turns: turnUsage.length,
      totalApiMessages: turnUsage.reduce((sum, t) => sum + t.apiMessageCount, 0),
      peakOutputTokens: Math.max(0, ...turnUsage.map((t) => t.outputTokens)),
      peakApiMessages: Math.max(0, ...turnUsage.map((t) => t.apiMessageCount)),
    },
    // apiErrorCount (in ...rest) keeps counting past the list cap; this
    // histogram covers only the listed entries.
    apiErrors: { listed: apiErrors.length, byStatus: errorsByStatus },
  };
}

/**
 * Codex analog of `toSummary` — same "trim the bulky series" shape, over
 * Codex's own fields. `subagents` (the full tree) is trimmed the same way
 * Claude's `toSummary` trims it — `subagentCount` stays in `...rest` for the
 * cheap "does this session delegate at all" signal; use `get_subagent_tree`
 * for the full tree.
 */
function toCodexSummary(analysis: CodexSessionAnalysisWithSubagents) {
  const { contextTimeline, codex, subagents, ...rest } = analysis;
  const { turns, ...codexRest } = codex;
  return {
    ...rest,
    contextTimeline: {
      points: contextTimeline.length,
      peakContextTokens: Math.max(0, ...contextTimeline.map((p) => p.contextTokens)),
      lastContextTokens: contextTimeline.at(-1)?.contextTokens ?? 0,
    },
    codex: {
      ...codexRest,
      turns: {
        count: turns.length,
        totalOutputTokens: turns.reduce((sum, t) => sum + t.outputTokens, 0),
        peakOutputTokens: Math.max(0, ...turns.map((t) => t.outputTokens)),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// get_records / get_tool_call — line-level evidence primitives. Both cap
// their text fields EXPLICITLY: a value that got cut always says so, via a
// `*Truncated` flag plus the field's original char count, rather than
// silently handing back a shorter string.
// ---------------------------------------------------------------------------

const GET_RECORDS_DEFAULT_MAX_CHARS = 30000;
const GET_RECORDS_MIN_MAX_CHARS = 200;
const GET_RECORDS_MAX_LINES = 50;
const GET_TOOL_CALL_DEFAULT_MAX_CHARS = 30000;
const GET_TOOL_CALL_MIN_MAX_CHARS = 200;

/**
 * The text-bearing fields of one `RecordDetail`, by kind — exactly the
 * fields `get_records` may need to cap. Listed explicitly (not a generic
 * "every string field" walk) so a numeric/boolean field can never be
 * mistaken for capturable text, and so `tool-call`'s `input` (typed
 * `unknown`, not `string`) gets JSON-stringified before length checks.
 */
function textFieldsOf(detail: RecordDetail): { key: string; value: string }[] {
  switch (detail.kind) {
    case "user":
    case "injected-context":
    case "assistant-text":
    case "thinking":
      return [{ key: "text", value: detail.text }];
    case "tool-call": {
      const fields = [
        {
          key: "input",
          value:
            typeof detail.input === "string" ? detail.input : JSON.stringify(detail.input ?? null),
        },
      ];
      if (detail.resultText !== undefined)
        fields.push({ key: "resultText", value: detail.resultText });
      return fields;
    }
    case "subagent-launch": {
      const fields: { key: string; value: string }[] = [];
      if (detail.prompt !== undefined) fields.push({ key: "prompt", value: detail.prompt });
      if (detail.returnedText !== undefined) {
        fields.push({ key: "returnedText", value: detail.returnedText });
      }
      return fields;
    }
    case "task-notification":
    case "compaction":
      return [];
    case "api-error":
      return detail.message !== undefined ? [{ key: "message", value: detail.message }] : [];
    default:
      return [];
  }
}

/**
 * Per-field TRUE length, when it differs from the field's own `.length` —
 * `get_records`' analog of `capTextField`'s `trueLength` parameter (used by
 * `get_tool_call`). Only `tool-call.resultText` and `subagent-launch
 * .returnedText` ever carry this today: Claude's parser can cap the
 * underlying tool_result before this API ever sees it, and drill-down
 * recovery (`claude/timeline.ts`) doesn't always manage to close the gap —
 * see `ToolCallRecordDetail.resultTextFullCharCount`'s doc comment in
 * `@junrei/core`. Absent from the returned map (falls back to the field's
 * own `.length` in `truncateRecordDetail`) whenever a field is already
 * complete.
 */
function trueLengthsOf(detail: RecordDetail): Record<string, number> {
  if (detail.kind === "tool-call" && detail.resultTextFullCharCount !== undefined) {
    return { resultText: detail.resultTextFullCharCount };
  }
  if (detail.kind === "subagent-launch" && detail.returnedTextFullCharCount !== undefined) {
    return { returnedText: detail.returnedTextFullCharCount };
  }
  return {};
}

/**
 * Cap `detail`'s text-bearing fields (see `textFieldsOf`) to `maxChars`,
 * reporting whether ANY field was actually cut OR is already short of its
 * own true length (see `trueLengthsOf` — a field can be incomplete
 * independent of `maxChars`, e.g. Claude drill-down recovery that couldn't
 * close the parser's own capture-cap gap), plus the pre-cut TRUE total char
 * count across every text-bearing field (not just the cut ones) — "how much
 * text this record really carries, of which you're seeing a capped slice".
 * A capped `tool-call.input` is replaced by its JSON-stringified, capped
 * text — no longer the structured value — precisely because `contentTruncated`
 * flags that swap; an untruncated `input` stays whatever value it always was.
 */
function truncateRecordDetail(
  detail: RecordDetail,
  maxChars: number,
): { detail: RecordDetail; contentTruncated: boolean; originalCharCount?: number } {
  const fields = textFieldsOf(detail);
  const trueLengths = trueLengthsOf(detail);
  let totalChars = 0;
  let truncatedAny = false;
  const patch: Record<string, string> = {};
  for (const { key, value } of fields) {
    const trueLength = trueLengths[key] ?? value.length;
    totalChars += trueLength;
    if (value.length > maxChars) {
      truncatedAny = true;
      patch[key] = `${value.slice(0, maxChars)}…`;
    } else if (trueLength > value.length) {
      // Already short of the truth (recovery couldn't close the gap) even
      // though this cap didn't need to cut it further — still truncated.
      truncatedAny = true;
    }
  }
  if (!truncatedAny) return { detail, contentTruncated: false };
  return {
    detail: { ...detail, ...patch } as RecordDetail,
    contentTruncated: true,
    originalCharCount: totalChars,
  };
}

/**
 * Cap one already-string field (e.g. `get_tool_call`'s `result.text`) to
 * `maxChars`. `trueLength`, when given and larger than `text.length`, flags
 * truncation EVEN WHEN `text` itself is under `maxChars` — the Claude Code
 * parser caps captured tool_result text at a fixed length before this API
 * ever sees it (see `ToolCallDetailResult.fullTextLength`'s doc comment in
 * `@junrei/core`), so a field can be "already short of the truth" independent
 * of this tool's own cap.
 */
function capTextField(
  text: string,
  maxChars: number,
  trueLength?: number,
): { text: string; truncated: boolean; fullCharCount?: number } {
  const knownFullLength = trueLength ?? text.length;
  const needsCut = text.length > maxChars;
  const alreadyShort = knownFullLength > text.length;
  if (!needsCut && !alreadyShort) return { text, truncated: false };
  return {
    text: needsCut ? `${text.slice(0, maxChars)}…` : text,
    truncated: true,
    fullCharCount: knownFullLength,
  };
}

/** Cap `input` (arbitrary JSON) to `maxChars`, stringifying only when a cut is actually needed. */
function capInputField(
  input: unknown,
  maxChars: number,
): { input: unknown; truncated: boolean; fullCharCount?: number } {
  const serialized = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (serialized.length <= maxChars) return { input, truncated: false };
  return {
    input: `${serialized.slice(0, maxChars)}…`,
    truncated: true,
    fullCharCount: serialized.length,
  };
}

/**
 * `get_tool_call`'s not-found message — mirrors `notFound`'s "how to
 * discover a valid one" pattern, pointed at the tools that surface a
 * `toolUseId`.
 */
function toolCallNotFound(toolUseId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `toolUseId not found in this session: ${toolUseId}. toolUseId comes from another ` +
          'tool\'s own "toolUseId" field (get_records, get_context_timeline, find_repetitions, ' +
          "get_subagent_tree) and must belong to THIS session's own transcript (source/sessionId) " +
          "— a subagent's tool calls aren't reachable through this lookup.",
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// get_reconstructed_request — output shaping. Reuses the SAME
// `capTextField`/`capInputField` primitives `get_tool_call` uses above, so a
// reconstructed block's text/value is capped with exactly the same explicit
// truncation contract: a `*Truncated` flag plus the untruncated char count,
// never a silently shorter payload. `confidence`/`provenance`/`note` are
// carried through UNCAPPED — they're small, structured, and are the whole
// point of this tool (never worth truncating).
// ---------------------------------------------------------------------------

const GET_RECONSTRUCTED_REQUEST_DEFAULT_MAX_CHARS = 20000;
const GET_RECONSTRUCTED_REQUEST_MIN_MAX_CHARS = 200;

function cappedSystemBlock(block: ReconstructedSystemBlock, maxChars: number) {
  const capped = block.text !== undefined ? capTextField(block.text, maxChars) : undefined;
  return {
    ...(capped !== undefined && { text: capped.text }),
    textTruncated: capped?.truncated ?? false,
    ...(capped?.fullCharCount !== undefined && { textFullCharCount: capped.fullCharCount }),
    confidence: block.confidence,
    provenance: block.provenance,
    ...(block.note !== undefined && { note: block.note }),
  };
}

function cappedMessageBlock(block: ReconstructedMessageBlock, maxChars: number) {
  const capped = block.value !== undefined ? capInputField(block.value, maxChars) : undefined;
  return {
    wireType: block.wireType,
    ...(capped !== undefined && { value: capped.input }),
    valueTruncated: capped?.truncated ?? false,
    ...(capped?.fullCharCount !== undefined && { valueFullCharCount: capped.fullCharCount }),
    confidence: block.confidence,
    provenance: block.provenance,
    ...(block.note !== undefined && { note: block.note }),
    ...(block.appliedRules !== undefined && { appliedRules: block.appliedRules }),
  };
}

function cappedSection(section: ReconstructedSection<unknown>, maxChars: number) {
  const capped = section.value !== undefined ? capInputField(section.value, maxChars) : undefined;
  return {
    ...(capped !== undefined && { value: capped.input }),
    valueTruncated: capped?.truncated ?? false,
    ...(capped?.fullCharCount !== undefined && { valueFullCharCount: capped.fullCharCount }),
    confidence: section.confidence,
    provenance: section.provenance,
    ...(section.note !== undefined && { note: section.note }),
  };
}

function cappedReconstructedRequest(request: ReconstructedRequest, maxChars: number) {
  return {
    ...(request.requestId !== undefined && { requestId: request.requestId }),
    ordinal: request.ordinal,
    targetLine: request.targetLine,
    system: request.system.map((block) => cappedSystemBlock(block, maxChars)),
    tools: cappedSection(request.tools, maxChars),
    params: cappedSection(request.params, maxChars),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block) => cappedMessageBlock(block, maxChars)),
    })),
    appliedRules: request.appliedRules,
    limitations: request.limitations,
  };
}

/**
 * `get_reconstructed_request`'s not-found message for a `requestId`/`line`
 * that doesn't resolve to any request in this session — mirrors `notFound`'s
 * "how to discover a valid one" pattern, pointed at this tool's OWN discovery
 * path (call it again with neither arg).
 */
function reconstructionRequestNotFound(sessionId: string, target: string | number) {
  const targetDesc = typeof target === "string" ? `requestId "${target}"` : `line ${target}`;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `No reconstructable request found for ${targetDesc} in session ${sessionId}. Call ` +
          "get_reconstructed_request with neither requestId nor line to list this session's " +
          "reconstructable requests (requestId/ordinal/targetLine).",
      },
    ],
    isError: true,
  };
}

/**
 * Junrei's MCP interface: a small set of high-leverage tools that expose
 * quantitative session data. Junrei never evaluates — interpretation is the
 * caller's job.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "junrei", version: "0.1.0" });

  server.registerTool(
    "list_sessions",
    {
      description:
        "List recent Claude Code and/or Codex CLI sessions (newest first) with quantitative " +
        "overview: turns, tool calls/errors, subagents (Claude only), compactions, tokens, " +
        'estimated cost (USD). Each item\'s `source` field is "claude-code" or "codex". Each ' +
        "item also carries `repoRoot`/`worktreeName` (repo-level grouping key — see " +
        "get_repo_overview), a per-model `usageByModel` breakdown, and a `delegation` " +
        "main-vs-subagents split, so a repo- or model-level rollup can be built without " +
        "fetching every session's full summary. Every response includes sourceCompleteness — " +
        "a machine-readable declaration of what the underlying session source cannot show; " +
        "treat absent/not-recorded dimensions as unknowable from this data, not as evidence " +
        "of absence.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Max sessions (default 20)"),
        source: z
          .enum(["claude-code", "codex", "all"])
          .optional()
          .describe(
            "Restrict to one harness; omit for both, merged and sorted by start time (newest first)",
          ),
      },
    },
    // Omitted source = merged view, same default as the HTTP API — items
    // self-describe via `source`. Wrapped in `{ sessions }` (rather than the
    // bare array this tool used to return) so the mandatory top-level
    // `sourceCompleteness` has somewhere to attach — see `jsonResult`.
    async ({ limit, source }) =>
      jsonResult(
        { sessions: (await listSessions(limit ?? 20, source ?? "all")).sessions },
        kindsForFilter(source),
      ),
  );

  server.registerTool(
    "search_sessions",
    {
      description:
        "Substring search across session transcripts (both harnesses, newest session first). " +
        "The query is plain text (not regex), matched case-insensitively by default against " +
        "DECODED string values — user prompts, assistant text, tool inputs, tool results, " +
        "titles — never against raw JSON, so quotes/newlines in the query need no escaping " +
        "and JSON escaping in the log can never split a match. Use it to find WHICH past " +
        "session mentioned something while spending minimal context: each result carries the " +
        "session ref fields (`source`/`sessionId`) the session-scoped tools take, " +
        "a short snippet per matched record with its source line number, an exact per-session " +
        "`matchCount`, and explicit truncation flags (`matchesTruncated`/`resultsTruncated` — " +
        "a capped list is never silently complete). Drill into a hit with get_session_summary " +
        "/ get_first_prompt / get_context_timeline. Every response includes sourceCompleteness " +
        "— a machine-readable declaration of what the underlying session source cannot show; " +
        "treat absent/not-recorded dimensions as unknowable from this data, not as evidence " +
        "of absence.",
      inputSchema: {
        query: z.string().min(2).describe("Substring to find (plain text, not regex)"),
        source: z
          .enum(["claude-code", "codex", "all"])
          .optional()
          .describe("Restrict to one harness; omit for both"),
        project: z
          .string()
          .optional()
          .describe("Claude only: restrict to one munged project dir (from list_sessions)"),
        repo: z
          .string()
          .optional()
          .describe(
            "Restrict to one repo: a repoRoot path or fallback bucket key " +
              "(claude-project:<dir> / codex-repo:<repoUrl> / codex-cwd:<cwd>) — same " +
              "semantics as get_repo_overview",
          ),
        sessionId: z
          .string()
          .optional()
          .describe("Restrict to one session (locate where inside it something was said)"),
        fields: z
          .array(z.enum(["user", "assistant", "thinking", "tool_input", "tool_result", "title"]))
          .optional()
          .describe(
            'Record fields to search. Default: every field except "thinking" ' +
              "(opt in explicitly — thinking text is noisy).",
          ),
        caseSensitive: z.boolean().optional().describe("Default false"),
        since: z
          .string()
          .optional()
          .describe("ISO 8601 — only sessions last active at/after this time"),
        until: z
          .string()
          .optional()
          .describe("ISO 8601 — only sessions last active at/before this time"),
        scanLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(
            `How many most-recent sessions to scan after filtering (default ${MAX_LIST_LIMIT} ` +
              "= everything listable)",
          ),
        maxSessions: z
          .number()
          .int()
          .min(1)
          .max(MAX_MAX_SESSIONS)
          .optional()
          .describe(`Max matched sessions returned (default ${DEFAULT_MAX_SESSIONS})`),
        maxMatchesPerSession: z
          .number()
          .int()
          .min(1)
          .max(MAX_MATCHES_PER_SESSION)
          .optional()
          .describe(
            `Max snippets per session (default ${DEFAULT_MAX_MATCHES_PER_SESSION}; ` +
              "matchCount stays exact past the cap)",
          ),
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            "Also search subagent transcripts (Claude sidecars / Codex sub-agent threads), " +
              "attributed to the parent session with agentId on each match. Default false",
          ),
      },
    },
    async (args) => {
      if (args.query.trim().length < 2) {
        return {
          content: [
            {
              type: "text" as const,
              text: "query must contain at least 2 non-whitespace-only characters.",
            },
          ],
          isError: true,
        };
      }
      for (const key of ["since", "until"] as const) {
        const value = args[key];
        if (value !== undefined && Number.isNaN(Date.parse(value))) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${key} is not a parseable ISO 8601 timestamp: ${value}`,
              },
            ],
            isError: true,
          };
        }
      }
      return jsonResult(await searchSessions(args), kindsForFilter(args.source));
    },
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "Full quantitative summary of one session: usage/cost per model (main + subagents), " +
        "a `delegation` split (main-thread vs. subagents share of tokens and cost — overall and " +
        "per model, e.g. to spot a session where the main model took most of the DOLLARS but " +
        "subagents moved most of the TOKENS), tool stats with error categories, exploration " +
        "profile, compactions, and counts. Works for both Claude Code sessions and Codex CLI " +
        'sessions (source: "codex"). Use get_context_timeline / find_repetitions / ' +
        "get_subagent_tree for the detailed series. A model-usage entry's `cacheWriteCostUsd` " +
        "(on `usage`/`totalUsageByModel`) is a component already included in `costUsd` — never " +
        "add them. `costIsComplete: false` (on `totalUsage`/`delegation`) means at least one " +
        "nonzero-usage model had no pricing entry, so the cost is a lower bound, shown as " +
        '"estimated" in the UI. Every response includes sourceCompleteness — a machine-readable ' +
        "declaration of what the underlying session source cannot show; treat absent/not-recorded " +
        "dimensions as unknowable from this data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        resolved.source === "codex"
          ? toCodexSummary(resolved.analysis)
          : toSummary(resolved.analysis),
        [sourceKindFor(resolved.source)],
      );
    },
  );

  server.registerTool(
    "get_context_timeline",
    {
      description:
        "Context-size series for one session: effective context tokens " +
        "(input + cache_read + cache_creation) per API message, plus compaction events " +
        "with pre/post token counts. Each point carries its source line number for provenance. " +
        'Works for both Claude Code sessions and Codex CLI sessions (source: "codex"). Every ' +
        "response includes sourceCompleteness — a machine-readable declaration of what the " +
        "underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        {
          contextTimeline: resolved.analysis.contextTimeline,
          compactions: resolved.analysis.compactions,
        },
        [sourceKindFor(resolved.source)],
      );
    },
  );

  server.registerTool(
    "find_repetitions",
    {
      description:
        "Repetition/loop findings for one session: consecutive identical tool calls, " +
        "same-file re-reads, and repeated failing calls. Includes source line numbers. " +
        "These are observations, not judgments — whether a repetition was wasteful " +
        "depends on the task. Claude Code sessions only. Every response includes " +
        "sourceCompleteness — a machine-readable declaration of what the underlying session " +
        "source cannot show; treat absent/not-recorded dimensions as unknowable from this " +
        "data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async ({ source, sessionId }) => {
      if (source === "codex") return notAvailableForCodex();
      const analysis = await getSession(sessionId);
      return analysis === undefined
        ? notFound(sessionId)
        : jsonResult({ repetitions: analysis.repetitions }, ["claude-session-jsonl"]);
    },
  );

  server.registerTool(
    "get_subagent_tree",
    {
      description:
        "Subagent/sub-agent execution tree for one session: per-agent type, model, prompt " +
        "preview, token usage, estimated cost, tool call/error counts, and nesting. Each node's " +
        "`usage.byModel` breaks that agent's own tokens/cost down per model, same shape as the " +
        "session-level `totalUsageByModel`. Works for both Claude Code sessions and Codex CLI " +
        'sessions (source: "codex") — a Codex sub-agent is its own rollout file rather than a ' +
        "sidecar transcript, but resolves into the same tree shape. As with get_session_summary: " +
        "a `byModel` entry's `cacheWriteCostUsd` is already included in `costUsd` (never add " +
        "them), and `usage.total.costIsComplete: false` means at least one nonzero-usage model " +
        'in that node had no pricing entry — the cost is a lower bound, shown as "estimated" in ' +
        "the UI. Claude Code sessions only also carry `workflowRuns`: one entry per Workflow-tool " +
        "run (name, status, phases, agentCount), for making sense of any tree node tagged with a " +
        "matching `workflowRunId` — those nodes are flat root-level entries in `subagents`, not a " +
        "separate nested structure. Every response includes sourceCompleteness — a " +
        "machine-readable declaration of what the underlying session source cannot show; treat " +
        "absent/not-recorded dimensions as unknowable from this data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        {
          subagentCount: resolved.analysis.subagentCount,
          subagents: resolved.analysis.subagents,
          ...(resolved.source === "claude-code" && {
            workflowRuns: resolved.analysis.workflowRuns,
          }),
        },
        [sourceKindFor(resolved.source)],
      );
    },
  );

  server.registerTool(
    "get_task_executions",
    {
      description:
        "All task executions of a session, as Claude Code's Background-tasks panel counts " +
        "them: every Bash command and Agent run (foreground and background) plus preview " +
        "servers — with start time, duration, and outcome (completed/failed/stopped/unresolved). " +
        "Claude Code sessions only. Every response includes sourceCompleteness — a " +
        "machine-readable declaration of what the underlying session source cannot show; treat " +
        "absent/not-recorded dimensions as unknowable from this data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async ({ source, sessionId }) => {
      if (source === "codex") return notAvailableForCodex();
      const analysis = await getSession(sessionId);
      return analysis === undefined
        ? notFound(sessionId)
        : jsonResult({ taskExecutions: analysis.taskExecutions }, ["claude-session-jsonl"]);
    },
  );

  server.registerTool(
    "get_first_prompt",
    {
      description:
        "The first user prompt of a session (truncated preview) — the original task " +
        "the quantitative data should be interpreted against. Works for both Claude Code " +
        'sessions and Codex CLI sessions (source: "codex"). Every response includes ' +
        "sourceCompleteness — a machine-readable declaration of what the underlying session " +
        "source cannot show; treat absent/not-recorded dimensions as unknowable from this " +
        "data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        {
          firstUserPrompt: resolved.analysis.firstUserPrompt ?? null,
          title: resolved.analysis.title ?? null,
          userTurnCount: resolved.analysis.userTurnCount,
        },
        [sourceKindFor(resolved.source)],
      );
    },
  );

  server.registerTool(
    "get_repo_overview",
    {
      description:
        "Repo-level retrospective across every session (both harnesses) in one repo: total " +
        "cost/tokens, a per-day cost timeline, a merged per-model breakdown, the main-vs-" +
        "subagents delegation split, and the top 5 sessions by cost. `repo` accepts either a " +
        "`repoRoot` absolute path (a list_sessions item's `repoRoot` field — a worktree " +
        "session, `.claude/worktrees/<name>` or Codex's `$CODEX_HOME/worktrees/<hash>`, " +
        "collapses into its parent repo's key, see `worktreeName`) " +
        "or, for a session with no `repoRoot`, the fallback bucket key list_sessions items " +
        "imply: `claude-project:<projectDirName>` (Claude), `codex-repo:<repoUrl>` (Codex " +
        "with a repository URL no local checkout anchors), or `codex-cwd:<cwd>` (Codex, " +
        "`codex-cwd:(unknown cwd)` when even `cwd` is missing). Examples: `/Users/me/junrei`, " +
        "`claude-project:-Users-me-proj`. A `byModel` entry's `cacheWriteCostUsd` (where " +
        "present, as in get_session_summary/get_subagent_tree) is already included in `costUsd` " +
        "— never add them. `costIsComplete: false` means at least one nonzero-usage model summed " +
        'into this rollup had no pricing entry, so totals are a lower bound, shown as "estimated" ' +
        "in the UI. A `repo` matching no session returns a zeroed overview (`sessionCount: 0`), " +
        "not an error — safe to probe candidate keys. Every response includes " +
        "sourceCompleteness — a machine-readable declaration of what the underlying session " +
        "source cannot show; treat absent/not-recorded dimensions as unknowable from this " +
        "data, not as evidence of absence.",
      inputSchema: {
        repo: z
          .string()
          .describe(
            "A repoRoot absolute path, or a fallback bucket key (claude-project:<projectDirName> " +
              "/ codex-repo:<repoUrl> / codex-cwd:<cwd>) for a session with no repoRoot — both " +
              "come from list_sessions items. Example: /Users/me/junrei",
          ),
      },
    },
    async ({ repo }) => {
      if (repo.trim() === "") return missingRepo();
      return jsonResult(await getRepoOverview(repo), BOTH_SOURCES);
    },
  );

  server.registerTool(
    "get_records",
    {
      description:
        "Full record text for specific 1-based source lines in one session's JSONL — the SAME " +
        "detail the record-detail slide-over (and the HTTP /record/:line route) shows, fetched " +
        "in bulk (up to 50 lines per call) instead of one line at a time. Line numbers are " +
        "1-based JSONL line numbers, the same provenance anchor every other tool's `line` / " +
        "`resultLine` / `startLine` fields point at — use them to quote exact evidence back to " +
        "the user. A requested line that doesn't resolve to an addressable record (out of " +
        "range, or a tool_result-only carrier line that isn't independently addressable — see " +
        "the owning tool-call's own `resultLine` instead) is listed in `missingLines`, never " +
        "silently dropped. Each record's text fields (user/assistant/thinking text, tool-call " +
        "input+result, subagent prompt+return, ...) are capped to `maxCharsPerRecord` (default " +
        "30000, min 200) — raise it to see more. For Claude Code sessions, a tool-call's " +
        "`resultText` / a subagent-launch's `returnedText` is recovered from the record's raw " +
        "source line whenever the SESSION's own parser had capped it below the tool's true " +
        "output, so you get the genuine full text there, not a stale capture cap. " +
        "`contentTruncated: true` plus `originalCharCount` mark a record whose content is still " +
        "short of the truth — either because `maxCharsPerRecord` cut it, or (rare) raw-line " +
        "recovery itself couldn't complete; a capped tool-call `input` is replaced by its " +
        "JSON-stringified, capped text (no longer the original structured value) — re-fetch with " +
        "a larger `maxCharsPerRecord` if you need the real object. Works for both Claude Code " +
        'sessions and Codex CLI sessions (source: "codex"). ' +
        "Every response includes sourceCompleteness — a machine-readable declaration of what " +
        "the underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        lines: z
          .array(z.number().int().min(1))
          .min(1)
          .max(GET_RECORDS_MAX_LINES)
          .describe(`1-based source line numbers to fetch (max ${GET_RECORDS_MAX_LINES} per call)`),
        maxCharsPerRecord: z
          .number()
          .int()
          .min(GET_RECORDS_MIN_MAX_CHARS)
          .optional()
          .describe(
            "Cap per text field, per record " +
              `(default ${GET_RECORDS_DEFAULT_MAX_CHARS}, min ${GET_RECORDS_MIN_MAX_CHARS})`,
          ),
      },
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      const maxChars = args.maxCharsPerRecord ?? GET_RECORDS_DEFAULT_MAX_CHARS;

      const records: Array<{
        line: number;
        detail: RecordDetail;
        contentTruncated: boolean;
        originalCharCount?: number;
      }> = [];
      const missingLines: number[] = [];
      for (const line of args.lines) {
        const detail =
          resolved.source === "codex"
            ? await getCodexSessionRecordDetail(args.sessionId, line)
            : await getSessionRecordDetail(args.sessionId, line);
        if (detail === undefined) {
          missingLines.push(line);
          continue;
        }
        const capped = truncateRecordDetail(detail, maxChars);
        records.push({
          line,
          detail: capped.detail,
          contentTruncated: capped.contentTruncated,
          ...(capped.originalCharCount !== undefined && {
            originalCharCount: capped.originalCharCount,
          }),
        });
      }

      return jsonResult(
        { sessionId: args.sessionId, source: resolved.source, records, missingLines },
        [sourceKindFor(resolved.source)],
      );
    },
  );

  server.registerTool(
    "get_tool_call",
    {
      description:
        "One tool call and everything associated with it, as a single evidence unit — the call " +
        "(tool name, full input, source line) and its result (full text, error status, source " +
        "line), resolved by `toolUseId` rather than by line number (a call and its result are " +
        "always different JSONL lines). Line numbers are 1-based source lines in the session " +
        "JSONL — provenance for quoting evidence. `toolUseId` comes from another tool's own " +
        '"toolUseId" field (get_records, get_context_timeline, find_repetitions, ' +
        "get_subagent_tree) and must belong to THIS session's own transcript (a subagent's tool " +
        "calls aren't reachable through this lookup). When the result can't be found (e.g. the " +
        "session was cut off mid-call), `result` is `null` and `resultMissing: true` makes that " +
        "explicit — absence is declared, never implied. `relatedRecords` carries records the " +
        "parser already links to this call (today: a background task's completion " +
        "notification); an empty array means no such linkage exists in the log, not that none " +
        "was checked — no linkage is ever invented beyond what the parser already establishes. " +
        "Truncation is always explicit: `call.inputTruncated` / `result.textTruncated` flag a " +
        "field actually cut to `maxCharsPerField` (default 30000, min 200) — raise it to see " +
        "more. For Claude Code sessions specifically, `result.text` is recovered from the " +
        "record's raw source line whenever the SESSION's own parser had capped the captured " +
        "tool-result text below the tool's true output, so you normally get the genuine full " +
        "text even when it exceeds the parser's own capture cap. `result.textTruncated: true` " +
        "with no cut visible in `text.length` vs. `maxCharsPerField` means that raw-line " +
        "recovery itself couldn't complete (rare — e.g. the source line became unreadable) and " +
        "`text` is still the parser's capped snapshot; `result.textFullCharCount` is the true " +
        "original count either way. Works for both Claude Code sessions and Codex CLI sessions " +
        '(source: "codex") — Codex\'s function_call/custom_tool_call/local_shell_call pairing ' +
        "resolves the same way; Codex records carry no `uuid` and no hook/attachment linkage, so " +
        "`call.uuid` stays unset and `relatedRecords` is always `[]` there. Every response " +
        "includes sourceCompleteness — a machine-readable declaration of what the underlying " +
        "session source cannot show; treat absent/not-recorded dimensions as unknowable from " +
        "this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        toolUseId: z
          .string()
          .min(1)
          .describe(
            'A toolUseId from another tool\'s own "toolUseId" field (get_records, ' +
              "get_context_timeline, find_repetitions, get_subagent_tree)",
          ),
        maxCharsPerField: z
          .number()
          .int()
          .min(GET_TOOL_CALL_MIN_MAX_CHARS)
          .optional()
          .describe(
            "Cap per text field " +
              `(default ${GET_TOOL_CALL_DEFAULT_MAX_CHARS}, min ${GET_TOOL_CALL_MIN_MAX_CHARS})`,
          ),
      },
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      const maxChars = args.maxCharsPerField ?? GET_TOOL_CALL_DEFAULT_MAX_CHARS;

      const detail: ToolCallDetail | undefined =
        resolved.source === "codex"
          ? await getCodexSessionToolCallDetail(args.sessionId, args.toolUseId)
          : await getSessionToolCallDetail(args.sessionId, args.toolUseId);
      if (detail === undefined) return toolCallNotFound(args.toolUseId);

      const cappedInput = capInputField(detail.call.input, maxChars);
      const cappedResult =
        detail.result === null
          ? undefined
          : capTextField(detail.result.text, maxChars, detail.result.fullTextLength);

      return jsonResult(
        {
          sessionId: args.sessionId,
          source: resolved.source,
          toolUseId: detail.toolUseId,
          call: {
            name: detail.call.name,
            input: cappedInput.input,
            inputTruncated: cappedInput.truncated,
            ...(cappedInput.fullCharCount !== undefined && {
              inputFullCharCount: cappedInput.fullCharCount,
            }),
            line: detail.call.line,
            ...(detail.call.timestamp !== undefined && { timestamp: detail.call.timestamp }),
            ...(detail.call.uuid !== undefined && { uuid: detail.call.uuid }),
          },
          result:
            detail.result === null || cappedResult === undefined
              ? null
              : {
                  isError: detail.result.isError,
                  text: cappedResult.text,
                  textTruncated: cappedResult.truncated,
                  ...(cappedResult.fullCharCount !== undefined && {
                    textFullCharCount: cappedResult.fullCharCount,
                  }),
                  line: detail.result.line,
                  ...(detail.result.timestamp !== undefined && {
                    timestamp: detail.result.timestamp,
                  }),
                },
          resultMissing: detail.resultMissing,
          relatedRecords: detail.relatedRecords,
        },
        [sourceKindFor(resolved.source)],
      );
    },
  );

  server.registerTool(
    "get_reconstructed_request",
    {
      description:
        "Reconstructs the actual Anthropic /v1/messages request payload — system blocks, " +
        "tools, generation params, and the wire-shaped messages array — that produced one " +
        "Claude Code main-loop turn (the 'virtual wire' layer; none of this is stored verbatim " +
        "in the session log). Every block/section carries an explicit CONFIDENCE CLASS: `exact` " +
        "— derived from the session log/attachments alone (replayed turns, byte-rebuilt " +
        "agent-listing/skill-listing injections); `template` — from a per-CLI-version captured " +
        "template plus log-recorded substitutions (the system prompt's instruction block, the " +
        "tools array, generation params) — this REQUIRES a user-local template captured under " +
        "~/.junrei/templates/<cliVersion>/template.json; with no template for this session's CLI " +
        "version the affected blocks are `unknown`, NEVER invented; `disk-contingent` — rebuilt " +
        "from CURRENT disk state (global/project CLAUDE.md, auto-memory, account email), which " +
        "may have drifted since the session actually ran — check such a block's `driftDetected` " +
        "flag (in `provenance`, backed by per-file mtimes in `provenance.files`) before treating " +
        "it as what the session really saw; `unknown` — not recoverable from any available " +
        "input (e.g. the per-launch billing-header system block, a missing template). Called " +
        "with neither `requestId` nor `line`, this returns the DISCOVERY listing instead of a " +
        "full reconstruction: every reconstructable request in the session as " +
        "`{requestId?, ordinal, targetLine}` — call again with one of those to fetch the actual " +
        "payload. Claude Code sessions only, LOCALLY-STORED sessions only (an S3-merged " +
        "session's disk context and templates live on another machine, so reconstruction is not " +
        "offered there — such a session resolves as not-found here), and MAIN-LOOP requests " +
        "only: subagent (sidechain) " +
        "requests are an explicitly declared limitation, never silently reconstructed — see the " +
        "top-level `limitations` array, which always includes that scope note plus any " +
        "per-request gaps (missing template, no disk-context provider, the ~494-byte fixed " +
        "safety preamble task-notification turns carry on the wire but not in the log, dropped " +
        "thinking blocks). Top-level `appliedRules` lists every deterministic normalization rule " +
        "id that shaped this reconstruction (e.g. cache_control stripping, string/array " +
        "content-form normalization) — these are baked into `exact` confidence, not a separate " +
        "class. Every system block's `text` and every message-block/tools/params section's " +
        "`value` is capped to `maxCharsPerBlock` (default 20000, min 200) with an EXPLICIT " +
        "`textTruncated`/`valueTruncated` flag plus the untruncated char count " +
        "(`textFullCharCount`/`valueFullCharCount`) whenever cut — raise it to see more; never " +
        "silently truncated. Every response includes sourceCompleteness — a machine-readable " +
        "declaration of what the underlying session source cannot show; treat absent/not-recorded " +
        "dimensions as unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        requestId: z
          .string()
          .optional()
          .describe(
            "The log's own requestId for the target request (from this tool's own discovery " +
              "listing, or another tool's `requestId` field). Takes precedence over `line` when " +
              "both are given.",
          ),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based source line of the target assistant record (this tool's own discovery " +
              "listing's `targetLine`, or another tool's `line`/`targetLine` field) — an " +
              "alternative to `requestId` when the log carries none.",
          ),
        maxCharsPerBlock: z
          .number()
          .int()
          .min(GET_RECONSTRUCTED_REQUEST_MIN_MAX_CHARS)
          .optional()
          .describe(
            "Cap per text/value field, per block " +
              `(default ${GET_RECONSTRUCTED_REQUEST_DEFAULT_MAX_CHARS}, ` +
              `min ${GET_RECONSTRUCTED_REQUEST_MIN_MAX_CHARS})`,
          ),
      },
    },
    async (args) => {
      if (args.source === "codex") return notAvailableForReconstruction();
      const ref = await localClaudeSessionStore.findSessionFileById(args.sessionId);
      if (ref === undefined) return notFound(args.sessionId);
      const input = await loadReconstructionInput(
        args.sessionId,
        ref.filePath,
        localClaudeSessionStore,
      );

      if (args.requestId === undefined && args.line === undefined) {
        return jsonResult(
          {
            sessionId: args.sessionId,
            source: "claude-code" as const,
            requests: listReconstructableRequests(input.records),
          },
          ["claude-session-jsonl"],
        );
      }

      const target: string | number = args.requestId ?? (args.line as number);
      const maxChars = args.maxCharsPerBlock ?? GET_RECONSTRUCTED_REQUEST_DEFAULT_MAX_CHARS;
      const providers: ReconstructionProviders = {
        template: createFilesystemTemplateProvider(),
        diskContext: createFilesystemDiskContextProvider({ projectDirName: ref.projectDirName }),
      };
      const reconstructed = await reconstructRequest(input, target, providers);
      if (reconstructed === undefined) {
        return reconstructionRequestNotFound(args.sessionId, target);
      }

      return jsonResult(
        {
          sessionId: args.sessionId,
          source: "claude-code" as const,
          ...cappedReconstructedRequest(reconstructed, maxChars),
        },
        ["claude-session-jsonl"],
      );
    },
  );

  return server;
}
