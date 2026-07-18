import {
  type BashOpportunity,
  type BashStats,
  buildSourceCompleteness,
  type ClaudeSessionAnalysis,
  type CodexToolCallRecord,
  computeBashStats,
  computeTrends,
  durationBetween,
  type EvaluationTraceEvent,
  listReconstructableRequests,
  listSubagentRefs,
  loadReconstructionInput,
  loadSubagentSessionData,
  localClaudeSessionStore,
  parseOtelSessionLines,
  parseShellCommand,
  primaryCommand,
  type ReconstructedMessageBlock,
  type ReconstructedParams,
  type ReconstructedRequest,
  type ReconstructedSection,
  type ReconstructedSystemBlock,
  type ReconstructionProviders,
  type RecordDetail,
  reconstructRequest,
  type SessionData,
  type SourceKind,
  summarizeToolInput,
  type ToolCall,
  type ToolCallDetail,
} from "@junrei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveBashPercentile } from "./bash-percentile.js";
import { assembleEvaluationTrace } from "./evaluation-trace.js";
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
  collectCodexToolCallThreads,
  getCodexSession,
  getCodexSessionBashStatsMainOnly,
  getCodexSessionRecordDetail,
  getCodexSessionToolCallDetail,
  getSession,
  getSessionData,
  getSessionRecordDetail,
  getSessionToolCallDetail,
  listAllSessionsInBounds,
  listSessions,
  MAX_LIST_LIMIT,
} from "./sessions.js";
import {
  capturedByteSizes,
  createFilesystemCaptureStore,
  extractResponseMeta,
  findCapturedRequest,
} from "./sources/captures.js";
import { claudeStoreForFilePath } from "./sources/claude.js";
import { readOtelLines, resolveOtelDir } from "./sources/otel.js";
import {
  createFilesystemDiskContextProvider,
  createFilesystemTemplateProvider,
} from "./sources/reconstruction.js";
import {
  DEFAULT_TRENDS_DAYS,
  DEFAULT_TRENDS_TIMEZONE,
  isValidTimeZone,
  parseTrendsDays,
  TRENDS_DAY_MS,
} from "./trends-params.js";

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
 * `get_trends`'s `timeZone` failed `isValidTimeZone` — mirrors `GET
 * /api/trends`'s 400 (`app.ts`) for the same condition: there's no sane
 * default to fall back to for "the caller asked for a time zone that
 * doesn't exist", unlike `days` (see `parseTrendsDays`), which silently
 * coerces out-of-whitelist values instead of erroring.
 */
function invalidTimeZone(tz: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `timeZone is not a valid IANA time zone: "${tz}". Examples: "UTC" (default), ` +
          '"America/New_York", "Asia/Tokyo".',
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

/**
 * `get_session_observability` is Claude-Code-only: OTel is Claude Code's own
 * sanctioned telemetry channel (`OTEL_LOGS_EXPORTER`/`OTEL_METRICS_EXPORTER`)
 * — Codex CLI has no equivalent export junrei's receiver understands.
 */
function notAvailableForObservability() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "not available for Codex sessions (source: codex) — OTel observability is a " +
          "Claude-Code-specific capability (Claude Code's own OTEL_LOGS_EXPORTER/" +
          "OTEL_METRICS_EXPORTER telemetry, ingested by junrei's OTLP receiver); Codex CLI has " +
          "no equivalent export in Junrei today.",
      },
    ],
    isError: true,
  };
}

/**
 * The wire-capture tools (`get_actual_request`/`get_hidden_calls`) draw on the
 * session log AND its opt-in wire capture, so they declare both — the log for
 * the `requestId` join, the capture for the actual bytes/latency.
 */
const CAPTURE_KINDS: SourceKind[] = ["claude-session-jsonl", "claude-wire-capture"];

/**
 * `get_actual_request`/`get_hidden_calls` are Claude-Code-only: the wire
 * capture proxy captures Anthropic API traffic keyed by
 * `x-claude-code-session-id` — a Claude Code concept with no Codex analog.
 * Distinct from "captures unavailable" (a DECLARED non-error, `captureAvailable:
 * false`): a Codex session can NEVER have Claude wire captures, so it's a clear
 * up-front rejection like `notAvailableForReconstruction`.
 */
function notAvailableForCaptures() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "not available for Codex sessions (source: codex) — wire capture is a " +
          "Claude-Code-specific capability (the local pass-through proxy captures Anthropic API " +
          "traffic keyed by x-claude-code-session-id); Codex CLI has no equivalent in Junrei today.",
      },
    ],
    isError: true,
  };
}

/**
 * `export_evaluation_trace` is Claude-Code-only: it merges the reconstruction
 * layer, OTel, and wire capture — all three Claude-Code-specific — into one
 * document. No HTTP route exists for Codex either (see app.ts).
 */
function notAvailableForEvaluationTrace() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "not available for Codex sessions (source: codex) — the evaluation trace merges " +
          "Claude-Code-specific capabilities (request reconstruction, OTel, wire capture); Codex " +
          "CLI has no equivalent in Junrei today.",
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
 * `toolUseId`. `agentId`, when the caller supplied one (already confirmed to
 * exist by `claudeSubagentExists`), narrows the message to that subagent's
 * OWN transcript — the default (no `agentId`) still means the main
 * transcript, and a subagent's calls ARE reachable here via the `agentId`
 * input, so this no longer disclaims them.
 */
function toolCallNotFound(toolUseId: string, agentId?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          agentId === undefined
            ? `toolUseId not found in this session: ${toolUseId}. toolUseId comes from another ` +
              'tool\'s own "toolUseId" field (get_records, get_context_timeline, find_repetitions, ' +
              "get_subagent_tree) and must belong to THIS session's own (main) transcript, or to " +
              "a subagent's transcript — pass that subagent's agentId to scope the lookup there."
            : `toolUseId not found in subagent ${agentId}'s transcript: ${toolUseId}. toolUseId ` +
              'comes from another tool\'s own "toolUseId" field (get_records, get_context_timeline, ' +
              "find_repetitions, get_subagent_tree) and must belong to that SAME thread's " +
              "transcript — omit agentId to look in the main transcript instead.",
      },
    ],
    isError: true,
  };
}

/**
 * Does `agentId` name a real subagent of this Claude Code session? Exists so
 * "unknown agentId" and "line/toolUseId not present in that (real) subagent's
 * transcript" surface as distinct errors — both `getSessionRecordDetail` and
 * `getSessionToolCallDetail` return `undefined` for either case (see their
 * doc comments in `sources/claude.ts`), so the MCP layer has to check
 * existence separately before it can tell the two apart. Same subagent
 * discovery `collectToolCallThreads`/`get_subagent_tree` use — session's main
 * `SessionData` (for its `filePath`) → the store that owns that file (local
 * or S3) → that file's sidecar refs.
 */
async function claudeSubagentExists(sessionId: string, agentId: string): Promise<boolean> {
  const mainData = await getSessionData(sessionId);
  if (mainData === undefined || mainData.filePath === undefined) return false;
  const store = claudeStoreForFilePath(mainData.filePath);
  const refs = await listSubagentRefs(mainData.filePath, store);
  return refs.some((ref) => ref.agentId === agentId);
}

