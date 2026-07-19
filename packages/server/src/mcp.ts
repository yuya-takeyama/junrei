/**
 * Junrei's MCP interface — the self-improvement loop surface.
 *
 * Six high-leverage tools drive one loop: `briefing` (what's wrong this week)
 * -> `analyze_session` (why, for one session) -> `log_learning` (record the
 * fix) -> `review_learnings` (did it help). `find_patterns` and `get_evidence`
 * are the cross-session and drill-down helpers. Every tool is a THIN binder:
 * it validates input, gathers the analyses it needs (via `./insight.ts`, which
 * reuses the same cached loaders the REST API does), calls the pure
 * `@junrei/core` insight layer, and returns its result — which always carries
 * a `_meta` envelope (`approxTokens`, optional `truncated`, and `nextSteps`
 * that never dead-end). Junrei never evaluates; interpretation is the caller's.
 *
 * Two diagnostic tools (`inspect_wire`, `export_trace`) are registered ONLY
 * when `JUNREI_DIAGNOSTICS=1` — they expose the Claude-Code-specific wire
 * capture / request reconstruction / evaluation-trace layers, which most
 * loops never need and which would otherwise bloat the always-on schema.
 */

import { join } from "node:path";
import {
  buildMeta,
  buildSourceCompleteness,
  type CodexToolCallRecord,
  createLearning,
  type Detail,
  durationBetween,
  type EvaluationTraceEvent,
  type EvidenceFetchers,
  type EvidenceSelect,
  type LearningSource,
  type LearningStatus,
  type LearningVerification,
  listReconstructableRequests,
  listSubagentRefs,
  loadReconstructionInput,
  loadSubagentSessionData,
  localClaudeSessionStore,
  type PatternKind,
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
  selectEvidence,
  summarizeToolInput,
  type ToolCall,
  type ToolCallDetail,
  updateLearning,
} from "@junrei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assembleEvaluationTrace } from "./evaluation-trace.js";
import {
  AmbiguousRepoError,
  buildRepoBriefing,
  buildSessionInsightFor,
  findPatternsFor,
  mergeLearningSourceSessions,
  resolveLearningRepoRoot,
  reviewLearningsFor,
} from "./insight.js";
import {
  collectCodexToolCallThreads,
  getCodexSession,
  getCodexSessionRecordDetail,
  getCodexSessionToolCallDetail,
  getSession,
  getSessionData,
  getSessionRecordDetail,
  getSessionToolCallDetail,
} from "./sessions.js";
import {
  capturedByteSizes,
  createFilesystemCaptureStore,
  extractResponseMeta,
  findCapturedRequest,
} from "./sources/captures.js";
import { claudeStoreForFilePath } from "./sources/claude.js";
import {
  createFilesystemDiskContextProvider,
  createFilesystemTemplateProvider,
} from "./sources/reconstruction.js";

const sessionRef = {
  source: z.enum(["claude-code", "codex"]).describe("Which harness the session came from"),
  sessionId: z.string().describe("Session UUID (from briefing.topSessions / find_patterns hits)"),
};

