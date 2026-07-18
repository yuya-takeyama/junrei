/**
 * Evaluation-trace export (Goshuin milestone, Phase F — see
 * docs/milestones/goshuin.md, "F. Evaluation-trace export + analysis
 * playbooks"). Merges the session log (always present) with the opt-in OTel
 * and wire-capture side channels into ONE normalized, OTel-GenAI-semconv-
 * flavored event stream — `junrei-evaluation-trace/v1` — for external eval
 * pipelines and LLM-judges that want a single JSON document instead of many
 * MCP round-trips.
 *
 * PURE FUNCTION OVER PROVIDED INPUTS: this module never touches `node:fs` —
 * every read (session data, OTel lines, capture records, reconstruction)
 * happens in `@junrei/server` BEFORE calling `buildEvaluationTrace`, mirroring
 * `claude/otel.ts`'s "no node:fs in core" contract. In particular, the "full
 * tool_result text recovery" `get_records`/`get_tool_call` already perform
 * (undoing the parser's `TOOL_RESULT_TEXT_LIMIT` cap by re-reading the raw
 * source line — see `timeline.ts`'s `resolveFullResultText`) is NOT
 * reimplemented here: the server calls the existing `getClaudeToolCallDetail`
 * per tool call and passes the recovered text in as `recoveredResults`.
 *
 * DELIBERATE DESIGN CHOICES (documented here so they read as decisions, not
 * gaps found later):
 *
 *  1. Per-request enrichment (`gen_ai.request` events) carries a COMPACT
 *     reconstruction summary — confidence-class counts, `appliedRules`,
 *     `limitations` — never the full reconstructed system/tools/messages
 *     payload. A consumer that needs the actual bytes calls
 *     `get_reconstructed_request` (or the HTTP route) with the cited
 *     `requestId`. Inlining full payloads would repeat, per request, exactly
 *     the bytes that tool already serves on demand — for an eval pipeline
 *     that mostly wants the confidence/cost/latency SIGNAL across the whole
 *     session, that's bloat, not value.
 *
 *  2. OTel's `api_request` log event carries no attribute that joins to the
 *     session log's `requestId` — unlike wire capture, whose response
 *     `request-id` header IS the exact join key `get_actual_request`/
 *     `get_hidden_calls` use. No such per-request join exists in the data
 *     Claude Code's OTel export carries today, so this module does NOT
 *     attempt one (an ordinal or usage-fingerprint guess would be exactly
 *     the kind of invented correlation the Goshuin milestone's "no
 *     heuristics, deterministic joins only" principle forbids — see
 *     docs/milestones/goshuin.md's Decisions). OTel's contribution instead
 *     surfaces as a SESSION-LEVEL aggregate on `enrichment.otel` (the same
 *     figures `get_session_observability` reports) rather than a per-request
 *     field. Wire capture, which DOES have a deterministic join key, is
 *     joined per-request via `requestCaptures`/`hiddenCalls`.
 *
 *  3. Nested subagent trees are NOT merged into one trace: a
 *     `junrei.subagent_launch` event summarizes the launch (cost, tokens,
 *     status — the same fields `get_subagent_tree` reports for that node),
 *     but the subagent's OWN tool calls/messages stay in its sidecar
 *     transcript. Call `buildEvaluationTrace` again with that subagent's own
 *     `SessionData` for its own trace — today's `inputs.subagents` only
 *     covers direct (top-level) launches from the exported transcript.
 */

import {
  buildSourceCompleteness,
  type SourceCompleteness,
  type SourceKind,
} from "../shared/completeness.js";
import { estimateCostUsd } from "../shared/pricing/pricing.js";
import type { SubagentNode } from "../shared/subagent-node.js";
import { durationBetween } from "../shared/timeline.js";
import type { TokenUsage } from "../shared/types.js";
import type { OtelCostSource } from "./otel.js";
import type { ConfidenceClass } from "./reconstruction/types.js";
import type { ApiMessage, SessionData, ToolCall } from "./session-data.js";