/** `agentId` that doesn't name any subagent of the given session. */
function subagentNotFound(agentId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Subagent not found in this session: ${agentId}. agentId comes from get_subagent_tree, ` +
          'or the "thread" field of get_tool_calls/get_bash_stats.',
      },
    ],
    isError: true,
  };
}

/**
 * `agentId` supplied for a Codex session — Codex has no in-transcript
 * subagent scoping because a Codex sub-agent is its own full session (own
 * sessionId), unlike a Claude Code subagent (a sidecar transcript inside the
 * SAME session file). See `get_subagent_tree`'s Codex behavior for the same
 * distinction.
 */
function codexAgentIdUnsupported() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "agentId is not supported for Codex sessions: a Codex sub-agent is its own full " +
          "session — call this tool with the sub-agent's own sessionId (see get_subagent_tree).",
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

const GET_ACTUAL_REQUEST_DEFAULT_MAX_CHARS = 30000;
const GET_ACTUAL_REQUEST_MIN_MAX_CHARS = 200;

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

/**
 * `params` — per-key output shaping: each entry's `value` is capped with the
 * SAME explicit `valueTruncated`/`valueFullCharCount` contract every other
 * section uses, while its own `confidence`/`provenance`/`note` carry through
 * uncapped. The section-level `confidence`/`provenance`/`note` (present only in
 * the "no template params" case) pass through too.
 */
function cappedParams(params: ReconstructedParams, maxChars: number) {
  const entries: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(params.entries)) {
    const capped = entry.value !== undefined ? capInputField(entry.value, maxChars) : undefined;
    entries[key] = {
      ...(capped !== undefined && { value: capped.input }),
      valueTruncated: capped?.truncated ?? false,
      ...(capped?.fullCharCount !== undefined && { valueFullCharCount: capped.fullCharCount }),
      confidence: entry.confidence,
      provenance: entry.provenance,
      ...(entry.note !== undefined && { note: entry.note }),
    };
  }
  return {
    entries,
    ...(params.confidence !== undefined && { confidence: params.confidence }),
    ...(params.provenance !== undefined && { provenance: params.provenance }),
    ...(params.note !== undefined && { note: params.note }),
  };
}

function cappedReconstructedRequest(request: ReconstructedRequest, maxChars: number) {
  return {
    ...(request.requestId !== undefined && { requestId: request.requestId }),
    ordinal: request.ordinal,
    targetLine: request.targetLine,
    system: request.system.map((block) => cappedSystemBlock(block, maxChars)),
    tools: cappedSection(request.tools, maxChars),
    params: cappedParams(request.params, maxChars),
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

// ---------------------------------------------------------------------------
// get_session_observability — output shaping. `costBasis` distinguishes the
// TWO cost figures this tool can return: `"otel"` (Claude Code's own
// billing-computed `cost_usd`, `@junrei/core`'s `parseOtelSessionLines`
// aggregate) vs. `"pricing-table-estimate"` (the SAME estimate every other
// cost-bearing tool reports, `getSession(...).totalUsage`) — never conflated,
// always both present when OTel data exists, so a caller can see the delta.
// ---------------------------------------------------------------------------

const GET_SESSION_OBSERVABILITY_DEFAULT_MAX_TOOL_DECISIONS = 200;
const GET_SESSION_OBSERVABILITY_MAX_MAX_TOOL_DECISIONS = 2000;
const GET_SESSION_OBSERVABILITY_MAX_HEALTH_EVENTS = 200;

const JUNREI_OTEL_DIR_SETUP_NOTE =
  "set JUNREI_OTEL_DIR (an absolute directory path) on the junrei server, and configure Claude " +
  "Code with OTEL_LOGS_EXPORTER=otlp / OTEL_METRICS_EXPORTER=otlp / " +
  "OTEL_EXPORTER_OTLP_PROTOCOL=http/json pointed at this server's /otlp/v1/logs and " +
  "/otlp/v1/metrics endpoints.";

/** `sessionLog` cost figure — always available (no OTel dependency), computed once and reused by every branch below. */
function sessionLogCostOf(analysis: ClaudeSessionAnalysis) {
  return {
    costUsd: analysis.totalUsage.costUsd,
    costBasis: "pricing-table-estimate" as const,
    costIsComplete: analysis.totalUsage.costIsComplete,
  };
}

/** The "OTel unavailable" response shape — NEVER a silent empty: `otelAvailable: false` plus a note naming JUNREI_OTEL_DIR, per Decision 7. */
function observabilityUnavailable(
  sessionId: string,
  analysis: ClaudeSessionAnalysis,
  reason: "disabled" | "no-data",
) {
  return jsonResult(
    {
      sessionId,
      source: "claude-code" as const,
      otelAvailable: false,
      note:
        reason === "disabled"
          ? `OTel ingestion is disabled — ${JUNREI_OTEL_DIR_SETUP_NOTE}`
          : "OTel ingestion is enabled (JUNREI_OTEL_DIR is set) but no OTel data has been " +
            "recorded for this session — it likely ran before OTel was configured, or Claude " +
            `Code's own OTEL_* env vars weren't set for it. Setup: ${JUNREI_OTEL_DIR_SETUP_NOTE}`,
      cost: { sessionLog: sessionLogCostOf(analysis) },
    },
    ["claude-session-jsonl", "claude-otel"],
  );
}

// ---------------------------------------------------------------------------
// export_evaluation_trace — output shaping. `assembleEvaluationTrace`
// (evaluation-trace.ts) does every fs/store read and hands back the FULL,
// uncapped `EvaluationTrace` (the SAME object the HTTP route returns
// verbatim); this tool caps it for a chat context: `maxEvents` truncates the
// (already source-line/timestamp-ordered) event list with an explicit
// `eventsTruncated` flag + exact `totalEvents`, and `maxCharsPerField` caps
// each event's own known text-bearing attributes with the SAME
// `capTextField`/`capInputField` explicit-truncation contract every other
// drill-down tool uses (a `<field>Truncated` flag plus `<field>FullCharCount`
// sibling key, never a silently shorter value).
// ---------------------------------------------------------------------------

const EXPORT_EVALUATION_TRACE_DEFAULT_MAX_EVENTS = 500;
const EXPORT_EVALUATION_TRACE_MAX_MAX_EVENTS = 5000;
const EXPORT_EVALUATION_TRACE_DEFAULT_MAX_CHARS = 4000;
const EXPORT_EVALUATION_TRACE_MIN_MAX_CHARS = 200;

/** Which of one event kind's `attributes` keys carry free-text worth capping as a STRING — see `EVALUATION_TRACE_INPUT_FIELDS` for the arbitrary-JSON counterpart (`gen_ai.tool.call`'s `input`). */
const EVALUATION_TRACE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "gen_ai.user.message": ["text"],
  "gen_ai.assistant.message": ["text"],
  "gen_ai.tool.result": ["text"],
  "junrei.injected_context": ["text"],
  "junrei.subagent_launch": ["prompt", "returnedText"],
};

/** Attribute keys capped via `capInputField` (arbitrary JSON, stringified only when a cut is actually needed) rather than `capTextField`. */
const EVALUATION_TRACE_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "gen_ai.tool.call": ["input"],
};

/**
 * Cap one event's known text/input attributes to `maxChars`, in place on a
 * COPY of `attributes` — every other attribute (ids, model, usage, cost,
 * confidence counts, ...) is small/structured and passes through unchanged.
 * An event kind with no entry in either table above (e.g. `gen_ai.request`,
 * `junrei.compaction`) is returned unmodified — its attributes are already
 * small, structured values, nothing to cut.
 */
function cappedEvaluationTraceEvent(
  event: EvaluationTraceEvent,
  maxChars: number,
): EvaluationTraceEvent {
  const attributes: Record<string, unknown> = { ...event.attributes };
  for (const field of EVALUATION_TRACE_TEXT_FIELDS[event.name] ?? []) {
    const value = attributes[field];
    if (typeof value !== "string") continue;
    const capped = capTextField(value, maxChars);
    attributes[field] = capped.text;
    attributes[`${field}Truncated`] = capped.truncated;
    if (capped.fullCharCount !== undefined)
      attributes[`${field}FullCharCount`] = capped.fullCharCount;
  }
  for (const field of EVALUATION_TRACE_INPUT_FIELDS[event.name] ?? []) {
    if (!(field in attributes)) continue;
    const capped = capInputField(attributes[field], maxChars);
    attributes[field] = capped.input;
    attributes[`${field}Truncated`] = capped.truncated;
    if (capped.fullCharCount !== undefined)
      attributes[`${field}FullCharCount`] = capped.fullCharCount;
  }
  return { ...event, attributes };
}

// ---------------------------------------------------------------------------
// get_bash_stats / get_tool_calls — Bash-command analytics and a generic
// paginated tool-call listing, for both Claude Code and Codex sessions (Bash
// analysis PR 1 shipped Claude-only; PR 4 added the Codex adapter —
// `@junrei/core`'s `codex/bash-stats.ts`/`codex/tool-calls.ts`). Built on
// `@junrei/core`'s `computeBashStats`/`parseShellCommand`/`primaryCommand`
// (Claude) and `getCodexSession`'s forest-joint `bashStats` override /
// `collectCodexToolCallThreads` (Codex, `sources/codex.ts`); this file only
// shapes their output for MCP + adds the `get_tool_calls` discovery
// primitive that neither `get_records` (line-scoped) nor `get_tool_call`
// (needs an already-known toolUseId) provide.
// ---------------------------------------------------------------------------

const BASH_STATS_DEFAULT_TOP_COMMANDS = 20;
const BASH_STATS_MAX_TOP_COMMANDS = 100;
/** Fixed (not caller-configurable) — `programFrequency` has no dedicated cap param, unlike `byCommand`'s `topCommands`. */
const BASH_STATS_PROGRAM_FREQUENCY_LIMIT = 30;
const BASH_STATS_DEFAULT_TOP_WASTE = 20;
const BASH_STATS_MAX_TOP_WASTE = 100;
/** Cap for `background.tasks` — the four waste lists (nearDuplicates/largeResults/rerunAfterError/bashAsRead) have their own caller-configurable cap, `topWaste`, and `byCommand`/`programFrequency` have their own caps above. */
const BASH_STATS_LIST_CAP = 20;
/** Fixed (not caller-configurable) — `byThread` is inherently small (one row per thread-model), so this is defensive headroom, not a real-world cap. */
const BASH_STATS_BY_THREAD_CAP = 50;
const BASH_STATS_DEFAULT_TOP_OPPORTUNITIES = 10;
const BASH_STATS_MAX_TOP_OPPORTUNITIES = 50;
/** Defensive cap for an opportunity's own templated text fields (`title`/`fixText`/`heuristicNote`) — same explicit-truncation contract `capTextField` uses everywhere else in this file, sized generously since every real value here is a short, templated string (a command capped to ~200 chars, wrapped in a sentence or two). */
const BASH_OPPORTUNITY_TEXT_MAX_CHARS = 2000;

const GET_TOOL_CALLS_DEFAULT_LIMIT = 50;
const GET_TOOL_CALLS_MAX_LIMIT = 200;

/**
 * A list capped for the MCP response, alongside the exact pre-cap count and
 * an explicit `truncated` flag — the same "capped list must never read as
 * complete" contract `search_sessions`' `matchesTruncated`/`resultsTruncated`
 * already uses, generalized to every list `get_bash_stats` returns.
 */
interface CappedList<T> {
  items: T[];
  totalCount: number;
  truncated: boolean;
}

function capList<T>(items: readonly T[], cap: number): CappedList<T> {
  return { items: items.slice(0, cap), totalCount: items.length, truncated: items.length > cap };
}

/**
 * One `BashOpportunity` (see `@junrei/core`'s `bash-opportunities.ts`),
 * shaped for the MCP response: every field passes through UNCHANGED
 * (`fixText` included — this is the point, an agent acts on it directly)
 * except the three templated text fields (`title`/`fixText`/`heuristicNote`),
 * which get the SAME explicit `capTextField` truncation contract every other
 * text field in this file uses (a `<field>Truncated` flag, plus
 * `<field>FullCharCount` only when a cut actually happened) — defensive, not
 * expected to ever fire in practice (see `BASH_OPPORTUNITY_TEXT_MAX_CHARS`).
 * `evidence` is NOT re-capped here — `@junrei/core`'s own `EVIDENCE_LIMIT`
 * (10) already bounds it at the source.
 */
function toOpportunityItem(opportunity: BashOpportunity) {
  const title = capTextField(opportunity.title, BASH_OPPORTUNITY_TEXT_MAX_CHARS);
  const fixText = capTextField(opportunity.fixText, BASH_OPPORTUNITY_TEXT_MAX_CHARS);
  const heuristicNote =
    opportunity.heuristicNote !== undefined
      ? capTextField(opportunity.heuristicNote, BASH_OPPORTUNITY_TEXT_MAX_CHARS)
      : undefined;
  return {
    ...opportunity,
    title: title.text,
    titleTruncated: title.truncated,
    ...(title.fullCharCount !== undefined && { titleFullCharCount: title.fullCharCount }),
    fixText: fixText.text,
    fixTextTruncated: fixText.truncated,
    ...(fixText.fullCharCount !== undefined && { fixTextFullCharCount: fixText.fullCharCount }),
    ...(heuristicNote !== undefined && {
      heuristicNote: heuristicNote.text,
      heuristicNoteTruncated: heuristicNote.truncated,
      ...(heuristicNote.fullCharCount !== undefined && {
        heuristicNoteFullCharCount: heuristicNote.fullCharCount,
      }),
    }),
  };
}

/**
 * Shape one `BashStats` (either the joint main+subagents value already on
 * `ClaudeSessionAnalysis`, or a main-thread-only recompute) into the MCP
 * response body — every list capped per `CappedList`'s contract; `totals`
 * (already carrying `estUsd` — see `BashTotals.estUsd`) and `heavyHitters`
 * pass through unchanged (`heavyHitters` is already a fixed top-10 from
 * `computeBashStats` itself, nothing left to cap here). `byThread` (new in
 * v2 PR D) is small by construction — one row per thread that has any Bash
 * calls — so `BASH_STATS_BY_THREAD_CAP` is defensive headroom, not a
 * real-world limit. `opportunities` (new in v2 PR D) is the ranked,
 * templated fix-suggestion list `@junrei/core`'s `computeBashOpportunities`
 * already sorts best-first — capped to `topOpportunities` and shaped via
 * `toOpportunityItem`. `topWaste` caps the four waste lists only —
 * `background.tasks` always uses the fixed `BASH_STATS_LIST_CAP`.
 */
function toBashStatsResponse(
  stats: BashStats,
  topCommands: number,
  topOpportunities: number,
  topWaste: number,
) {
  const byStatus = { completed: 0, failed: 0, unresolved: 0 };
  for (const task of stats.background) byStatus[task.status] += 1;
  const cappedOpportunities = capList(stats.opportunities, topOpportunities);
  return {
    totals: stats.totals,
    byCommand: capList(stats.byCommand, topCommands),
    byThread: capList(stats.byThread, BASH_STATS_BY_THREAD_CAP),
    programFrequency: capList(stats.programFrequency, BASH_STATS_PROGRAM_FREQUENCY_LIMIT),
    heavyHitters: stats.heavyHitters,
    background: { byStatus, tasks: capList(stats.background, BASH_STATS_LIST_CAP) },
    waste: {
      nearDuplicates: capList(stats.waste.nearDuplicates, topWaste),
      largeResults: capList(stats.waste.largeResults, topWaste),
      rerunAfterError: capList(stats.waste.rerunAfterError, topWaste),
      bashAsRead: capList(stats.waste.bashAsRead, topWaste),
    },
    opportunities: {
      items: cappedOpportunities.items.map(toOpportunityItem),
      totalCount: cappedOpportunities.totalCount,
      truncated: cappedOpportunities.truncated,
    },
  };
}

/** One `get_tool_calls` result row. `family`/`subcommand` are set only for `toolName === "Bash"` — see `toToolCallItem`. */
interface ToolCallListItem {
  toolUseId: string;
  line: number;
  timestamp?: string;
  toolName: string;
  /** `"main"` or a subagent's `agentId` — same convention `BashStats`' per-entry `thread` field uses. */
  thread: string;
  status: "ok" | "error" | "missing-result";
  inputChars: number;
  resultChars: number;
  durationMs?: number;
  inputSummary: string;
  family?: string;
  subcommand?: string;
}

/** Same "no identifiable executable" label `computeBashStats` uses (`UNPARSED_FAMILY`, private there) — kept in sync by convention, not import, since it's a trivial literal. */
const UNPARSED_BASH_FAMILY = "(unparsed)";

/** A Bash call's `command` input field, mirroring `bash-stats.ts`'s own (private) `commandOf`. */
function bashCommandOf(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function inputCharsOf(input: unknown): number {
  return typeof input === "string" ? input.length : JSON.stringify(input ?? null).length;
}

function toToolCallStatus(call: ToolCall): "ok" | "error" | "missing-result" {
  if (call.result === undefined) return "missing-result";
  return call.result.isError ? "error" : "ok";
}

function toToolCallItem(thread: string, call: ToolCall): ToolCallListItem {
  const durationMs = durationBetween(call.timestamp, call.result?.timestamp);
  const item: ToolCallListItem = {
    toolUseId: call.toolUseId,
    line: call.line,
    ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
    toolName: call.name,
    thread,
    status: toToolCallStatus(call),
    inputChars: inputCharsOf(call.input),
    resultChars: call.result?.fullTextLength ?? 0,
    ...(durationMs !== undefined && { durationMs }),
    inputSummary: summarizeToolInput(call.input),
  };
  if (call.name !== "Bash") return item;
  const primary = primaryCommand(parseShellCommand(bashCommandOf(call.input)));
  return {
    ...item,
    family: primary?.executable ?? UNPARSED_BASH_FAMILY,
    ...(primary?.subcommand !== undefined && { subcommand: primary.subcommand }),
  };
}

/**
 * Codex analog of `toToolCallItem` — `CodexToolCallRecord` (`@junrei/core`'s
 * `codex/tool-calls.ts`) already carries everything generically (status,
 * inputChars/resultChars, inputSummary) via the SAME linkage the Timeline
 * lens uses; `family`/`subcommand` are set only when `shellCommand` resolved
 * (a genuine shell execution), same "Bash calls only" gate `toToolCallItem`
 * applies for Claude.
 */
function toCodexToolCallItem(thread: string, record: CodexToolCallRecord): ToolCallListItem {
  const item: ToolCallListItem = {
    toolUseId: record.callId,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    toolName: record.toolName,
    thread,
    status: record.status,
    inputChars: record.inputChars,
    resultChars: record.resultChars,
    ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
    inputSummary: record.inputSummary,
  };
  if (record.shellCommand === undefined) return item;
  const primary = primaryCommand(parseShellCommand(record.shellCommand));
  return {
    ...item,
    family: primary?.executable ?? UNPARSED_BASH_FAMILY,
    ...(primary?.subcommand !== undefined && { subcommand: primary.subcommand }),
  };
}

/**
 * Every thread's `SessionData` `get_tool_calls` needs, per its `thread`
 * filter — main only, subagents only, or both. Reuses the SAME subagent
 * discovery/loading `analyze.ts`'s `computeBashStats` input and `get_tool_call`
 * rely on (`listSubagentRefs`/`loadSubagentSessionData`), resolved through
 * whichever store actually owns this session's file (`claudeStoreForFilePath`
 * — local or S3), never a new loader. `undefined` only when the session
 * itself can't be found.
 */
async function collectToolCallThreads(
  sessionId: string,
  thread: "main" | "subagents" | "all",
): Promise<{ thread: string; data: SessionData }[] | undefined> {
  const mainData = await getSessionData(sessionId);
  if (mainData === undefined) return undefined;

  const threads: { thread: string; data: SessionData }[] = [];
  if (thread !== "subagents") threads.push({ thread: "main", data: mainData });

  if (thread !== "main" && mainData.filePath !== undefined) {
    const store = claudeStoreForFilePath(mainData.filePath);
    const refs = await listSubagentRefs(mainData.filePath, store);
    for (const ref of refs) {
      const subData = await loadSubagentSessionData(mainData.filePath, ref.agentId, store);
      if (subData !== undefined) threads.push({ thread: ref.agentId, data: subData });
    }
  }
  return threads;
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
        "get_repo_overview), a per-model `usageByModel` breakdown, a `delegation` " +
        "main-vs-subagents split, and a `bashSummary` (Bash calls/resultChars/estimatedTokens, " +
        "plus estUsd and topFamily where knowable — see get_bash_stats for the full per-session " +
        "breakdown; get_repo_overview's `bash` field for the repo-wide baseline to compare it " +
        "against), so a repo- or model-level rollup can be built without fetching every " +
        "session's full summary. Every response includes sourceCompleteness — " +
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
        "subagents delegation split, the top 5 sessions by cost, and a repo-wide Bash rollup " +
        "(`bash.calls`/`resultChars`/`estUsd`) with `bash.distribution` — every matched " +
        "session's own `resultChars`/`estUsd`, ascending — for ranking one session's own " +
        "list_sessions `bashSummary` against the repo baseline (e.g. via a percentile-rank " +
        "computation over `distribution.resultChars`: what fraction of this repo's sessions " +
        "had less Bash output than this one). `repo` accepts either a " +
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
    "get_trends",
    {
      description:
        "Multi-day trend report across every session (both harnesses), globally or scoped to " +
        "one repo: cost/tokens bucketed by LOCAL calendar day (zero-filled) over `days` days " +
        "ending today, each day's per-model breakdown and main-vs-subagents delegation cost " +
        "split, cache hit rate, merged subagent-return-size stats (count/total/max chars — " +
        'check the mean, totalChars/count, against the ~1-2k token "typical worker summary" ' +
        "benchmark), and Bash rollup fields (`bashCalls`/`bashResultChars`/`bashEstUsd`); a " +
        "current-vs-previous-window summary with null-safe deltas (cost %, session-count %, " +
        "cache-hit-rate points, subagent-cost-share points, `bashResultCharsPct`, " +
        "`bashEstUsdPct`); simple spike-day " +
        "detection (days whose cost is a population-stddev outlier); and the top 5 sessions by " +
        "cost in the current window. Use this — not get_repo_overview's all-time single-repo " +
        "rollup — for cross-session, multi-day questions: is cost/token usage by model trending " +
        "up, is delegation share or cache hit rate drifting, are subagent returns creeping past " +
        "the efficiency benchmark, which day spiked and what session drove it. `days` accepts " +
        `7, 14, or 30 (default ${DEFAULT_TRENDS_DAYS}) — any other value falls back to the ` +
        "default, same whitelist GET /api/trends uses (never an error). `timeZone` is an IANA " +
        `name (default "${DEFAULT_TRENDS_TIMEZONE}") controlling which local calendar day each ` +
        "session's cost lands in — an invalid one IS rejected outright, since there's no sane " +
        "default for a time zone that doesn't exist. `repo` takes the same repoRoot path or " +
        "fallback bucket key (claude-project:<dir> / codex-repo:<repoUrl> / codex-cwd:<cwd>) " +
        "get_repo_overview accepts; omit it for a global report across every repo. Every " +
        "response includes sourceCompleteness — a machine-readable declaration of what the " +
        "underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: {
        days: z
          .number()
          .int()
          .optional()
          .describe(
            `Calendar-day buckets in the current window: 7, 14, or 30 (default ${DEFAULT_TRENDS_DAYS}) ` +
              "— any other value falls back to the default, same whitelist as GET /api/trends",
          ),
        timeZone: z
          .string()
          .optional()
          .describe(
            `IANA time zone name for local-day bucketing (default "${DEFAULT_TRENDS_TIMEZONE}"), ` +
              'e.g. "Asia/Tokyo" — an invalid name is rejected, not defaulted',
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Restrict to one repo: a repoRoot path or fallback bucket key " +
              "(claude-project:<dir> / codex-repo:<repoUrl> / codex-cwd:<cwd>) — same " +
              "semantics as get_repo_overview. Omit for a global report across every repo.",
          ),
      },
    },
    async ({ days, timeZone, repo }) => {
      const resolvedDays = parseTrendsDays(days === undefined ? undefined : String(days));
      const resolvedTimeZone = timeZone ?? DEFAULT_TRENDS_TIMEZONE;
      if (!isValidTimeZone(resolvedTimeZone)) return invalidTimeZone(resolvedTimeZone);
      const resolvedRepo = repo === undefined || repo === "" ? undefined : repo;

      const nowMs = Date.now();
      const untilMs = nowMs;
      const sinceMs = nowMs - (2 * resolvedDays + 2) * TRENDS_DAY_MS;

      const items = await listAllSessionsInBounds({ sinceMs, untilMs });
      return jsonResult(
        computeTrends(items, {
          nowMs,
          days: resolvedDays,
          timeZone: resolvedTimeZone,
          ...(resolvedRepo !== undefined && { repo: resolvedRepo }),
        }),
        BOTH_SOURCES,
      );
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
        "Default scope is THIS session's main transcript; for a Claude Code session, the " +
        "optional `agentId` scopes the lookup to that subagent's own sidecar transcript instead " +
        "— `lines`/`missingLines` are then 1-based lines in THAT subagent's own JSONL (the same " +
        "thread-local line numbers get_tool_calls/get_bash_stats report), not the main " +
        "transcript's. agentId is Claude Code only — a Codex sub-agent is its own full session, " +
        "so pass that sub-agent's own sessionId instead of an agentId. " +
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
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Claude Code sessions only: resolve inside this subagent's own transcript instead of " +
              "the main transcript. agentId comes from get_subagent_tree or the `thread` field of " +
              "get_tool_calls/get_bash_stats. A Codex sub-agent is its own full session — call this " +
              "tool with that session's own sessionId instead.",
          ),
      },
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      if (args.agentId !== undefined) {
        if (resolved.source === "codex") return codexAgentIdUnsupported();
        if (!(await claudeSubagentExists(args.sessionId, args.agentId))) {
          return subagentNotFound(args.agentId);
        }
      }
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
            : await getSessionRecordDetail(args.sessionId, line, args.agentId);
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
        {
          sessionId: args.sessionId,
          source: resolved.source,
          ...(args.agentId !== undefined && { agentId: args.agentId }),
          records,
          missingLines,
        },
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
        "get_subagent_tree). Default scope is THIS session's main transcript; for a Claude Code " +
        "session, the optional `agentId` scopes the lookup to that subagent's own sidecar " +
        "transcript instead, where `call.line`/`result.line` are 1-based lines in THAT " +
        "subagent's own JSONL (the same thread-local line numbers get_tool_calls reports) — raw-" +
        "line full-text recovery (below) applies there too, re-reading the subagent's own " +
        "sidecar. agentId is Claude Code only — a Codex sub-agent is its own full session, so " +
        "pass that sub-agent's own sessionId instead of an agentId. " +
        "When the result can't be found (e.g. the " +
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
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Claude Code sessions only: resolve inside this subagent's own transcript instead of " +
              "the main transcript. agentId comes from get_subagent_tree or the `thread` field of " +
              "get_tool_calls/get_bash_stats. A Codex sub-agent is its own full session — call this " +
              "tool with that session's own sessionId instead.",
          ),
      },
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      if (args.agentId !== undefined) {
        if (resolved.source === "codex") return codexAgentIdUnsupported();
        if (!(await claudeSubagentExists(args.sessionId, args.agentId))) {
          return subagentNotFound(args.agentId);
        }
      }
      const maxChars = args.maxCharsPerField ?? GET_TOOL_CALL_DEFAULT_MAX_CHARS;

      const detail: ToolCallDetail | undefined =
        resolved.source === "codex"
          ? await getCodexSessionToolCallDetail(args.sessionId, args.toolUseId)
          : await getSessionToolCallDetail(args.sessionId, args.toolUseId, args.agentId);
      if (detail === undefined) return toolCallNotFound(args.toolUseId, args.agentId);

      const cappedInput = capInputField(detail.call.input, maxChars);
      const cappedResult =
        detail.result === null
          ? undefined
          : capTextField(detail.result.text, maxChars, detail.result.fullTextLength);

      return jsonResult(
        {
          sessionId: args.sessionId,
          source: resolved.source,
          ...(args.agentId !== undefined && { agentId: args.agentId }),
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
        "input (e.g. the per-launch billing-header system block, a missing template). `params` is " +
        "NOT one template-confidence blob but a PER-KEY map: `params.entries` keyed by wire param " +
        "name (`model`, `max_tokens`, `thinking`, `context_management`, `stream`, ...), each key " +
        "carrying its OWN confidence + provenance. In particular `model` comes from the target " +
        "assistant record's own log line (confidence `exact`, provenance that log line) whenever " +
        "the log records it, OVERRIDING the template's captured default — so a session that ran " +
        "on a different model than the template capture reports its REAL model, never a stale " +
        "default; every other params key stays `template`. EXCEPTION: if the CLI was launched " +
        "with a model ALIAS, the wire request carried that alias literal but the log records the " +
        "alias's RESOLVED id (e.g. wire `claude-haiku-4-5` vs log `claude-haiku-4-5-20251001`) — " +
        "when the template default is exactly that alias, it is KEPT at `template` confidence " +
        "with a log-consistency note on `entries.model.note`, since overriding it with the " +
        "resolved id would misreport what the wire literal actually was. A key with neither a " +
        "template default nor a log value is `unknown`, declared. When no template supplied " +
        "params, `entries` is empty or model-only and a section-level `confidence: unknown` " +
        "declares the gap. Called " +
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

  server.registerTool(
    "get_session_observability",
    {
      description:
        "Claude Code's own OpenTelemetry export for one session, parsed into aggregates — the " +
        "OTel side channel is OPT-IN and OFF by default. Setup requires BOTH sides: the junrei " +
        "server needs JUNREI_OTEL_DIR set (an absolute directory path it stores per-session " +
        "OTLP-JSON under), and Claude Code itself needs OTEL_LOGS_EXPORTER=otlp, " +
        "OTEL_METRICS_EXPORTER=otlp, and OTEL_EXPORTER_OTLP_PROTOCOL=http/json pointed at this " +
        "server's /otlp/v1/logs and /otlp/v1/metrics endpoints. When either side is missing, or " +
        "OTel is configured but this particular session has no recorded data, the response is " +
        "NEVER a silent empty — `otelAvailable: false` plus an explanatory `note` naming " +
        "JUNREI_OTEL_DIR make that explicit, and `cost.sessionLog` (which needs no OTel data) is " +
        "still returned. When data IS available, `cost` carries TWO figures, each tagged with " +
        'its own `costBasis`, never conflated: `cost.otel.costBasis: "otel"` is Claude Code\'s ' +
        "own billing-computed cost_usd (authoritative — not derived from token counts) summed " +
        "across `api_request` events (or, if Claude Code exported metrics only, summed from the " +
        "cost.usage metric instead — see `cost.otel.source`); `cost.sessionLog.costBasis: " +
        '"pricing-table-estimate"` is the SAME token-count x pricing-table estimate every other ' +
        "cost-bearing tool reports (get_session_summary's totalUsage); `cost.deltaUsd` (otel " +
        "minus sessionLog) is only present when an OTel cost figure exists — a persistently " +
        "large delta usually means hidden/background API calls the session log structurally " +
        "undercounts (see hiddenApiCalls in sourceCompleteness). `apiRequests.duration` is " +
        "latency stats (count/sum/min/max/avg ms) over whichever api_request events carried a " +
        "duration_ms attribute — undefined when none did; latency is otherwise absent from every " +
        "other tool. `toolDecisions` are permission accept/reject events (tool name, decision, " +
        "source, timestamp), capped at `maxToolDecisions` (default " +
        `${GET_SESSION_OBSERVABILITY_DEFAULT_MAX_TOOL_DECISIONS}) with an explicit ` +
        "`truncated` flag — `total` stays exact past the cap. `health` carries MCP-connection " +
        "and hook-execution events (capped at " +
        `${GET_SESSION_OBSERVABILITY_MAX_HEALTH_EVENTS} with the same truncation contract). ` +
        "`unrecognized` declares every OTHER event/metric type this parser doesn't specifically " +
        "model, by name and count — NEVER silently dropped, even though not individually " +
        "parsed. OTel carries NO prompt or tool content whatsoever (no user/assistant text, no " +
        "tool arguments/results, no system prompt, no tool schemas) — it is a pure ops/billing " +
        "channel, never a substitute for get_records/get_tool_call. Claude Code sessions only " +
        "(source: codex is rejected — Codex CLI has no equivalent telemetry). Every response " +
        "includes sourceCompleteness for BOTH claude-session-jsonl and claude-otel — a " +
        "machine-readable declaration of what each underlying source cannot show; treat " +
        "absent/not-recorded dimensions as unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        maxToolDecisions: z
          .number()
          .int()
          .min(1)
          .max(GET_SESSION_OBSERVABILITY_MAX_MAX_TOOL_DECISIONS)
          .optional()
          .describe(
            "Cap on toolDecisions.entries " +
              `(default ${GET_SESSION_OBSERVABILITY_DEFAULT_MAX_TOOL_DECISIONS}, ` +
              `max ${GET_SESSION_OBSERVABILITY_MAX_MAX_TOOL_DECISIONS}); toolDecisions.total ` +
              "stays exact past the cap",
          ),
      },
    },
    async ({ source, sessionId, maxToolDecisions }) => {
      if (source === "codex") return notAvailableForObservability();
      const analysis = await getSession(sessionId);
      if (analysis === undefined) return notFound(sessionId);

      const otelDir = resolveOtelDir();
      if (otelDir === undefined) return observabilityUnavailable(sessionId, analysis, "disabled");

      const lines = await readOtelLines(otelDir, sessionId);
      if (lines.length === 0) return observabilityUnavailable(sessionId, analysis, "no-data");

      const cap = maxToolDecisions ?? GET_SESSION_OBSERVABILITY_DEFAULT_MAX_TOOL_DECISIONS;
      const otel = parseOtelSessionLines(lines, { maxToolDecisions: cap });
      const sessionLogCost = sessionLogCostOf(analysis);
      const cappedHealth = otel.health.slice(0, GET_SESSION_OBSERVABILITY_MAX_HEALTH_EVENTS);

      return jsonResult(
        {
          sessionId,
          source: "claude-code" as const,
          otelAvailable: true,
          cost: {
            sessionLog: sessionLogCost,
            ...(otel.apiRequests.costSource !== "none" && {
              otel: {
                costUsd: otel.apiRequests.costUsdSum,
                costBasis: "otel" as const,
                source: otel.apiRequests.costSource,
              },
              deltaUsd: otel.apiRequests.costUsdSum - sessionLogCost.costUsd,
            }),
          },
          apiRequests: {
            count: otel.apiRequests.count,
            ...(otel.apiRequests.duration !== undefined && { duration: otel.apiRequests.duration }),
          },
          toolDecisions: otel.toolDecisions,
          health: {
            total: otel.health.length,
            entries: cappedHealth,
            truncated: otel.health.length > cappedHealth.length,
          },
          unrecognized: {
            events: otel.unrecognizedEventCounts,
            metrics: otel.unrecognizedMetricCounts,
          },
          raw: {
            logPayloads: otel.logPayloads,
            metricPayloads: otel.metricPayloads,
            malformedLines: otel.malformedLines,
          },
        },
        ["claude-session-jsonl", "claude-otel"],
      );
    },
  );

  server.registerTool(
    "get_bash_stats",
    {
      description:
        "Bash-command analytics for one session: totals (calls/errors/chars/estimatedTokens/" +
        "estUsd), commands grouped by resolved family+subcommand (e.g. `git diff`) ranked by " +
        "result size with each group's `sharePct` of total result chars, a per-thread rollup " +
        "(`byThread` — main vs. each subagent's own calls/chars/estUsd, for seeing where Bash " +
        "spend actually sat), per-executable segment frequency (covers every side of a " +
        "pipeline, not just the primary command), the top 10 calls by result size, background " +
        "(run_in_background) task outcomes, quantitative waste signals (near-duplicate command " +
        "groups, oversized results, same-command reruns immediately after a failure, and Bash " +
        "calls that read a file the way the Read tool would — cat/head/tail/sed -n), and a " +
        "ranked `opportunities` list of TEMPLATED fix suggestions derived from that same waste " +
        "data. Every `opportunities` item's `fixText` is copy-ready, imperative, DATA-FILLED " +
        "text (the command/thread/pattern/size actually observed) — it is NOT LLM-generated " +
        "advice, just a fill-in-the-blanks template over `waste`, so treat it as a starting " +
        "point, not a verdict. Each item's `savingsBasis` says how its `estUsdSaved` was " +
        'derived: `"measured"` (near-duplicate/rerun-after-error — a real sum over actual ' +
        'repeat occurrences), `"heuristic"` (bash-as-read/large-result — a fixed coefficient ' +
        "applied to real chars, since there's no evidence of what the fixed version would " +
        "actually have produced; see `heuristicNote` for the exact coefficient), or " +
        '`"none"` (no class produces this today, reserved). `estUsdSaved` is ALL-OR-NOTHING: ' +
        "absent unless every contributing occurrence resolved a priced thread model — never a " +
        "partial sum. EVERY dollar figure in this response ($ from `totals`/`byCommand`/" +
        "`byThread`/`heavyHitters`/`waste`/`opportunities`, and `bashPercentile`'s ranking) is " +
        "an ESTIMATE from a fixed per-model pricing table applied to char counts, never a " +
        "billed amount. These are observations, not judgments: interpretation is the caller's " +
        "job. Every list beyond a small fixed cap reports `totalCount` and `truncated` " +
        "alongside the (possibly shorter) `items` array — a capped list never reads as " +
        "complete. Char counts (`inputChars`/`resultChars`/`totalInputChars`/`totalResultChars`) " +
        "are EXACT, read straight from the session record; `estimatedTokens` is a " +
        "`Math.ceil(chars / 4)` HEURISTIC (no real tokenizer runs over Bash text) — good for " +
        "relative comparison, not exact accounting. A background task's `wallClockMs` is " +
        "wall-clock time from launch to the harness's completion notification (includes real " +
        "background execution time), NOT context/API cost. `includeSubagents: false` does NOT " +
        "post-hoc filter the joint result (rankings/sharePct/opportunities are computed jointly " +
        "across every thread and can't be un-mixed) — it recomputes stats from the main " +
        'transcript ALONE. `bashPercentile` ("this session is pNN for this repo") is present ' +
        "only when this session's repo has >= 5 Bash-tracked sessions to rank against (same " +
        "gate the Bash tab's header-strip chip uses) — ABSENT, not zero, whenever the repo " +
        "history is too thin; a Codex session's percentile is always ranked on its own " +
        "MAIN-THREAD-ONLY figure (see the `note` field on a Codex response, when present) " +
        "regardless of `includeSubagents`, since the repo distribution it's ranked against is " +
        "itself built the same way. Works for both Claude Code sessions and Codex CLI sessions " +
        '(source: "codex"), covering shell calls across function_call (shell/exec_command, ' +
        "including a bash/sh/zsh -lc wrapper unwrapped to its inner command), local_shell_call, " +
        "and the 0.144+ unified-exec custom_tool_call form. Codex specifics: `background` is " +
        "always empty (no run_in_background concept exists in Codex's data model yet); a " +
        "`local_shell_call`-sourced entry's `resultChars` reflects only a synthesized \"exited " +
        'with code N" placeholder (Codex records no real stdout/stderr for that wire surface, ' +
        "unlike function_call/custom_tool_call entries, which do carry real output text). Every " +
        "response includes sourceCompleteness — a machine-readable declaration of what the " +
        "underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            "Default true (main + every subagent thread, jointly). false recomputes " +
              "main-transcript-only stats instead of filtering the joint result.",
          ),
        topCommands: z
          .number()
          .int()
          .min(1)
          .max(BASH_STATS_MAX_TOP_COMMANDS)
          .optional()
          .describe(
            "Cap on the byCommand list length " +
              `(default ${BASH_STATS_DEFAULT_TOP_COMMANDS}, max ${BASH_STATS_MAX_TOP_COMMANDS})`,
          ),
        topOpportunities: z
          .number()
          .int()
          .min(1)
          .max(BASH_STATS_MAX_TOP_OPPORTUNITIES)
          .optional()
          .describe(
            "Cap on the opportunities list length " +
              `(default ${BASH_STATS_DEFAULT_TOP_OPPORTUNITIES}, ` +
              `max ${BASH_STATS_MAX_TOP_OPPORTUNITIES})`,
          ),
        topWaste: z
          .number()
          .int()
          .min(1)
          .max(BASH_STATS_MAX_TOP_WASTE)
          .optional()
          .describe(
            "Cap on each waste list's length (nearDuplicates/largeResults/rerunAfterError/bashAsRead) " +
              `(default ${BASH_STATS_DEFAULT_TOP_WASTE}, max ${BASH_STATS_MAX_TOP_WASTE})`,
          ),
      },
    },
    async ({ source, sessionId, includeSubagents, topCommands, topOpportunities, topWaste }) => {
      // zod already enforces topCommands <= BASH_STATS_MAX_TOP_COMMANDS,
      // topOpportunities <= BASH_STATS_MAX_TOP_OPPORTUNITIES, and
      // topWaste <= BASH_STATS_MAX_TOP_WASTE.
      const cap = topCommands ?? BASH_STATS_DEFAULT_TOP_COMMANDS;
      const oppCap = topOpportunities ?? BASH_STATS_DEFAULT_TOP_OPPORTUNITIES;
      const wasteCap = topWaste ?? BASH_STATS_DEFAULT_TOP_WASTE;
      const includeSub = includeSubagents ?? true;

      if (source === "codex") {
        const analysis = await getCodexSession(sessionId);
        if (analysis === undefined) return notFound(sessionId);
        // Percentile ranking always needs the main-thread-only figure — the
        // SAME basis every repo-distribution sample was itself built from
        // (see `bash-percentile.ts`'s doc comment) — never the joint
        // `analysis.bashStats`, which OVERRIDES with a forest-inclusive
        // recompute once a sub-agent forest exists. Cheap regardless of
        // `includeSubagents`: `getCodexSessionBashStatsMainOnly` just reads
        // the already mtime-cached single-file analysis.
        const mainOnlyStats = await getCodexSessionBashStatsMainOnly(sessionId);
        const stats = includeSub ? analysis.bashStats : mainOnlyStats;
        if (stats === undefined) return notFound(sessionId);
        const bashPercentile =
          mainOnlyStats === undefined
            ? undefined
            : await resolveBashPercentile(analysis, {
                estUsd: mainOnlyStats.totals.estUsd,
                resultChars: mainOnlyStats.totals.resultChars,
              });
        return jsonResult(
          {
            sessionId,
            includeSubagents: includeSub,
            ...toBashStatsResponse(stats, cap, oppCap, wasteCap),
            ...(bashPercentile !== undefined && {
              bashPercentile: {
                ...bashPercentile,
                note:
                  "Ranked on this session's own main-thread-only Bash figure, regardless of " +
                  "includeSubagents — the repo distribution it's ranked against is itself " +
                  "always built from main-thread-only figures (see get_bash_stats' tool " +
                  "description).",
              },
            }),
          },
          ["codex-session-jsonl"],
        );
      }

      // Claude's `bashStats` is ALREADY the main+every-subagent joint pass at
      // both list-item and detail time (no forest-override discrepancy the
      // way Codex has), so `analysis.bashStats.totals` is directly the right
      // percentile basis regardless of `includeSubagents` — fetched here
      // (mtime-cached, so cheap on repeat calls) even when the response body
      // itself will recompute a main-only `stats` below.
      const analysis = await getSession(sessionId);
      if (analysis === undefined) return notFound(sessionId);
      const bashPercentile = await resolveBashPercentile(analysis, {
        estUsd: analysis.bashStats.totals.estUsd,
        resultChars: analysis.bashStats.totals.resultChars,
      });

      if (includeSub) {
        return jsonResult(
          {
            sessionId,
            includeSubagents: true,
            ...toBashStatsResponse(analysis.bashStats, cap, oppCap, wasteCap),
            ...(bashPercentile !== undefined && { bashPercentile }),
          },
          ["claude-session-jsonl"],
        );
      }

      const data = await getSessionData(sessionId);
      if (data === undefined) return notFound(sessionId);
      const stats = computeBashStats([{ thread: "main", data }]);
      return jsonResult(
        {
          sessionId,
          includeSubagents: false,
          ...toBashStatsResponse(stats, cap, oppCap, wasteCap),
          ...(bashPercentile !== undefined && { bashPercentile }),
        },
        ["claude-session-jsonl"],
      );
    },
  );

  server.registerTool(
    "get_tool_calls",
    {
      description:
        "Paginated, filterable listing of tool calls in one session — the discovery primitive " +
        "for finding a `toolUseId` in the first place (get_tool_call resolves ONE already-known " +
        "toolUseId into full call+result detail; use that next for full drill-down once you have " +
        "an id from here). Each item is a compact summary: toolUseId, source line, timestamp, " +
        "tool name, thread (`main` or a subagent's agentId), status (ok/error/missing-result), " +
        "inputChars/resultChars (exact, from the session record), durationMs when resolvable, " +
        "and a capped one-line inputSummary. Bash calls additionally carry `family`/`subcommand` " +
        "(the resolved executable and, for known command families like git/pnpm/gh, its " +
        "subcommand — see get_bash_stats). `totalCount` is the post-filter, pre-pagination match " +
        'count, for building a pager. `thread: "subagents"`/`"all"` walks every subagent ' +
        "sidecar transcript, not just the main one. Works for both Claude Code sessions and Codex " +
        'CLI sessions (source: "codex") — `toolName` matches Codex\'s own wire names ' +
        '("shell"/"exec_command"/"exec"/"apply_patch"/"web_search"/...; a `local_shell_call` ' +
        'lists as `toolName: "shell"`, same convention the Timeline lens uses), and a shell-call ' +
        "row's family/subcommand come from the same neutral extraction get_bash_stats uses " +
        '(including bash/sh/zsh -lc wrapper unwrapping); `thread: "subagents"`/`"all"` walks a ' +
        "Codex session's sub-agent forest (sibling rollout files) rather than sidecar transcripts. " +
        "Every response includes sourceCompleteness — a machine-readable declaration of what the " +
        "underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        toolName: z.string().optional().describe('Exact tool name match, e.g. "Bash"'),
        thread: z.enum(["main", "subagents", "all"]).optional().describe("Default all"),
        status: z.enum(["ok", "error", "all"]).optional().describe("Default all"),
        sort: z
          .enum(["line", "resultChars"])
          .optional()
          .describe(
            "Default line (ascending across threads; ties break by thread id — " +
              "line numbers from different transcripts interleave); resultChars sorts descending",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(GET_TOOL_CALLS_MAX_LIMIT)
          .optional()
          .describe(`Default ${GET_TOOL_CALLS_DEFAULT_LIMIT}, max ${GET_TOOL_CALLS_MAX_LIMIT}`),
        offset: z.number().int().min(0).optional().describe("Default 0"),
      },
    },
    async ({ source, sessionId, toolName, thread, status, sort, limit, offset }) => {
      const threadFilter = thread ?? "all";
      const statusFilter = status ?? "all";
      const sortKey = sort ?? "line";
      const lim = limit ?? GET_TOOL_CALLS_DEFAULT_LIMIT;
      const off = offset ?? 0;

      const items: ToolCallListItem[] = [];
      if (source === "codex") {
        const codexThreads = await collectCodexToolCallThreads(sessionId, threadFilter);
        if (codexThreads === undefined) return notFound(sessionId);
        for (const { thread: threadId, records } of codexThreads) {
          for (const record of records) {
            if (toolName !== undefined && record.toolName !== toolName) continue;
            const item = toCodexToolCallItem(threadId, record);
            if (statusFilter !== "all" && item.status !== statusFilter) continue;
            items.push(item);
          }
        }
      } else {
        const threads = await collectToolCallThreads(sessionId, threadFilter);
        if (threads === undefined) return notFound(sessionId);
        for (const { thread: threadId, data } of threads) {
          for (const call of data.toolCalls) {
            if (toolName !== undefined && call.name !== toolName) continue;
            const item = toToolCallItem(threadId, call);
            if (statusFilter !== "all" && item.status !== statusFilter) continue;
            items.push(item);
          }
        }
      }

      items.sort((a, b) => {
        if (sortKey === "resultChars" && b.resultChars !== a.resultChars) {
          return b.resultChars - a.resultChars;
        }
        if (a.line !== b.line) return a.line - b.line;
        return a.thread.localeCompare(b.thread);
      });

      const totalCount = items.length;
      const toolCalls = items.slice(off, off + lim);

      return jsonResult({ sessionId, totalCount, toolCalls }, [sourceKindFor(source)]);
    },
  );

  server.registerTool(
    "get_actual_request",
    {
      description:
        "The ACTUAL captured Anthropic /v1/messages wire exchange for one request — GROUND TRUTH " +
        "from the opt-in local wire-capture proxy (`@junrei/capture-proxy`; see README 'Wire " +
        "capture'), not a reconstruction. JOIN KEY: `requestId` is the SAME id the session log " +
        "records as its own `requestId` on the assistant records of a turn (the discovery " +
        "listing of get_reconstructed_request, and other tools' `requestId` fields, surface it) " +
        "— the capture proxy reads it from the response `request-id` header, so the two line up " +
        "with zero heuristics. Returns the captured REQUEST BODY (capped to `maxCharsPerField`, " +
        "default 30000, min 200, with an explicit `request.bodyTruncated` flag plus " +
        "`request.bodyFullCharCount` when cut — never silently shortened), the RESPONSE META " +
        "parsed from the captured stream (`response.status`, `response.model`, `response.usage` " +
        "when present — for an SSE response these come from the reassembled message), the " +
        "MEASURED `latencyMs` (wall-clock at the proxy, authoritative — the session log records " +
        "no latency at all), `isSubagent` (from the `cc_is_subagent=true` marker Claude Code " +
        "stamps on subagent requests), and request/response byte sizes. Auth headers " +
        "(authorization, x-api-key, cookies, *token*/*secret*) were REDACTED at write time and " +
        "are never present. Declared non-errors (never a crash): with no captures directory or " +
        "no capture file for this session, `captureAvailable: false` with a note (wire capture is " +
        "opt-in — nothing is recorded unless the user ran the proxy); with captures present but " +
        "this exact `requestId` absent, `captureAvailable: true` + `requestNotCaptured: true`. " +
        "Claude Code sessions only (source: codex is rejected — capture is Claude-specific). " +
        "Every response includes sourceCompleteness — a machine-readable declaration of what the " +
        "underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        requestId: z
          .string()
          .min(1)
          .describe(
            "The request's id — the SAME value the session log records as `requestId` (from " +
              "get_reconstructed_request's discovery listing or another tool's `requestId` field)",
          ),
        maxCharsPerField: z
          .number()
          .int()
          .min(GET_ACTUAL_REQUEST_MIN_MAX_CHARS)
          .optional()
          .describe(
            "Cap for the captured request body " +
              `(default ${GET_ACTUAL_REQUEST_DEFAULT_MAX_CHARS}, min ${GET_ACTUAL_REQUEST_MIN_MAX_CHARS})`,
          ),
      },
    },
    async (args) => {
      if (args.source === "codex") return notAvailableForCaptures();
      const maxChars = args.maxCharsPerField ?? GET_ACTUAL_REQUEST_DEFAULT_MAX_CHARS;
      const store = createFilesystemCaptureStore();
      const lookup = await store.readSessionCaptures(args.sessionId);
      if (!lookup.available) {
        return jsonResult(
          {
            sessionId: args.sessionId,
            source: "claude-code" as const,
            captureAvailable: false,
            note:
              lookup.reason === "captures-dir-missing"
                ? "no captures directory — wire capture is opt-in; start junrei-capture-proxy and " +
                  "route Claude Code through it (README 'Wire capture')."
                : "this session was not captured — no capture file exists for it (the proxy was " +
                  "not active for this session).",
          },
          CAPTURE_KINDS,
        );
      }
      const record = findCapturedRequest(lookup.records, args.requestId);
      if (record === undefined) {
        return jsonResult(
          {
            sessionId: args.sessionId,
            source: "claude-code" as const,
            captureAvailable: true,
            requestNotCaptured: true,
            requestId: args.requestId,
            note:
              "no captured request with this requestId in this session's capture file — it may " +
              "predate capture, or the id belongs to a different session.",
          },
          CAPTURE_KINDS,
        );
      }
      const cappedBody = capInputField(record.requestBody, maxChars);
      const meta = extractResponseMeta(record);
      const sizes = capturedByteSizes(record);
      return jsonResult(
        {
          sessionId: args.sessionId,
          source: "claude-code" as const,
          captureAvailable: true,
          requestId: args.requestId,
          ...(record.method !== undefined && { method: record.method }),
          ...(record.path !== undefined && { path: record.path }),
          isSubagent: record.isSubagent ?? false,
          ...(record.latencyMs !== undefined && { latencyMs: record.latencyMs }),
          request: {
            body: cappedBody.input,
            bodyTruncated: cappedBody.truncated,
            ...(cappedBody.fullCharCount !== undefined && {
              bodyFullCharCount: cappedBody.fullCharCount,
            }),
            requestBytes: sizes.requestBytes,
          },
          response: {
            ...(meta.status !== undefined && { status: meta.status }),
            ...(meta.model !== undefined && { model: meta.model }),
            ...(meta.usage !== undefined && { usage: meta.usage }),
            responseBytes: sizes.responseBytes,
          },
        },
        CAPTURE_KINDS,
      );
    },
  );

  server.registerTool(
    "get_hidden_calls",
    {
      description:
        "The captured API requests for a session whose `requestId` DOES NOT appear anywhere in " +
        "that session's own log (main transcript + subagent sidecars) — the STRUCTURAL evidence " +
        "that session-log cost/latency accounting undercounts. These are real Anthropic calls the " +
        "harness made (e.g. a background task-state classifier) that the session log has no " +
        "channel to record, so summarizing tools built on the log alone cannot see them; the " +
        "join is exact — a captured response `request-id` matched against every `requestId` the " +
        "log records. Requires the opt-in wire capture (README 'Wire capture'); per hidden call " +
        "it reports `requestId`, `path`, `model`, a `usage` summary, MEASURED `latencyMs`, " +
        "request/response byte sizes, and `isSubagent`, plus `counts` " +
        "(captured total, captured-with-requestId, logged requestId count, hidden count). The " +
        "actual request/response CONTENT stays behind get_actual_request — call it with a hidden " +
        "call's `requestId` to fetch the captured body (this tool intentionally returns only the " +
        "metadata needed to decide which hidden call to open). Declared non-errors (never a " +
        "crash): with no captures directory or no capture file for this session, " +
        "`captureAvailable: false` with a note. Claude Code sessions only (source: codex is " +
        "rejected — capture is Claude-specific). Every response includes sourceCompleteness — a " +
        "machine-readable declaration of what the underlying session source cannot show; treat " +
        "absent/not-recorded dimensions as unknowable from this data, not as evidence of absence.",
      inputSchema: sessionRef,
    },
    async (args) => {
      if (args.source === "codex") return notAvailableForCaptures();
      const store = createFilesystemCaptureStore();
      const lookup = await store.readSessionCaptures(args.sessionId);
      if (!lookup.available) {
        return jsonResult(
          {
            sessionId: args.sessionId,
            source: "claude-code" as const,
            captureAvailable: false,
            note:
              lookup.reason === "captures-dir-missing"
                ? "no captures directory — wire capture is opt-in; start junrei-capture-proxy and " +
                  "route Claude Code through it (README 'Wire capture')."
                : "this session was not captured — no capture file exists for it (the proxy was " +
                  "not active for this session).",
          },
          CAPTURE_KINDS,
        );
      }
      const logged = await store.collectLoggedRequestIds(args.sessionId);
      if (logged === undefined) return notFound(args.sessionId);

      const withRequestId = lookup.records.filter((record) => typeof record.requestId === "string");
      const hidden = withRequestId.filter((record) => !logged.has(record.requestId as string));
      const hiddenCalls = hidden.map((record) => {
        const meta = extractResponseMeta(record);
        const sizes = capturedByteSizes(record);
        return {
          requestId: record.requestId,
          ...(record.path !== undefined && { path: record.path }),
          ...(meta.model !== undefined && { model: meta.model }),
          ...(meta.usage !== undefined && { usage: meta.usage }),
          ...(record.latencyMs !== undefined && { latencyMs: record.latencyMs }),
          requestBytes: sizes.requestBytes,
          responseBytes: sizes.responseBytes,
          isSubagent: record.isSubagent ?? false,
        };
      });

      return jsonResult(
        {
          sessionId: args.sessionId,
          source: "claude-code" as const,
          captureAvailable: true,
          hiddenCalls,
          counts: {
            capturedRequestCount: lookup.records.length,
            capturedWithRequestId: withRequestId.length,
            loggedRequestIdCount: logged.size,
            hiddenCallCount: hiddenCalls.length,
          },
        },
        CAPTURE_KINDS,
      );
    },
  );

  server.registerTool(
    "export_evaluation_trace",
    {
      description:
        "Exports one session as a normalized, single-JSON EVALUATION TRACE — schema " +
        "`junrei-evaluation-trace/v1` — for external eval pipelines and LLM-judges: " +
        "`{schema, session, sourceCompleteness, enrichment, limitations, events}`. Every event " +
        "(`{name, timestamp?, provenance: {line?, requestId?}, attributes}`) is OTel-GenAI-" +
        "semconv-flavored: `gen_ai.user.message` / `gen_ai.assistant.message` / `gen_ai.tool.call` " +
        "/ `gen_ai.tool.result` for ordinary turns (tool-result text is FULL-recovered past the " +
        "session-log parser's capture cap, same mechanism get_tool_call uses), `gen_ai.request` " +
        "once per main-loop requestId for per-request enrichment, and `junrei.*` for harness " +
        "events (`junrei.subagent_launch`, `junrei.task_notification`, `junrei.compaction`, " +
        "`junrei.api_error`, `junrei.injected_context`, `junrei.hidden_api_call`). Events are " +
        "ordered by source line; a `junrei.hidden_api_call` (which by definition has no log line) " +
        "is interpolated between the two log-anchored events its own capture timestamp falls " +
        "between, never simply appended. " +
        "PER-REQUEST ENRICHMENT (`gen_ai.request.attributes`): always carries a pricing-table " +
        "`pricingEstimate` (the same estimate every other cost-bearing tool reports); `capture` " +
        "(measured `latencyMs`/`isSubagent`) appears ONLY when wire capture is opt-in AND this " +
        "exact requestId was captured; `reconstruction` (confidence-class COUNTS + appliedRules + " +
        "limitations — DELIBERATELY NOT the full reconstructed payload, to avoid repeating, per " +
        "request, bytes get_reconstructed_request already serves on demand) appears ONLY for " +
        "locally-stored sessions when a reconstruction could be built for that requestId — call " +
        "get_reconstructed_request with the cited requestId for the actual system/tools/messages " +
        "content. OTel does NOT get a per-request field at all: Claude Code's OTel api_request " +
        "event carries no request-id attribute to join against the session log's requestId (unlike " +
        "wire capture, whose response request-id header IS the exact join key), so inventing an " +
        "ordinal/heuristic join is refused — OTel's contribution is a SESSION-LEVEL aggregate on " +
        "`enrichment.otel` instead (see below). " +
        "OTEL/CAPTURE ARE OPT-IN AND DECLARED, NEVER SILENTLY ABSENT: `sourceCompleteness` lists " +
        "`claude-otel`/`claude-wire-capture` ONLY when that channel actually had data for this " +
        "session (an absent source there just means no data — it does NOT mean the channel wasn't " +
        "checked); the trace-level `enrichment.otel`/`enrichment.captures` block is what always " +
        "declares whether each channel was even consulted — `{consulted, available, note?}` plus " +
        "`enrichment.otel`'s session-level `costUsd`/`costSource`/`apiRequestCount`/`durationMsAvg` " +
        "and `enrichment.captures.hiddenCallCount` — so `consulted: true, available: false` (with " +
        "a note) is always distinguishable from a channel this export never looked at. " +
        "`limitations` (trace-level, mirroring a reconstruction's own `limitations` array) declares " +
        "session-wide caveats: subagent trees are summarized (not merged — a subagent's own tool " +
        "calls/messages stay in ITS sidecar transcript, drill in via get_subagent_tree / a " +
        "sessionId-scoped call to this same tool), a capped api-error list, unattempted injected-" +
        "context/reconstruction recovery (S3-merged sessions), and the OTel no-join note above. " +
        "TRUNCATION: `maxEvents` (default " +
        `${EXPORT_EVALUATION_TRACE_DEFAULT_MAX_EVENTS}, max ` +
        `${EXPORT_EVALUATION_TRACE_MAX_MAX_EVENTS}) caps the event list (already in source-line ` +
        "order) with explicit `eventsTruncated` + exact `totalEvents`; `maxCharsPerField` (default " +
        `${EXPORT_EVALUATION_TRACE_DEFAULT_MAX_CHARS}, min ` +
        `${EXPORT_EVALUATION_TRACE_MIN_MAX_CHARS} — traces are BROAD, covering an entire session, ` +
        "so this default is deliberately more generous than get_tool_call's) caps each event's OWN " +
        "known text-bearing attributes (message/tool-result/prompt text, tool-call input) with the " +
        "SAME explicit `<field>Truncated` + `<field>FullCharCount` contract get_tool_call uses — " +
        "raise it to see more; never a silently shorter value. This tool's response is always a " +
        "CAPPED view for a chat context — `GET /api/sessions/claude-code/:id/evaluation-trace` on " +
        "the junrei HTTP server returns the SAME trace with no event/field caps at all, for an " +
        "external pipeline that wants everything at once (the response's own `note` field repeats " +
        "this pointer). Claude Code sessions only (source: codex is rejected — the trace merges " +
        "reconstruction/OTel/wire-capture, all three Claude-Code-specific; Codex has no HTTP route " +
        "either). Every response includes sourceCompleteness — a machine-readable declaration of " +
        "what the underlying session source cannot show; treat absent/not-recorded dimensions as " +
        "unknowable from this data, not as evidence of absence.",
      inputSchema: {
        ...sessionRef,
        maxEvents: z
          .number()
          .int()
          .min(1)
          .max(EXPORT_EVALUATION_TRACE_MAX_MAX_EVENTS)
          .optional()
          .describe(
            "Cap on the events array, already in source-line order " +
              `(default ${EXPORT_EVALUATION_TRACE_DEFAULT_MAX_EVENTS}, ` +
              `max ${EXPORT_EVALUATION_TRACE_MAX_MAX_EVENTS}); totalEvents stays exact past the cap`,
          ),
        maxCharsPerField: z
          .number()
          .int()
          .min(EXPORT_EVALUATION_TRACE_MIN_MAX_CHARS)
          .optional()
          .describe(
            "Cap per text-bearing attribute, per event " +
              `(default ${EXPORT_EVALUATION_TRACE_DEFAULT_MAX_CHARS}, ` +
              `min ${EXPORT_EVALUATION_TRACE_MIN_MAX_CHARS})`,
          ),
      },
    },
    async (args) => {
      if (args.source === "codex") return notAvailableForEvaluationTrace();
      const trace = await assembleEvaluationTrace(args.sessionId);
      if (trace === undefined) return notFound(args.sessionId);

      const maxEvents = args.maxEvents ?? EXPORT_EVALUATION_TRACE_DEFAULT_MAX_EVENTS;
      const maxChars = args.maxCharsPerField ?? EXPORT_EVALUATION_TRACE_DEFAULT_MAX_CHARS;
      const totalEvents = trace.events.length;
      const events = trace.events
        .slice(0, maxEvents)
        .map((event) => cappedEvaluationTraceEvent(event, maxChars));

      return jsonResult(
        {
          sessionId: args.sessionId,
          source: "claude-code" as const,
          schema: trace.schema,
          session: trace.session,
          enrichment: trace.enrichment,
          limitations: trace.limitations,
          events,
          totalEvents,
          eventsTruncated: totalEvents > events.length,
          note:
            "This is a capped/truncated view for a chat context. " +
            `GET /api/sessions/claude-code/${args.sessionId}/evaluation-trace on the junrei HTTP ` +
            "server returns this SAME trace with no event/field caps at all.",
        },
        trace.sourceCompleteness.sources.map((s) => s.source),
      );
    },
  );

  return server;
}