/** Every insight response already carries `_meta`; this just serializes it as the MCP text block. */
function insightText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** JSON payload for the diagnostic wire tools, stamped with `sourceCompleteness` (their raw-source contract). */
function jsonResult<T extends object>(value: T, kinds: SourceKind[]) {
  const payload = { ...value, sourceCompleteness: buildSourceCompleteness(kinds) };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** The wire-capture tools declare both the log (for the requestId join) and the capture (for the bytes). */
const CAPTURE_KINDS: SourceKind[] = ["claude-session-jsonl", "claude-wire-capture"];

function notFound(sessionId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Session not found: ${sessionId}. Discover session ids via briefing (topSessions) or find_patterns.`,
      },
    ],
    isError: true,
  };
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Turn a bare-`repo` ambiguity into an actionable tool error listing the
 * candidate repoRoots — shared by `briefing`/`find_patterns`, whose `repo`
 * param accepts a bare name (see `resolveRepoParam` in insight.ts). Re-throws
 * anything else so genuine failures still surface.
 */
function ambiguousRepoError(err: unknown) {
  if (err instanceof AmbiguousRepoError) {
    return toolError(
      `${err.message}\nRe-run with repo set to one of: ${err.candidates.join(", ")}`,
    );
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Evidence shaping — the truncation contract every drill-down field uses: a
// value that got cut always says so via a `*Truncated` flag plus the field's
// untruncated char count, never a silently shorter string.
// ---------------------------------------------------------------------------

const EVIDENCE_MAX_CHARS_CONCISE = 4000;
const EVIDENCE_MAX_CHARS_FULL = 30000;
const EVIDENCE_TOOL_CALLS_DEFAULT_LIMIT = 50;
const EVIDENCE_TOOL_CALLS_MAX_LIMIT = 200;

function maxCharsFor(detail: Detail | undefined): number {
  return detail === "full" ? EVIDENCE_MAX_CHARS_FULL : EVIDENCE_MAX_CHARS_CONCISE;
}

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

/** The text-bearing fields of one `RecordDetail`, by kind — exactly the fields `record` evidence may cap. */
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
    case "api-error":
      return detail.message !== undefined ? [{ key: "message", value: detail.message }] : [];
    default:
      return [];
  }
}

/** Per-field TRUE length when it differs from the field's own `.length` (parser-capped result/return text). */
function trueLengthsOf(detail: RecordDetail): Record<string, number> {
  if (detail.kind === "tool-call" && detail.resultTextFullCharCount !== undefined) {
    return { resultText: detail.resultTextFullCharCount };
  }
  if (detail.kind === "subagent-launch" && detail.returnedTextFullCharCount !== undefined) {
    return { returnedText: detail.returnedTextFullCharCount };
  }
  return {};
}

/** Cap `detail`'s text fields to `maxChars`, flagging any that was cut or already short of its true length. */
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

/** One `tool_calls` evidence row. `family`/`subcommand` are set only for Bash/shell calls. */
interface ToolCallListItem {
  toolUseId: string;
  line: number;
  timestamp?: string;
  toolName: string;
  thread: string;
  status: "ok" | "error" | "missing-result";
  inputChars: number;
  resultChars: number;
  durationMs?: number;
  inputSummary: string;
  family?: string;
  subcommand?: string;
}

const UNPARSED_BASH_FAMILY = "(unparsed)";

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

/** Every thread's `SessionData` a Claude `tool_calls` fetch needs, per its `thread` filter. */
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

/** Does `agentId` name a real subagent of this Claude Code session? */
async function claudeSubagentExists(sessionId: string, agentId: string): Promise<boolean> {
  const mainData = await getSessionData(sessionId);
  if (mainData === undefined || mainData.filePath === undefined) return false;
  const store = claudeStoreForFilePath(mainData.filePath);
  const refs = await listSubagentRefs(mainData.filePath, store);
  return refs.some((ref) => ref.agentId === agentId);
}

// ---------------------------------------------------------------------------
// get_evidence fetchers — the injected getters `selectEvidence` (core) fans a
// single request out to. A harness that doesn't expose a kind simply omits its
// fetcher, and the facade reports that kind `notAvailable` (never throws).
// ---------------------------------------------------------------------------

function shapeToolCallDetail(
  sessionId: string,
  source: "claude-code" | "codex",
  detail: ToolCallDetail,
  maxChars: number,
) {
  const cappedInput = capInputField(detail.call.input, maxChars);
  const cappedResult =
    detail.result === null
      ? undefined
      : capTextField(detail.result.text, maxChars, detail.result.fullTextLength);
  return {
    sessionId,
    source,
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
            ...(detail.result.timestamp !== undefined && { timestamp: detail.result.timestamp }),
          },
    resultMissing: detail.resultMissing,
    relatedRecords: detail.relatedRecords,
  };
}

/** Build the evidence fetcher bundle for one resolved session (only the kinds its harness supports). */
function buildEvidenceFetchers(source: "claude-code" | "codex"): EvidenceFetchers {
  return {
    async record({ sessionId, line, agentId, detail }) {
      const record =
        source === "codex"
          ? await getCodexSessionRecordDetail(sessionId, line)
          : await getSessionRecordDetail(sessionId, line, agentId);
      if (record === undefined) return { line, missing: true };
      const capped = truncateRecordDetail(record, maxCharsFor(detail));
      return {
        line,
        detail: capped.detail,
        contentTruncated: capped.contentTruncated,
        ...(capped.originalCharCount !== undefined && {
          originalCharCount: capped.originalCharCount,
        }),
      };
    },
    async toolCall({ sessionId, toolUseId, agentId, detail }) {
      const found =
        source === "codex"
          ? await getCodexSessionToolCallDetail(sessionId, toolUseId)
          : await getSessionToolCallDetail(sessionId, toolUseId, agentId);
      if (found === undefined) return { toolUseId, missing: true };
      return shapeToolCallDetail(sessionId, source, found, maxCharsFor(detail));
    },
    async toolCalls({ sessionId, toolName, limit, agentId }) {
      const lim = Math.min(
        limit ?? EVIDENCE_TOOL_CALLS_DEFAULT_LIMIT,
        EVIDENCE_TOOL_CALLS_MAX_LIMIT,
      );
      // Always walk every thread; an agentId (Claude only) is applied as a
      // post-filter below so a subagent's own calls are reachable.
      const items: ToolCallListItem[] = [];
      if (source === "codex") {
        const codexThreads = await collectCodexToolCallThreads(sessionId, "all");
        if (codexThreads === undefined) return { toolCalls: [], totalCount: 0 };
        for (const { thread: threadId, records } of codexThreads) {
          for (const record of records) {
            if (toolName !== undefined && record.toolName !== toolName) continue;
            items.push(toCodexToolCallItem(threadId, record));
          }
        }
      } else {
        const threads = await collectToolCallThreads(sessionId, "all");
        if (threads === undefined) return { toolCalls: [], totalCount: 0 };
        for (const { thread: threadId, data } of threads) {
          for (const call of data.toolCalls) {
            if (agentId !== undefined && threadId !== agentId) continue;
            if (toolName !== undefined && call.name !== toolName) continue;
            items.push(toToolCallItem(threadId, call));
          }
        }
      }
      items.sort((a, b) =>
        a.line !== b.line ? a.line - b.line : a.thread.localeCompare(b.thread),
      );
      return { totalCount: items.length, toolCalls: items.slice(0, lim) };
    },
    async firstPrompt({ sessionId }) {
      const analysis =
        source === "codex" ? await getCodexSession(sessionId) : await getSession(sessionId);
      if (analysis === undefined) return { missing: true };
      return {
        firstUserPrompt: analysis.firstUserPrompt ?? null,
        title: analysis.title ?? null,
        userTurnCount: analysis.userTurnCount,
      };
    },
    // taskExecutions is Claude-only — omit the fetcher for Codex so the facade
    // reports it `notAvailable` rather than fabricating an empty list.
    ...(source === "claude-code" && {
      async taskExecutions({ sessionId }: { sessionId: string }) {
        const analysis = await getSession(sessionId);
        if (analysis === undefined) return { missing: true };
        return { taskExecutions: analysis.taskExecutions };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// inspect_wire — reconstruction shaping (mode: "reconstructed").
// ---------------------------------------------------------------------------

const RECONSTRUCT_DEFAULT_MAX_CHARS = 20000;
const RECONSTRUCT_MIN_MAX_CHARS = 200;
const ACTUAL_DEFAULT_MAX_CHARS = 30000;
const ACTUAL_MIN_MAX_CHARS = 200;

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

// ---------------------------------------------------------------------------
// export_trace — evaluation-trace event capping (same explicit contract).
// ---------------------------------------------------------------------------

const TRACE_DEFAULT_MAX_EVENTS = 500;
const TRACE_MAX_MAX_EVENTS = 5000;
const TRACE_DEFAULT_MAX_CHARS = 4000;
const TRACE_MIN_MAX_CHARS = 200;

const TRACE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "gen_ai.user.message": ["text"],
  "gen_ai.assistant.message": ["text"],
  "gen_ai.tool.result": ["text"],
  "junrei.injected_context": ["text"],
  "junrei.subagent_launch": ["prompt", "returnedText"],
};
const TRACE_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "gen_ai.tool.call": ["input"],
};

function cappedTraceEvent(event: EvaluationTraceEvent, maxChars: number): EvaluationTraceEvent {
  const attributes: Record<string, unknown> = { ...event.attributes };
  for (const field of TRACE_TEXT_FIELDS[event.name] ?? []) {
    const value = attributes[field];
    if (typeof value !== "string") continue;
    const capped = capTextField(value, maxChars);
    attributes[field] = capped.text;
    attributes[`${field}Truncated`] = capped.truncated;
    if (capped.fullCharCount !== undefined)
      attributes[`${field}FullCharCount`] = capped.fullCharCount;
  }
  for (const field of TRACE_INPUT_FIELDS[event.name] ?? []) {
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
// Tool descriptions — kept at onboarding density but tight (a schema-size
// guard test caps the total). Each names when to use it, the typical loop
// position, and what comes back.
// ---------------------------------------------------------------------------

const BRIEFING_DESCRIPTION =
  "START HERE. The morning paper for a repo (or all repos): a conclusion-first roll-up of the last " +
  "`days` days. Returns a period `summary` (cost, sessions, cacheHitRate, delegationShare — each with a " +
  "previous-window delta — plus an archetypeDistribution and contextLifetimeWarnings count), a " +
  "dollar-ranked `waste[]` of things to fix (each with a copy-ready `fix` and " +
  "`provenance.sessionId`), `wins[]` (delegation patterns that are working), the current learning-ledger " +
  "standing, and `topSessions` by cost. Typical loop: briefing -> analyze_session on the top waste item's " +
  "session -> log_learning. `_meta.nextSteps` always says what to call next. `repo` is a normalized repo " +
  "key (a repoRoot path from a session, or a fallback bucket key); omit for all repos.";

const ANALYZE_SESSION_DESCRIPTION =
  "The why, for ONE session: a headline `summary` (with its cost-share `archetype`), `costDrivers` (which " +
  "threads/models spent the money), the same dollar-ranked `waste[]` shape briefing uses, a `delegation` " +
  "health read (turnBudget + opusMessageShare), a `contextLifetime` read, and `recommendations[]` — " +
  "each carrying a ready-to-submit `logLearningCall` object so acting on it is a single log_learning call. " +
  "With `detail: 'full'` it also returns `whatIf[]`: model-based counterfactual savings from compacting " +
  "at a context threshold or evicting heavy tool results (projections, never billed amounts). " +
  "Use it after briefing flags a session, or on any session id you want to understand. Works for both " +
  "harnesses (Codex marks repetitions/taskExecutions `notAvailable`). Follow up with get_evidence to quote " +
  "the underlying tool call, or log_learning to record a fix.";

const FIND_PATTERNS_DESCRIPTION =
  "Cross-session search, three kinds. `text`: full-text search over transcripts (pass `query`) — find WHICH " +
  "sessions mentioned something. `delegation`: group sessions by delegation SHAPE (subagent-count bucket × " +
  "model mix) and report each shape's avg cost / return size — which way of delegating is cheap vs. " +
  "expensive. `waste`: roll up waste findings by class across sessions — what you keep wasting money on. Use " +
  "it to generalize a single-session finding into a pattern before logging a learning. `repo` scopes it; " +
  "`days` sets the window (default 14).";

const GET_EVIDENCE_DESCRIPTION =
  "The drill-down: fetch exact evidence for one session through a single `select` shape. Types: `record` " +
  "(one 1-based JSONL line's full detail), `tool_call` (one call+result by toolUseId), `tool_calls` " +
  "(filterable listing to discover a toolUseId), `first_prompt` (the original task), `task_executions` " +
  "(Claude only). Use it to quote ground-truth back to the user for a waste finding or recommendation from " +
  "analyze_session. A kind a harness can't provide comes back `notAvailable` (never an error). For a Claude " +
  "session, `agentId` scopes the lookup into one subagent's own transcript. `detail: 'full'` raises the " +
  "per-field truncation cap.";

const LOG_LEARNING_DESCRIPTION =
  "Record (or update) a learning in the repo-local ledger under `<repoRoot>/.junrei/learnings/` — an UPSERT. " +
  "Create: omit `id`, pass `finding` + `change` — an analyze_session recommendation's `logLearningCall` " +
  "object is accepted VERBATIM (pass it as the call's arguments, `sourceSessions` included) so its " +
  "provenance is preserved exactly; the repoRoot is `repoPath` if given, else derived from the FIRST " +
  "`sourceSessions` entry's cwd, else the top-level `source`+`sessionId` session's cwd. `sourceSessions` " +
  "wins over `source`+`sessionId` when both are given (that pair is merged in if it isn't already one of " +
  "the array's entries). Update: pass the `id` plus a `status` transition (open -> applied -> " +
  "verified/rejected — applied stamps appliedAt, verified/rejected stamps resolvedAt) and/or a " +
  "`verification` measurement. This is the ONLY tool that writes a learning. Returns the saved learning, " +
  "its file path, and nextSteps for closing the loop (apply -> review_learnings -> verify).";

const REVIEW_LEARNINGS_DESCRIPTION =
  "The did-it-help step: read-only listing of a repo's open + applied learnings, with a COMPUTED before/after " +
  "metric comparison attached to each applied learning (cost/day, delegationShare, cacheHitRate, bash spend — " +
  "the `windowDays` window on each side of its appliedAt, from the repo's cost trend). It NEVER writes a " +
  "status; it hands you a `suggestedVerification` candidate to judge and then record via log_learning " +
  "(status: verified/rejected). `repoPath` is an absolute repoRoot; omit to scan every known repo's ledger.";

const INSPECT_WIRE_DESCRIPTION =
  "DIAGNOSTIC (Claude Code only). Inspect the real Anthropic /v1/messages wire for one session by `mode`: " +
  "`reconstructed` rebuilds a main-loop request's payload from the log (+ optional local templates) with a " +
  "per-block confidence class — call with neither requestId nor line for the discovery listing; `actual` " +
  "returns the opt-in wire-capture proxy's captured request/response for a `requestId` (ground truth, " +
  "measured latency); `hidden` lists captured calls whose requestId never appears in the session log " +
  "(structural undercount evidence). Declared non-errors when a channel is absent (captureAvailable/…: false).";

const EXPORT_TRACE_DESCRIPTION =
  "DIAGNOSTIC (Claude Code only). Export one session as a normalized `junrei-evaluation-trace/v1` document " +
  "(session + enrichment + limitations + OTel-GenAI-semconv events) for external eval pipelines / LLM-judges. " +
  "This is a capped view for a chat context; GET /api/sessions/claude-code/:id/evaluation-trace returns the " +
  "same trace uncapped. `maxEvents`/`maxCharsPerField` bound the response with explicit truncation flags.";

/**
 * Junrei's MCP server — the six-tool self-improvement loop, plus two opt-in
 * diagnostic tools (registered only under `JUNREI_DIAGNOSTICS=1`).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "junrei", version: "0.2.0" });

  // -------------------------------------------------------------------------
  // briefing
  // -------------------------------------------------------------------------
  server.registerTool(
    "briefing",
    {
      description: BRIEFING_DESCRIPTION,
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe(
            "Repo to scope to: a bare repo name (e.g. 'junrei'), an absolute repoRoot path, or a fallback bucket key; omit for all repos. A bare name matching several repos returns the candidates to disambiguate.",
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Lookback window in days (default 7)"),
        detail: z
          .enum(["concise", "full"])
          .optional()
          .describe("concise trims lists to headline entries (default); full returns everything"),
      },
    },
    async ({ repo, days, detail }) => {
      try {
        return insightText(
          await buildRepoBriefing({
            ...(repo !== undefined && { repo }),
            ...(days !== undefined && { days }),
            ...(detail !== undefined && { detail }),
          }),
        );
      } catch (err) {
        return ambiguousRepoError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // analyze_session
  // -------------------------------------------------------------------------
  server.registerTool(
    "analyze_session",
    {
      description: ANALYZE_SESSION_DESCRIPTION,
      inputSchema: {
        ...sessionRef,
        detail: z
          .enum(["concise", "full"])
          .optional()
          .describe("concise trims waste/cost-driver lists (default); full returns everything"),
      },
    },
    async ({ source, sessionId, detail }) => {
      const insight = await buildSessionInsightFor({
        source,
        sessionId,
        ...(detail !== undefined && { detail }),
      });
      return insight === undefined ? notFound(sessionId) : insightText(insight);
    },
  );

  // -------------------------------------------------------------------------
  // find_patterns
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_patterns",
    {
      description: FIND_PATTERNS_DESCRIPTION,
      inputSchema: {
        kind: z
          .enum(["text", "delegation", "waste"])
          .describe(
            "text = full-text search; delegation = shape aggregation; waste = waste-class rollup",
          ),
        query: z.string().optional().describe("Substring to find — required for kind: 'text'"),
        repo: z
          .string()
          .optional()
          .describe(
            "Repo to scope to: a bare repo name, an absolute repoRoot path, or a fallback bucket key; omit for all repos",
          ),
        days: z.number().int().min(1).max(90).optional().describe("Window in days (default 14)"),
        detail: z
          .enum(["concise", "full"])
          .optional()
          .describe("concise caps the list (default); full is fuller"),
      },
    },
    async ({ kind, query, repo, days, detail }) => {
      if (kind === "text" && (query === undefined || query.trim() === "")) {
        return toolError("kind: 'text' requires a non-empty `query`.");
      }
      try {
        return insightText(
          await findPatternsFor({
            kind: kind as PatternKind,
            ...(query !== undefined && { query }),
            ...(repo !== undefined && { repo }),
            ...(days !== undefined && { days }),
            ...(detail !== undefined && { detail }),
          }),
        );
      } catch (err) {
        return ambiguousRepoError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_evidence
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_evidence",
    {
      description: GET_EVIDENCE_DESCRIPTION,
      inputSchema: {
        ...sessionRef,
        select: z
          .object({
            type: z.enum(["record", "tool_call", "tool_calls", "first_prompt", "task_executions"]),
            line: z.number().int().min(1).optional().describe("record: 1-based JSONL line"),
            toolUseId: z.string().optional().describe("tool_call: the call's toolUseId"),
            toolName: z.string().optional().describe("tool_calls: exact tool name filter"),
            limit: z
              .number()
              .int()
              .min(1)
              .max(EVIDENCE_TOOL_CALLS_MAX_LIMIT)
              .optional()
              .describe("tool_calls: max rows"),
          })
          .describe("What to fetch — one of the five evidence kinds, with its own args"),
        agentId: z
          .string()
          .optional()
          .describe(
            "Claude only: scope into this subagent's own transcript (from a tool_calls `thread`)",
          ),
        detail: z
          .enum(["concise", "full"])
          .optional()
          .describe("full raises the per-field truncation cap"),
      },
    },
    async ({ source, sessionId, select, agentId, detail }) => {
      // Resolve the session up front so a bad id / agentId fails clearly,
      // before the facade fans the request out to a fetcher.
      const analysis =
        source === "codex" ? await getCodexSession(sessionId) : await getSession(sessionId);
      if (analysis === undefined) return notFound(sessionId);
      if (agentId !== undefined) {
        if (source === "codex") {
          return toolError(
            "agentId is not supported for Codex sessions: a Codex sub-agent is its own full session — " +
              "call get_evidence with that sub-agent's own sessionId.",
          );
        }
        if (!(await claudeSubagentExists(sessionId, agentId))) {
          return toolError(
            `Subagent not found in this session: ${agentId}. agentId comes from a tool_calls \`thread\`.`,
          );
        }
      }

      const selectArg = {
        type: select.type,
        ...(select.type === "record" && { line: select.line ?? 1 }),
        ...(select.type === "tool_call" && { toolUseId: select.toolUseId ?? "" }),
        ...(select.type === "tool_calls" && {
          ...(select.toolName !== undefined && { toolName: select.toolName }),
          ...(select.limit !== undefined && { limit: select.limit }),
        }),
      } as EvidenceSelect;

      if (select.type === "record" && select.line === undefined) {
        return toolError("select.type 'record' requires `select.line`.");
      }
      if (
        select.type === "tool_call" &&
        (select.toolUseId === undefined || select.toolUseId === "")
      ) {
        return toolError("select.type 'tool_call' requires `select.toolUseId`.");
      }

      const result = await selectEvidence(
        {
          source,
          sessionId,
          select: selectArg,
          ...(agentId !== undefined && { agentId }),
          ...(detail !== undefined && { detail }),
        },
        buildEvidenceFetchers(source),
      );
      return insightText(result);
    },
  );

  // -------------------------------------------------------------------------
  // log_learning (upsert)
  // -------------------------------------------------------------------------
  server.registerTool(
    "log_learning",
    {
      description: LOG_LEARNING_DESCRIPTION,
      inputSchema: {
        repoPath: z
          .string()
          .optional()
          .describe(
            "Absolute repoRoot the ledger lives under; else derived from the source session's cwd",
          ),
        source: z
          .enum(["claude-code", "codex"])
          .optional()
          .describe("Source session's harness (with sessionId)"),
        sessionId: z
          .string()
          .optional()
          .describe("Source session id — attaches provenance + resolves repoRoot"),
        sourceSessions: z
          .array(
            z.object({
              source: z.enum(["claude-code", "codex"]),
              sessionId: z.string(),
              title: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            "Full provenance list — pass an analyze_session recommendation's " +
              "`logLearningCall.sourceSessions` VERBATIM to preserve every contributing session. " +
              "Wins over `source`+`sessionId` when both are given (that pair is merged in if it " +
              "isn't already one of the array's entries); also resolves repoRoot from its first " +
              "entry's session cwd when `repoPath` is omitted.",
          ),
        id: z
          .string()
          .optional()
          .describe("Existing learning id to UPDATE; omit to create a new one"),
        finding: z.string().optional().describe("What was observed (required on create)"),
        change: z.string().optional().describe("What to change in response (required on create)"),
        expectedEffect: z.string().optional().describe("What the change should improve"),
        status: z
          .enum(["open", "applied", "verified", "rejected"])
          .optional()
          .describe(
            "Lifecycle status — applied stamps appliedAt, verified/rejected stamps resolvedAt",
          ),
        verification: z
          .object({
            metric: z.string(),
            before: z.number(),
            after: z.number(),
            windowDays: z.number(),
            note: z.string().optional(),
          })
          .optional()
          .describe(
            "Before/after measurement (typically from review_learnings' suggestedVerification)",
          ),
        proposedBy: z
          .enum(["agent", "human"])
          .optional()
          .describe("Who proposed it (default agent)"),
      },
    },
    async (args) => {
      // Zod's `.optional()` infers `title?: string | undefined`, which
      // `exactOptionalPropertyTypes` rejects against `LearningSource`'s
      // `title?: string` — normalize away an explicit `undefined` before merging.
      const normalizedSourceSessions: LearningSource[] | undefined = args.sourceSessions?.map(
        (s) => ({
          source: s.source,
          sessionId: s.sessionId,
          ...(s.title !== undefined && { title: s.title }),
        }),
      );
      const sourceSessions: LearningSource[] = mergeLearningSourceSessions({
        ...(normalizedSourceSessions !== undefined && {
          sourceSessions: normalizedSourceSessions,
        }),
        ...(args.source !== undefined && { source: args.source }),
        ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
      });
      const repoRoot = await resolveLearningRepoRoot({
        ...(args.repoPath !== undefined && { repoPath: args.repoPath }),
        sourceSessions,
      });
      if (repoRoot === undefined) {
        return toolError(
          "Could not resolve a repo root for this learning — pass `repoPath` (an absolute repoRoot), " +
            "or `source` + `sessionId` (or `sourceSessions`) so it can be derived from the session's cwd.",
        );
      }

      if (args.id === undefined) {
        if (args.finding === undefined || args.change === undefined) {
          return toolError(
            "Creating a learning requires both `finding` and `change` (or pass `id` to update).",
          );
        }
        const learning = await createLearning(repoRoot, {
          finding: args.finding,
          change: args.change,
          ...(args.expectedEffect !== undefined && { expectedEffect: args.expectedEffect }),
          ...(args.status !== undefined && { status: args.status }),
          ...(args.proposedBy !== undefined && { proposedBy: args.proposedBy }),
          ...(sourceSessions.length > 0 && { sourceSessions }),
        });
        const payload = {
          learning,
          created: true,
          path: join(repoRoot, ".junrei", "learnings", `${learning.id}.json`),
        };
        return insightText({
          ...payload,
          _meta: buildMeta(payload, {
            nextSteps: [
              "Apply the change, then call log_learning again with this id + status: 'applied'.",
              "Later, call review_learnings to see the computed before/after comparison.",
            ],
          }),
        });
      }

      let learning: Awaited<ReturnType<typeof updateLearning>>;
      try {
        learning = await updateLearning(repoRoot, args.id, {
          ...(args.status !== undefined && { status: args.status }),
          ...(args.finding !== undefined && { finding: args.finding }),
          ...(args.change !== undefined && { change: args.change }),
          ...(args.expectedEffect !== undefined && { expectedEffect: args.expectedEffect }),
          ...(args.verification !== undefined && {
            verification: args.verification as LearningVerification,
          }),
          ...(sourceSessions.length > 0 && { sourceSessions }),
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
      const payload = {
        learning,
        created: false,
        path: join(repoRoot, ".junrei", "learnings", `${learning.id}.json`),
      };
      return insightText({
        ...payload,
        _meta: buildMeta(payload, {
          nextSteps:
            learning.status === "applied"
              ? [
                  "Once enough time has passed, call review_learnings for the before/after, then verify/reject.",
                ]
              : ["Call review_learnings to see this repo's ledger standing."],
        }),
      });
    },
  );

  // -------------------------------------------------------------------------
  // review_learnings
  // -------------------------------------------------------------------------
  server.registerTool(
    "review_learnings",
    {
      description: REVIEW_LEARNINGS_DESCRIPTION,
      inputSchema: {
        repoPath: z
          .string()
          .optional()
          .describe("Absolute repoRoot; omit to scan every known repo's ledger"),
        repo: z
          .string()
          .optional()
          .describe("Normalized repo key (used as a repoRoot only when it's an absolute path)"),
        status: z
          .enum(["open", "applied", "verified", "rejected"])
          .optional()
          .describe("Filter to one status; default returns open + applied"),
        windowDays: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Before/after comparison window (default 14)"),
      },
    },
    async ({ repoPath, repo, status, windowDays }) => {
      const result = await reviewLearningsFor({
        ...(repoPath !== undefined && { repoPath }),
        ...(repo !== undefined && { repo }),
        ...(status !== undefined && { status: status as LearningStatus }),
        ...(windowDays !== undefined && { windowDays }),
      });
      const payload = {
        learnings: result.learnings,
        windowDays: result.windowDays,
        warnings: result.warnings,
      };
      const applied = result.learnings.filter((l) => l.comparison !== undefined).length;
      return insightText({
        ...payload,
        _meta: buildMeta(payload, {
          nextSteps:
            applied > 0
              ? [
                  "Judge each applied learning's before/after, then log_learning (status: verified/rejected) to record it.",
                ]
              : [
                  "No applied learnings with a computed window yet — apply an open one via log_learning first.",
                ],
        }),
      });
    },
  );

  registerDiagnostics(server);
  return server;
}

/**
 * The opt-in diagnostic tools — only registered under `JUNREI_DIAGNOSTICS=1`.
 * Read at connect time (a fresh server per request) so toggling the env var
 * takes effect on the next MCP request with no restart, the same "read env at
 * call time" convention the OTel/reconstruction providers use.
 */
function registerDiagnostics(server: McpServer): void {
  if (process.env.JUNREI_DIAGNOSTICS !== "1") return;

  server.registerTool(
    "inspect_wire",
    {
      description: INSPECT_WIRE_DESCRIPTION,
      inputSchema: {
        ...sessionRef,
        mode: z
          .enum(["reconstructed", "actual", "hidden"])
          .describe(
            "reconstructed = rebuilt from log; actual = captured wire; hidden = uncounted captured calls",
          ),
        requestId: z.string().optional().describe("reconstructed/actual: the request to inspect"),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("reconstructed: target assistant line (alt to requestId)"),
        maxCharsPerField: z
          .number()
          .int()
          .min(RECONSTRUCT_MIN_MAX_CHARS)
          .optional()
          .describe("Per-field cap (reconstructed default 20000, actual default 30000)"),
      },
    },
    async (args) => {
      if (args.source === "codex") {
        return toolError(
          "inspect_wire is Claude Code only — wire capture/reconstruction are Claude-specific.",
        );
      }
      if (args.mode === "reconstructed") return inspectReconstructed(args);
      if (args.mode === "actual") return inspectActual(args);
      return inspectHidden(args);
    },
  );

  server.registerTool(
    "export_trace",
    {
      description: EXPORT_TRACE_DESCRIPTION,
      inputSchema: {
        ...sessionRef,
        maxEvents: z
          .number()
          .int()
          .min(1)
          .max(TRACE_MAX_MAX_EVENTS)
          .optional()
          .describe(`Cap on events, source-line ordered (default ${TRACE_DEFAULT_MAX_EVENTS})`),
        maxCharsPerField: z
          .number()
          .int()
          .min(TRACE_MIN_MAX_CHARS)
          .optional()
          .describe(`Per text-attribute cap (default ${TRACE_DEFAULT_MAX_CHARS})`),
      },
    },
    async (args) => {
      if (args.source === "codex") {
        return toolError(
          "export_trace is Claude Code only — the trace merges Claude-specific channels.",
        );
      }
      const trace = await assembleEvaluationTrace(args.sessionId);
      if (trace === undefined) return notFound(args.sessionId);
      const maxEvents = args.maxEvents ?? TRACE_DEFAULT_MAX_EVENTS;
      const maxChars = args.maxCharsPerField ?? TRACE_DEFAULT_MAX_CHARS;
      const totalEvents = trace.events.length;
      const events = trace.events
        .slice(0, maxEvents)
        .map((event) => cappedTraceEvent(event, maxChars));
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
            "Capped view for a chat context. GET /api/sessions/claude-code/" +
            `${args.sessionId}/evaluation-trace returns this SAME trace uncapped.`,
        },
        trace.sourceCompleteness.sources.map((s) => s.source),
      );
    },
  );
}

type InspectWireArgs = {
  source: "claude-code" | "codex";
  sessionId: string;
  requestId?: string | undefined;
  line?: number | undefined;
  maxCharsPerField?: number | undefined;
};

async function inspectReconstructed(args: InspectWireArgs) {
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
        mode: "reconstructed" as const,
        requests: listReconstructableRequests(input.records),
      },
      ["claude-session-jsonl"],
    );
  }

  const target: string | number = args.requestId ?? (args.line as number);
  const maxChars = args.maxCharsPerField ?? RECONSTRUCT_DEFAULT_MAX_CHARS;
  const providers: ReconstructionProviders = {
    template: createFilesystemTemplateProvider(),
    diskContext: createFilesystemDiskContextProvider({ projectDirName: ref.projectDirName }),
  };
  const reconstructed = await reconstructRequest(input, target, providers);
  if (reconstructed === undefined) {
    return toolError(
      `No reconstructable request found for ${
        typeof target === "string" ? `requestId "${target}"` : `line ${target}`
      } in session ${args.sessionId}. Call inspect_wire (mode: 'reconstructed') with neither requestId nor line to list them.`,
    );
  }
  return jsonResult(
    {
      sessionId: args.sessionId,
      source: "claude-code" as const,
      mode: "reconstructed" as const,
      ...cappedReconstructedRequest(reconstructed, maxChars),
    },
    ["claude-session-jsonl"],
  );
}