export const EVALUATION_TRACE_SCHEMA = "junrei-evaluation-trace/v1";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** Where a trace event's content came from — a source line, a request id, or (rarely) neither. */
export interface EvaluationTraceProvenance {
  /** 1-based source line in the session JSONL, when the event is log-anchored. */
  line?: number;
  /** The log's own `requestId`, when the event belongs to (or IS) one main-loop request. */
  requestId?: string;
}

/**
 * One trace event. `name` is either an OTel-GenAI-semconv-flavored name
 * (`gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.call`,
 * `gen_ai.tool.result`, `gen_ai.request`) or a `junrei.*` harness event
 * (`junrei.subagent_launch`, `junrei.task_notification`, `junrei.compaction`,
 * `junrei.api_error`, `junrei.injected_context`, `junrei.hidden_api_call`).
 * `attributes` carries the SAME content values the drill-down MCP tools serve
 * (uncapped here — capping, when needed, happens at the MCP-tool boundary
 * that shapes this into a response, same convention `get_reconstructed_request`
 * uses).
 */
export interface EvaluationTraceEvent {
  name: string;
  timestamp?: string;
  provenance: EvaluationTraceProvenance;
  attributes: Record<string, unknown>;
}

export interface EvaluationTraceSessionMeta {
  sessionId: string;
  cwd?: string;
  cliVersion?: string;
  startedAt?: string;
  endedAt?: string;
}

/** A channel's declared consultation state — NEVER silently absent (see module doc comment, design choice 2). */
export interface EvaluationTraceChannelDeclaration {
  /** Whether this export attempted to read the channel at all. */
  consulted: boolean;
  /** Whether the channel actually had data for this session (only meaningful when `consulted`). */
  available: boolean;
  note?: string;
}

export interface EvaluationTraceOtelEnrichment extends EvaluationTraceChannelDeclaration {
  /** Session-level authoritative cost, reusing `parseOtelSessionLines`'s own aggregate — see design choice 2 for why this isn't per-request. */
  costUsd?: number;
  costSource?: OtelCostSource;
  apiRequestCount?: number;
  durationMsAvg?: number;
}

export interface EvaluationTraceCaptureEnrichment extends EvaluationTraceChannelDeclaration {
  /** Present only when `consulted` — count of `junrei.hidden_api_call` events this trace carries. */
  hiddenCallCount?: number;
}

export interface EvaluationTraceEnrichment {
  otel: EvaluationTraceOtelEnrichment;
  captures: EvaluationTraceCaptureEnrichment;
}

export interface EvaluationTrace {
  schema: typeof EVALUATION_TRACE_SCHEMA;
  session: EvaluationTraceSessionMeta;
  sourceCompleteness: SourceCompleteness;
  enrichment: EvaluationTraceEnrichment;
  /** Declared, session-wide caveats (capped lists, unattempted recoveries, scope notes) — the trace-level analog of a reconstruction's `limitations`. */
  limitations: string[];
  events: EvaluationTraceEvent[];
}

// ---------------------------------------------------------------------------
// Input shape — everything already loaded by the caller (server)
// ---------------------------------------------------------------------------

/** A tool result's full text, recovered past the parser's capture cap — see `getClaudeToolCallDetail`. */
export interface EvaluationTraceRecoveredText {
  text: string;
  /** Present only when recovery itself fell short of the tool's true output — mirrors `ToolCallDetailResult.fullTextLength`'s "still short of the truth" contract. */
  fullTextLength?: number;
}

/** An agent- or skill-listing injection recovered from the raw log (see `reconstruction/attachments.ts`'s renderers) — absent entirely when not attempted (declared via `limitations`, never silently skipped). */
export interface EvaluationTraceInjectedContext {
  line: number;
  kind: "agent-listing" | "skill-listing";
  text: string;
}

