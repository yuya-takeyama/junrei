/**
 * Server-side assembly for the Goshuin Phase F evaluation-trace export (see
 * docs/milestones/goshuin.md, "F. Evaluation-trace export + analysis
 * playbooks", and `@junrei/core`'s `claude/evaluation-trace.ts` for the pure
 * builder + the three deliberate design choices documented there).
 *
 * This module owns EVERY fs/store read `buildEvaluationTrace` needs — session
 * data, full tool_result recovery (reusing `getSessionToolCallDetail`, never
 * reimplementing the recovery itself), the opt-in OTel/wire-capture side
 * channels, and (for locally-stored sessions only, same restriction as
 * `get_reconstructed_request`) injected-context recovery and per-request
 * reconstruction summaries — then hands fully-resolved plain data to core's
 * pure `buildEvaluationTrace`. Shared by both the HTTP route (uncapped) and
 * the `export_evaluation_trace` MCP tool (which additionally caps/truncates
 * the result — see `mcp.ts`).
 */

import {
  buildEvaluationTrace,
  type ConfidenceClass,
  type EvaluationTrace,
  type EvaluationTraceCaptureEnrichment,
  type EvaluationTraceHiddenCall,
  type EvaluationTraceInjectedContext,
  type EvaluationTraceOtelEnrichment,
  type EvaluationTraceReconstructionSummary,
  type EvaluationTraceRecoveredText,
  type EvaluationTraceRequestCapture,
  listReconstructableRequests,
  loadReconstructionInput,
  localClaudeSessionStore,
  parseOtelSessionLines,
  type ReconAttachmentRecord,
  type ReconstructedRequest,
  type ReconstructionProviders,
  reconstructRequest,
  renderAgentListingBlock,
  renderSkillListingBlock,
} from "@junrei/core";
import { getSession, getSessionData, getSessionToolCallDetail } from "./sessions.js";
import {
  capturedByteSizes,
  createFilesystemCaptureStore,
  extractResponseMeta,
} from "./sources/captures.js";
import { readOtelLines, resolveOtelDir } from "./sources/otel.js";
import {
  createFilesystemDiskContextProvider,
  createFilesystemTemplateProvider,
} from "./sources/reconstruction.js";

/** Tally a reconstructed request's blocks/sections/entries by confidence class — the "compact summary" `buildEvaluationTrace`'s per-request enrichment cites instead of the full payload. */
function confidenceCountsOf(request: ReconstructedRequest): Record<ConfidenceClass, number> {
  const counts: Record<ConfidenceClass, number> = {
    exact: 0,
    template: 0,
    "disk-contingent": 0,
    unknown: 0,
  };
  const bump = (c: ConfidenceClass): void => {
    counts[c] += 1;
  };
  for (const block of request.system) bump(block.confidence);
  bump(request.tools.confidence);
  for (const entry of Object.values(request.params.entries)) bump(entry.confidence);
  if (request.params.confidence !== undefined) bump(request.params.confidence);
  for (const message of request.messages) {
    for (const block of message.content) bump(block.confidence);
  }
  return counts;
}

/**
 * Full-result-text recovery for every tool call whose captured text is
 * SHORT of its true length — reuses `getSessionToolCallDetail`
 * (`@junrei/core`'s `getClaudeToolCallDetail` under the hood) exactly the way
 * `get_tool_call` does, never re-deriving the recovery logic. Skips calls
 * that don't need it (the common case) rather than paying a lookup for every
 * tool call in the session.
 */
async function recoverToolResults(
  sessionId: string,
  toolCalls: readonly { toolUseId: string; result?: { text: string; fullTextLength: number } }[],
): Promise<Record<string, EvaluationTraceRecoveredText>> {
  const recovered: Record<string, EvaluationTraceRecoveredText> = {};
  const needsRecovery = toolCalls.filter(
    (c) => c.result !== undefined && c.result.fullTextLength > c.result.text.length,
  );
  await Promise.all(
    needsRecovery.map(async (c) => {
      const detail = await getSessionToolCallDetail(sessionId, c.toolUseId);
      if (detail?.result != null) {
        recovered[c.toolUseId] = {
          text: detail.result.text,
          ...(detail.result.fullTextLength !== undefined && {
            fullTextLength: detail.result.fullTextLength,
          }),
        };
      }
    }),
  );
  return recovered;
}