const CAPTURE_UNAVAILABLE_NOTE =
  "wire capture is opt-in — start junrei-capture-proxy and route Claude Code through it (README 'Wire capture').";

async function inspectActual(args: InspectWireArgs) {
  if (args.requestId === undefined) {
    return toolError("inspect_wire (mode: 'actual') requires a `requestId`.");
  }
  const maxChars = args.maxCharsPerField ?? ACTUAL_DEFAULT_MAX_CHARS;
  if (maxChars < ACTUAL_MIN_MAX_CHARS) {
    return toolError(`maxCharsPerField must be at least ${ACTUAL_MIN_MAX_CHARS}.`);
  }
  const store = createFilesystemCaptureStore();
  const lookup = await store.readSessionCaptures(args.sessionId);
  if (!lookup.available) {
    return jsonResult(
      {
        sessionId: args.sessionId,
        source: "claude-code" as const,
        mode: "actual" as const,
        captureAvailable: false,
        note: CAPTURE_UNAVAILABLE_NOTE,
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
        mode: "actual" as const,
        captureAvailable: true,
        requestNotCaptured: true,
        requestId: args.requestId,
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
      mode: "actual" as const,
      captureAvailable: true,
      requestId: args.requestId,
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
}

async function inspectHidden(args: InspectWireArgs) {
  const store = createFilesystemCaptureStore();
  const lookup = await store.readSessionCaptures(args.sessionId);
  if (!lookup.available) {
    return jsonResult(
      {
        sessionId: args.sessionId,
        source: "claude-code" as const,
        mode: "hidden" as const,
        captureAvailable: false,
        note: CAPTURE_UNAVAILABLE_NOTE,
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
      mode: "hidden" as const,
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
}