/** A wire-capture record's per-request contribution, joined by `requestId` — the SAME deterministic join `get_actual_request` uses. */
export interface EvaluationTraceRequestCapture {
  requestId: string;
  latencyMs?: number;
  isSubagent?: boolean;
}

/** One captured request whose `requestId` never appears in the session log — see `get_hidden_calls`. */
export interface EvaluationTraceHiddenCall {
  requestId: string;
  path?: string;
  model?: string;
  usage?: unknown;
  latencyMs?: number;
  isSubagent?: boolean;
  requestBytes?: number;
  responseBytes?: number;
  /** Capture-side wall-clock start — the only ordering signal available for an event with no log line at all. */
  startedAt?: string;
}

/** A compact reconstruction summary for one main-loop request — see module doc comment, design choice 1. */
export interface EvaluationTraceReconstructionSummary {
  requestId?: string;
  targetLine: number;
  confidenceCounts: Record<ConfidenceClass, number>;
  appliedRules: string[];
  limitations: string[];
}

export interface EvaluationTraceInputs {
  session: EvaluationTraceSessionMeta;
  /** The MAIN transcript's structured data — see module doc comment, design choice 3 on why subagent transcripts aren't merged in. */
  data: SessionData;
  /** Top-level subagent launches (from `ClaudeSessionAnalysis.subagents`) — matched to their launching tool call by `toolUseId`. */
  subagents?: readonly SubagentNode[];
  /** toolUseId -> recovered full result/return text, computed via `getClaudeToolCallDetail` (or equivalent) by the caller. */
  recoveredResults?: Record<string, EvaluationTraceRecoveredText>;
  injectedContext?: readonly EvaluationTraceInjectedContext[];
  otel?: EvaluationTraceOtelEnrichment;
  captures?: EvaluationTraceChannelDeclaration;
  requestCaptures?: readonly EvaluationTraceRequestCapture[];
  hiddenCalls?: readonly EvaluationTraceHiddenCall[];
  reconstructionSummaries?: readonly EvaluationTraceReconstructionSummary[];
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

interface Positioned {
  event: EvaluationTraceEvent;
  /** 1-based source line, when the event is log-anchored (most events). */
  line?: number;
  /** Epoch ms, for the (rare) line-less event — see `orderEvents`. */
  tsMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolvedResultText(
  call: ToolCall,
  recovered: Record<string, EvaluationTraceRecoveredText>,
): { text: string; fullTextLength?: number } | undefined {
  if (call.result === undefined) return undefined;
  const rec = recovered[call.toolUseId];
  if (rec !== undefined) {
    return {
      text: rec.text,
      ...(rec.fullTextLength !== undefined && { fullTextLength: rec.fullTextLength }),
    };
  }
  return {
    text: call.result.text,
    ...(call.result.fullTextLength > call.result.text.length && {
      fullTextLength: call.result.fullTextLength,
    }),
  };
}

function buildToolEvents(
  call: ToolCall,
  requestId: string | undefined,
  recovered: Record<string, EvaluationTraceRecoveredText>,
): Positioned[] {
  const out: Positioned[] = [
    {
      event: {
        name: "gen_ai.tool.call",
        ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
        provenance: { line: call.line, ...(requestId !== undefined && { requestId }) },
        attributes: { toolUseId: call.toolUseId, name: call.name, input: call.input },
      },
      line: call.line,
    },
  ];
  if (call.result !== undefined) {
    const resolved = resolvedResultText(call, recovered);
    out.push({
      event: {
        name: "gen_ai.tool.result",
        ...(call.result.timestamp !== undefined && { timestamp: call.result.timestamp }),
        provenance: { line: call.result.line, ...(requestId !== undefined && { requestId }) },
        attributes: {
          toolUseId: call.toolUseId,
          isError: call.result.isError,
          text: resolved?.text ?? call.result.text,
          ...(resolved?.fullTextLength !== undefined && {
            fullTextLength: resolved.fullTextLength,
          }),
        },
      },
      line: call.result.line,
    });
  }
  return out;
}

function buildSubagentLaunchEvent(
  call: ToolCall,
  node: SubagentNode | undefined,
  requestId: string | undefined,
  recovered: Record<string, EvaluationTraceRecoveredText>,
): Positioned {
  const input = asRecord(call.input);
  const prompt = typeof input?.prompt === "string" ? input.prompt : undefined;
  const resolved = call.result !== undefined ? resolvedResultText(call, recovered) : undefined;
  const durationMs = node !== undefined ? durationBetween(node.startedAt, node.endedAt) : undefined;

  const attributes: Record<string, unknown> = {
    toolUseId: call.toolUseId,
    agentType:
      node?.agentType ??
      (typeof input?.subagent_type === "string" ? input.subagent_type : undefined),
    name:
      node?.description ?? (typeof input?.description === "string" ? input.description : undefined),
    ...(prompt !== undefined && { prompt }),
    ...(node?.agentId !== undefined && { agentId: node.agentId }),
    ...(node?.model !== undefined && { model: node.model }),
    ...(node?.status !== undefined && { status: node.status }),
    ...(node !== undefined && {
      outputTokens: node.usage.total.outputTokens,
      costUsd: node.usage.total.costUsd,
      costIsComplete: node.usage.total.costIsComplete,
      toolCallCount: node.toolCallCount,
      toolErrorCount: node.toolErrorCount,
    }),
    ...(durationMs !== undefined && { durationMs }),
    ...(resolved !== undefined && {
      returnedText: resolved.text,
      ...(resolved.fullTextLength !== undefined && {
        returnedTextFullCharCount: resolved.fullTextLength,
      }),
    }),
  };
  // Drop undefined leaves (agentType/name can legitimately resolve to undefined above).
  for (const key of Object.keys(attributes)) {
    if (attributes[key] === undefined) delete attributes[key];
  }

  return {
    event: {
      name: "junrei.subagent_launch",
      ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
      provenance: { line: call.line, ...(requestId !== undefined && { requestId }) },
      attributes,
    },
    line: call.line,
  };
}

/** Per-message pricing-table cost estimate — same formula every other cost-bearing tool uses, applied to one `ApiMessage`. */
function pricingEstimateOf(
  model: string | undefined,
  usage: TokenUsage | undefined,
): { costUsd: number; costIsComplete: boolean } {
  if (model === undefined || usage === undefined) return { costUsd: 0, costIsComplete: false };
  const costUsd = estimateCostUsd(model, usage);
  return costUsd === undefined
    ? { costUsd: 0, costIsComplete: false }
    : { costUsd, costIsComplete: true };
}

function buildRequestEvent(
  message: ApiMessage,
  requestId: string | undefined,
  requestCapture: EvaluationTraceRequestCapture | undefined,
  reconstruction: EvaluationTraceReconstructionSummary | undefined,
): Positioned {
  const attributes: Record<string, unknown> = {
    ...(requestId !== undefined && { requestId }),
    ...(message.model !== undefined && { model: message.model }),
    ...(message.usage !== undefined && { usage: message.usage }),
    pricingEstimate: pricingEstimateOf(message.model, message.usage),
    ...(requestCapture !== undefined && {
      capture: {
        ...(requestCapture.latencyMs !== undefined && { latencyMs: requestCapture.latencyMs }),
        ...(requestCapture.isSubagent !== undefined && { isSubagent: requestCapture.isSubagent }),
      },
    }),
    ...(reconstruction !== undefined && {
      reconstruction: {
        confidenceCounts: reconstruction.confidenceCounts,
        appliedRules: reconstruction.appliedRules,
        limitations: reconstruction.limitations,
        note: "compact summary only — call get_reconstructed_request with this requestId for the full payload",
      },
    }),
  };
  return {
    event: {
      name: "gen_ai.request",
      ...(message.timestamp !== undefined && { timestamp: message.timestamp }),
      provenance: { line: message.line, ...(requestId !== undefined && { requestId }) },
      attributes,
    },
    line: message.line,
  };
}

function buildHiddenCallEvent(hidden: EvaluationTraceHiddenCall): Positioned {
  const ms = hidden.startedAt !== undefined ? Date.parse(hidden.startedAt) : Number.NaN;
  return {
    event: {
      name: "junrei.hidden_api_call",
      ...(hidden.startedAt !== undefined && { timestamp: hidden.startedAt }),
      provenance: { requestId: hidden.requestId },
      attributes: {
        requestId: hidden.requestId,
        ...(hidden.path !== undefined && { path: hidden.path }),
        ...(hidden.model !== undefined && { model: hidden.model }),
        ...(hidden.usage !== undefined && { usage: hidden.usage }),
        ...(hidden.latencyMs !== undefined && { latencyMs: hidden.latencyMs }),
        ...(hidden.isSubagent !== undefined && { isSubagent: hidden.isSubagent }),
        ...(hidden.requestBytes !== undefined && { requestBytes: hidden.requestBytes }),
        ...(hidden.responseBytes !== undefined && { responseBytes: hidden.responseBytes }),
      },
    },
    ...(!Number.isNaN(ms) && { tsMs: ms }),
  };
}

/**
 * Order positioned events by source line first (the log's own order); a
 * line-less event (today: only `junrei.hidden_api_call`, which by definition
 * has no log line) is inserted by CHRONOLOGICAL INTERPOLATION between the two
 * line-anchored events its own timestamp falls between — never simply
 * appended, so a hidden call that happened mid-session reads mid-session, not
 * at the end. Falls back to the very end when no timestamp is available on
 * either side (still deterministic, still declared via `provenance.requestId`
 * — never silently reordered).
 */
function orderEvents(positioned: readonly Positioned[]): EvaluationTraceEvent[] {
  const lineItems = positioned
    .filter((p): p is Positioned & { line: number } => p.line !== undefined)
    .sort((a, b) => a.line - b.line);
  const looseItems = positioned.filter((p) => p.line === undefined);
  if (looseItems.length === 0) return lineItems.map((p) => p.event);

  const lineTimestamps: { line: number; ms: number }[] = [];
  for (const p of lineItems) {
    const ts = p.event.timestamp;
    const ms = ts !== undefined ? Date.parse(ts) : Number.NaN;
    if (!Number.isNaN(ms)) lineTimestamps.push({ line: p.line, ms });
  }

  const ranked: { event: EvaluationTraceEvent; sortKey: number }[] = lineItems.map((p) => ({
    event: p.event,
    sortKey: p.line,
  }));

  for (const p of looseItems) {
    const ms = p.tsMs;
    if (ms === undefined || lineTimestamps.length === 0) {
      ranked.push({ event: p.event, sortKey: Number.POSITIVE_INFINITY });
      continue;
    }
    const idx = lineTimestamps.findIndex((lt) => lt.ms >= ms);
    if (idx === -1) {
      const last = lineTimestamps[lineTimestamps.length - 1];
      ranked.push({ event: p.event, sortKey: (last?.line ?? 0) + 0.5 });
    } else if (idx === 0) {
      ranked.push({ event: p.event, sortKey: (lineTimestamps[0]?.line ?? 0) - 0.5 });
    } else {
      const before = lineTimestamps[idx - 1]?.line ?? 0;
      const after = lineTimestamps[idx]?.line ?? before;
      ranked.push({ event: p.event, sortKey: (before + after) / 2 });
    }
  }

  ranked.sort((a, b) => a.sortKey - b.sortKey);
  return ranked.map((r) => r.event);
}

// ---------------------------------------------------------------------------
// buildEvaluationTrace
// ---------------------------------------------------------------------------

/**
 * Build a normalized `junrei-evaluation-trace/v1` document from already-
 * loaded inputs — see the module doc comment for the no-fs contract and the
 * three deliberate design choices. Every event carries `provenance` (a source
 * line and/or a `requestId`); `sourceCompleteness` and `enrichment` together
 * declare exactly what did and didn't contribute (never silently absent).
 */
export function buildEvaluationTrace(inputs: EvaluationTraceInputs): EvaluationTrace {
  const { data } = inputs;
  const recovered = inputs.recoveredResults ?? {};
  const subagentByToolUseId = new Map(
    (inputs.subagents ?? [])
      .filter((s): s is SubagentNode & { toolUseId: string } => s.toolUseId !== undefined)
      .map((s) => [s.toolUseId, s] as const),
  );
  const reconstructionByRequestId = new Map(
    (inputs.reconstructionSummaries ?? [])
      .filter(
        (r): r is EvaluationTraceReconstructionSummary & { requestId: string } =>
          r.requestId !== undefined,
      )
      .map((r) => [r.requestId, r] as const),
  );
  const captureByRequestId = new Map(
    (inputs.requestCaptures ?? []).map((c) => [c.requestId, c] as const),
  );

  const toolCallsById = new Map(data.toolCalls.map((c) => [c.toolUseId, c] as const));
  const requestIdByLine = new Map<number, string>();
  const requestIdByMessageId = new Map<string, string>();
  for (const record of data.records) {
    if (record.type !== "assistant" || !("blocks" in record)) continue;
    if (record.requestId === undefined) continue;
    requestIdByLine.set(record.line, record.requestId);
    if (record.messageId !== undefined && !requestIdByMessageId.has(record.messageId)) {
      requestIdByMessageId.set(record.messageId, record.requestId);
    }
  }

  const positioned: Positioned[] = [];

  for (const prompt of data.userPrompts) {
    positioned.push({
      event: {
        name: "gen_ai.user.message",
        ...(prompt.timestamp !== undefined && { timestamp: prompt.timestamp }),
        provenance: { line: prompt.line },
        attributes: { text: prompt.text },
      },
      line: prompt.line,
    });
  }

  const seenToolUseIds = new Set<string>();
  for (const record of data.records) {
    if (record.type !== "assistant" || !("blocks" in record)) continue;
    const requestId = record.requestId;
    for (const block of record.blocks) {
      if (block.kind === "text") {
        positioned.push({
          event: {
            name: "gen_ai.assistant.message",
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            provenance: { line: record.line, ...(requestId !== undefined && { requestId }) },
            attributes: {
              text: block.text,
              ...(record.model !== undefined && { model: record.model }),
            },
          },
          line: record.line,
        });
      } else if (block.kind === "tool_use") {
        const call = toolCallsById.get(block.toolUseId);
        if (call === undefined || seenToolUseIds.has(call.toolUseId)) continue;
        seenToolUseIds.add(call.toolUseId);
        if (SUBAGENT_TOOL_NAMES.has(call.name)) {
          positioned.push(
            buildSubagentLaunchEvent(
              call,
              subagentByToolUseId.get(call.toolUseId),
              requestId,
              recovered,
            ),
          );
        } else {
          positioned.push(...buildToolEvents(call, requestId, recovered));
        }
      }
    }
  }

  for (const notification of data.taskNotifications) {
    positioned.push({
      event: {
        name: "junrei.task_notification",
        ...(notification.timestamp !== undefined && { timestamp: notification.timestamp }),
        provenance: { line: notification.line },
        attributes: {
          taskId: notification.taskId,
          ...(notification.status !== undefined && { status: notification.status }),
          ...(notification.exitCode !== undefined && { exitCode: notification.exitCode }),
        },
      },
      line: notification.line,
    });
  }

  for (const compaction of data.compactions) {
    positioned.push({
      event: {
        name: "junrei.compaction",
        ...(compaction.timestamp !== undefined && { timestamp: compaction.timestamp }),
        provenance: { line: compaction.line },
        attributes: {
          ...(compaction.trigger !== undefined && { trigger: compaction.trigger }),
          ...(compaction.preTokens !== undefined && { preTokens: compaction.preTokens }),
          ...(compaction.postTokens !== undefined && { postTokens: compaction.postTokens }),
        },
      },
      line: compaction.line,
    });
  }

  for (const error of data.apiErrors) {
    positioned.push({
      event: {
        name: "junrei.api_error",
        ...(error.timestamp !== undefined && { timestamp: error.timestamp }),
        provenance: { line: error.line },
        attributes: {
          ...(error.status !== undefined && { status: error.status }),
          ...(error.retryAttempt !== undefined && { retryAttempt: error.retryAttempt }),
          ...(error.message !== undefined && { message: error.message }),
        },
      },
      line: error.line,
    });
  }

  for (const injected of inputs.injectedContext ?? []) {
    positioned.push({
      event: {
        name: "junrei.injected_context",
        provenance: { line: injected.line },
        attributes: { kind: injected.kind, text: injected.text },
      },
      line: injected.line,
    });
  }

  for (const message of data.apiMessages) {
    const requestId =
      requestIdByMessageId.get(message.messageId) ?? requestIdByLine.get(message.line);
    positioned.push(
      buildRequestEvent(
        message,
        requestId,
        requestId !== undefined ? captureByRequestId.get(requestId) : undefined,
        requestId !== undefined ? reconstructionByRequestId.get(requestId) : undefined,
      ),
    );
  }

  for (const hidden of inputs.hiddenCalls ?? []) {
    positioned.push(buildHiddenCallEvent(hidden));
  }

  const events = orderEvents(positioned);

  const kinds: SourceKind[] = ["claude-session-jsonl"];
  if (inputs.otel?.available === true) kinds.push("claude-otel");
  if (inputs.captures?.available === true) kinds.push("claude-wire-capture");

  const limitations: string[] = [
    "subagent launches are summarized (junrei.subagent_launch); a subagent's own tool calls and " +
      "messages are not merged into this trace — export that subagent's own session data separately",
  ];
  if (data.apiErrorCount > data.apiErrors.length) {
    limitations.push(
      `api errors capped at ${data.apiErrors.length} of ${data.apiErrorCount} total (session-log cap)`,
    );
  }
  if (inputs.injectedContext === undefined) {
    limitations.push(
      "agent/skill-listing injected-context recovery was not attempted for this export " +
        "(requires a locally-stored session transcript)",
    );
  }
  if (inputs.otel?.available === true) {
    limitations.push(
      "OTel's api_request event carries no request-id join key, so per-request cost/duration " +
        "enrichment from OTel is not attempted — see enrichment.otel for the session-level aggregate",
    );
  }
  if (inputs.reconstructionSummaries === undefined) {
    limitations.push(
      "per-request reconstruction summaries were not attempted for this export (requires a " +
        "locally-stored session and get_reconstructed_request's template/disk-context providers)",
    );
  }

  const otelEnrichment: EvaluationTraceOtelEnrichment = inputs.otel ?? {
    consulted: false,
    available: false,
    note: "OTel side channel not consulted for this export",
  };
  const capturesConsulted = inputs.captures?.consulted ?? false;
  const capturesEnrichment: EvaluationTraceCaptureEnrichment = {
    consulted: capturesConsulted,
    available: inputs.captures?.available ?? false,
    ...(inputs.captures?.note !== undefined && { note: inputs.captures.note }),
    ...(!capturesConsulted && {
      note: inputs.captures?.note ?? "wire capture side channel not consulted for this export",
    }),
    ...(capturesConsulted && { hiddenCallCount: inputs.hiddenCalls?.length ?? 0 }),
  };

  return {
    schema: EVALUATION_TRACE_SCHEMA,
    session: inputs.session,
    sourceCompleteness: buildSourceCompleteness(kinds),
    enrichment: { otel: otelEnrichment, captures: capturesEnrichment },
    limitations,
    events,
  };
}