/**
 * Injected-context recovery (agent/skill-listing reminders) + per-request
 * reconstruction summaries — BOTH require the "virtual wire" reconstruction
 * input (raw byte-preserving records + template/disk-context providers), so
 * they're built together. LOCALLY-STORED sessions only, same restriction
 * `get_reconstructed_request` documents (an S3-merged session's disk context
 * and templates live on another machine) — `undefined` for both when the
 * session isn't found in the local store, which `buildEvaluationTrace` turns
 * into an explicit `limitations` entry rather than a silent gap.
 */
async function reconstructionEnrichment(sessionId: string): Promise<{
  injectedContext?: EvaluationTraceInjectedContext[];
  reconstructionSummaries?: EvaluationTraceReconstructionSummary[];
}> {
  const ref = await localClaudeSessionStore.findSessionFileById(sessionId);
  if (ref === undefined) return {};

  const input = await loadReconstructionInput(sessionId, ref.filePath, localClaudeSessionStore);

  const injectedContext: EvaluationTraceInjectedContext[] = [];
  for (const record of input.records) {
    if (record.type !== "attachment") continue;
    const attachmentRecord = record as ReconAttachmentRecord;
    const attachment = attachmentRecord.attachment;
    if (attachment.type === "agent_listing_delta" && attachment.addedLines !== undefined) {
      injectedContext.push({
        line: attachmentRecord.line,
        kind: "agent-listing",
        text: renderAgentListingBlock(attachment.addedLines),
      });
    } else if (attachment.type === "skill_listing" && attachment.content !== undefined) {
      injectedContext.push({
        line: attachmentRecord.line,
        kind: "skill-listing",
        text: renderSkillListingBlock(attachment.content),
      });
    }
  }

  const providers: ReconstructionProviders = {
    template: createFilesystemTemplateProvider(),
    diskContext: createFilesystemDiskContextProvider({ projectDirName: ref.projectDirName }),
  };
  const reconstructionSummaries: EvaluationTraceReconstructionSummary[] = [];
  for (const candidate of listReconstructableRequests(input.records)) {
    const target: string | number = candidate.requestId ?? candidate.targetLine;
    const reconstructed = await reconstructRequest(input, target, providers);
    if (reconstructed === undefined) continue;
    reconstructionSummaries.push({
      ...(reconstructed.requestId !== undefined && { requestId: reconstructed.requestId }),
      targetLine: reconstructed.targetLine,
      confidenceCounts: confidenceCountsOf(reconstructed),
      appliedRules: reconstructed.appliedRules,
      limitations: reconstructed.limitations,
    });
  }

  return { injectedContext, reconstructionSummaries };
}

const JUNREI_OTEL_DIR_SETUP_NOTE =
  "set JUNREI_OTEL_DIR on the junrei server and configure Claude Code with " +
  "OTEL_LOGS_EXPORTER=otlp/OTEL_METRICS_EXPORTER=otlp to enable";

/** Session-level OTel aggregate declaration — see `EvaluationTraceOtelEnrichment`'s doc comment on why this is session-level, not per-request. */
async function otelEnrichment(sessionId: string): Promise<EvaluationTraceOtelEnrichment> {
  const otelDir = resolveOtelDir();
  if (otelDir === undefined) {
    return {
      consulted: true,
      available: false,
      note: `OTel ingestion is disabled — ${JUNREI_OTEL_DIR_SETUP_NOTE}`,
    };
  }
  const lines = await readOtelLines(otelDir, sessionId);
  if (lines.length === 0) {
    return {
      consulted: true,
      available: false,
      note: "OTel ingestion is enabled but no data has been recorded for this session",
    };
  }
  const parsed = parseOtelSessionLines(lines);
  return {
    consulted: true,
    available: true,
    ...(parsed.apiRequests.costSource !== "none" && {
      costUsd: parsed.apiRequests.costUsdSum,
      costSource: parsed.apiRequests.costSource,
    }),
    apiRequestCount: parsed.apiRequests.count,
    ...(parsed.apiRequests.duration !== undefined && {
      durationMsAvg: parsed.apiRequests.duration.avgMs,
    }),
  };
}

/** Wire-capture declaration + per-request join (`requestCaptures`) + hidden calls — the SAME deterministic requestId join `get_actual_request`/`get_hidden_calls` use. */
async function captureEnrichment(sessionId: string): Promise<{
  captures: EvaluationTraceCaptureEnrichment;
  requestCaptures?: EvaluationTraceRequestCapture[];
  hiddenCalls?: EvaluationTraceHiddenCall[];
}> {
  const store = createFilesystemCaptureStore();
  const lookup = await store.readSessionCaptures(sessionId);
  if (!lookup.available) {
    return {
      captures: {
        consulted: true,
        available: false,
        note:
          lookup.reason === "captures-dir-missing"
            ? "no captures directory — wire capture is opt-in"
            : "this session was not captured",
      },
    };
  }

  const logged = await store.collectLoggedRequestIds(sessionId);
  const requestCaptures: EvaluationTraceRequestCapture[] = [];
  const hiddenCalls: EvaluationTraceHiddenCall[] = [];
  for (const record of lookup.records) {
    if (typeof record.requestId !== "string") continue;
    const isHidden = logged !== undefined && !logged.has(record.requestId);
    if (isHidden) {
      const meta = extractResponseMeta(record);
      const sizes = capturedByteSizes(record);
      hiddenCalls.push({
        requestId: record.requestId,
        ...(record.path !== undefined && { path: record.path }),
        ...(meta.model !== undefined && { model: meta.model }),
        ...(meta.usage !== undefined && { usage: meta.usage }),
        ...(record.latencyMs !== undefined && { latencyMs: record.latencyMs }),
        isSubagent: record.isSubagent ?? false,
        requestBytes: sizes.requestBytes,
        responseBytes: sizes.responseBytes,
        ...(record.startedAt !== undefined && { startedAt: record.startedAt }),
      });
    } else {
      requestCaptures.push({
        requestId: record.requestId,
        ...(record.latencyMs !== undefined && { latencyMs: record.latencyMs }),
        ...(record.isSubagent !== undefined && { isSubagent: record.isSubagent }),
      });
    }
  }
  return { captures: { consulted: true, available: true }, requestCaptures, hiddenCalls };
}

/**
 * Assemble the full evaluation trace for one Claude Code session — `undefined`
 * for an unknown session id. Every opt-in channel (OTel, wire capture,
 * reconstruction) is consulted unconditionally and ALWAYS declared (never
 * silently skipped) via `EvaluationTrace.enrichment`/`limitations` — see
 * `buildEvaluationTrace`'s doc comment.
 */
export async function assembleEvaluationTrace(
  sessionId: string,
): Promise<EvaluationTrace | undefined> {
  const [analysis, data] = await Promise.all([getSession(sessionId), getSessionData(sessionId)]);
  if (analysis === undefined || data === undefined) return undefined;

  const [recoveredResults, { injectedContext, reconstructionSummaries }, otel, capture] =
    await Promise.all([
      recoverToolResults(sessionId, data.toolCalls),
      reconstructionEnrichment(sessionId),
      otelEnrichment(sessionId),
      captureEnrichment(sessionId),
    ]);

  return buildEvaluationTrace({
    session: {
      sessionId,
      ...(analysis.cwd !== undefined && { cwd: analysis.cwd }),
      ...(data.version !== undefined && { cliVersion: data.version }),
      ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
      ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
    },
    data,
    subagents: analysis.subagents,
    recoveredResults,
    ...(injectedContext !== undefined && { injectedContext }),
    otel,
    captures: capture.captures,
    ...(capture.requestCaptures !== undefined && { requestCaptures: capture.requestCaptures }),
    ...(capture.hiddenCalls !== undefined && { hiddenCalls: capture.hiddenCalls }),
    ...(reconstructionSummaries !== undefined && { reconstructionSummaries }),
  });
}
