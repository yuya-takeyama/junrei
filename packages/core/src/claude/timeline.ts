/**
 * Full-transcript timeline (Timeline lens / L2) and single-record detail
 * (Record detail / L3) reconstruction for Claude Code sessions — see
 * `../shared/timeline.ts` for the `TimelineEntry`/`RecordDetail` vocabulary
 * and text-formatting helpers this shares with `codex/timeline.ts`.
 *
 * Everything here is derived strictly from what the log actually contains —
 * no estimates are presented as facts. Notably:
 *  - There is no per-message API-latency field anywhere in Claude Code's
 *    JSONL schema (checked against `AssistantRecord` and real session logs),
 *    so `assistant-text` entries never carry a duration — it is NOT
 *    approximated from timestamp deltas between records.
 *  - There is no "effort" field recorded anywhere for subagent launches
 *    (checked against real `Agent`/`Task` tool inputs and subagent meta
 *    files), so `subagent-launch` entries never populate `effort`.
 *  - Tool result text is already capped at parse time
 *    (`TOOL_RESULT_TEXT_LIMIT` in parser.ts). Timeline entries (list view)
 *    and `SessionData.toolCalls[].result.text` itself keep reflecting that
 *    captured slice, unchanged — but the drill-down evidence path
 *    (`getClaudeRecordDetail`'s tool-call/subagent-launch kinds,
 *    `getClaudeToolCallDetail`) re-reads the record's own raw source line to
 *    recover the tool's TRUE full output whenever the cap actually cut it
 *    (see "Full tool_result text recovery" below) — `resultLineCount` there
 *    is counted over the recovered text, not the capped snapshot.
 */

import { parseJsonlLine } from "../shared/jsonl.js";
import { estimateCostUsd } from "../shared/pricing/pricing.js";
import {
  type AssistantTextEntry,
  type AssistantTextRecordDetail,
  collapseWhitespace,
  countLines,
  durationBetween,
  type RecordDetail,
  type SubagentLaunchEntry,
  type SubagentLaunchRecordDetail,
  summarizeResultText,
  type TaskNotificationEntry,
  type TaskNotificationRecordDetail,
  type ThinkingEntry,
  type ThinkingRecordDetail,
  type TimelineEntry,
  type TimelineOptions,
  type ToolCallDetail,
  type ToolCallEntry,
  type ToolCallRecordDetail,
  type ToolCallRelatedRecord,
  type ToolCallStatus,
  truncate,
  truncateOneLine,
} from "../shared/timeline.js";
import type { TokenUsage } from "../shared/types.js";
import { computeUsage } from "./metrics.js";
import { extractRawToolResultText } from "./parser.js";
import type { ApiMessage, SessionData, ToolCall } from "./session-data.js";
import { asyncAgentLaunchToolUseIds } from "./session-data.js";
import { type ClaudeSessionStore, localClaudeSessionStore } from "./store.js";
import { listSubagentRefs, loadSubagentSessionData, type SubagentRef } from "./subagents.js";
import type {
  AssistantRecord,
  ContentBlockText,
  ContentBlockThinking,
  ContentBlockToolUse,
  TaskNotificationInfo,
} from "./types.js";
import { listWorkflowRuns } from "./workflows.js";

// ---------------------------------------------------------------------------
// Local formatting helpers
// ---------------------------------------------------------------------------

const USER_TEXT_LIMIT = 700;
const ASSISTANT_TEXT_LIMIT = 700;
const INPUT_SUMMARY_LIMIT = 120;
const PROMPT_PREVIEW_LIMIT = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

function toolCallStatus(call: Pick<ToolCall, "result">): ToolCallStatus {
  if (call.result === undefined) return "missing-result";
  return call.result.isError ? "error" : "ok";
}

const INPUT_SUMMARY_KEYS = [
  "command",
  "file_path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

function summarizeToolInput(input: unknown): string {
  const obj = asRecord(input);
  if (obj !== undefined) {
    for (const key of INPUT_SUMMARY_KEYS) {
      const value = strField(obj, key);
      if (value !== undefined) return truncateOneLine(value, INPUT_SUMMARY_LIMIT);
    }
  }
  return truncateOneLine(JSON.stringify(input ?? null), INPUT_SUMMARY_LIMIT);
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

function isSubagentLaunchTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Full tool_result text recovery — DRILL-DOWN EVIDENCE PATH ONLY
// (getClaudeRecordDetail / getClaudeToolCallDetail, in turn get_records /
// get_tool_call). Never used by buildClaudeTimeline or any other summary —
// those keep showing the parser's TOOL_RESULT_TEXT_LIMIT-capped snapshot
// unchanged, per that limit's own doc comment.
// ---------------------------------------------------------------------------

/**
 * Read + JSON-parse exactly one 1-based line from `filePath` via `store`.
 * Stops iterating the moment the target line is reached (or passed), so a
 * recovery attempt near the top of a huge transcript never pays to stream
 * the rest of it. `undefined` when the line doesn't exist or isn't valid
 * JSON — callers treat that as "can't recover", not an error.
 */
async function readRawLineAt(
  filePath: string,
  line: number,
  store: ClaudeSessionStore,
): Promise<unknown | undefined> {
  let i = 0;
  for await (const text of store.openLines(filePath)) {
    i += 1;
    if (i === line) return parseJsonlLine(text);
    if (i > line) break;
  }
  return undefined;
}

/**
 * Resolve the FULL text of a `tool_result` the parser capped at parse time
 * (`result.fullTextLength > result.text.length` — see `parser.ts`'s
 * `TOOL_RESULT_TEXT_LIMIT`) by re-reading the record's own raw JSONL line
 * (`result.line`, in the transcript at `filePath`) through `store` and
 * re-extracting the block matching `toolUseId` (`extractRawToolResultText`).
 * Never throws and never silently keeps a stale cap unflagged: on ANY
 * recovery failure — `filePath` unset (hand-built `SessionData` with no
 * source file), the line unreadable, or no matching block found there — this
 * returns `result.text` UNCHANGED, still short of `result.fullTextLength`.
 * Callers compare the returned string's length against `result.fullTextLength`
 * themselves to know whether recovery actually happened — exactly the same
 * signal they'd get had no cap ever existed, so no separate "did it work"
 * flag is threaded through.
 */
async function resolveFullResultText(
  result: NonNullable<ToolCall["result"]>,
  toolUseId: string,
  filePath: string | undefined,
  store: ClaudeSessionStore,
): Promise<string> {
  if (result.fullTextLength <= result.text.length || filePath === undefined) return result.text;
  try {
    const raw = await readRawLineAt(filePath, result.line, store);
    if (raw === undefined) return result.text;
    return extractRawToolResultText(raw, toolUseId) ?? result.text;
  } catch {
    return result.text;
  }
}

// ---------------------------------------------------------------------------
// Per-message usage resolution for assistant-text badges
// ---------------------------------------------------------------------------

/**
 * Usage to price an assistant record's badge with. A record's own `usage` is
 * a streaming snapshot whose output_tokens GROWS across the message's records
 * (e.g. 5→5→473) — only the deduped `ApiMessage` carries the final billed
 * total (see its doc comment). Falls back to the record's own snapshot when
 * the record has no messageId to look up (or the message is absent from
 * `apiMessages`, e.g. hand-built SessionData): a lone record's snapshot is
 * the best available figure.
 */
function resolveMessageUsage(
  record: AssistantRecord,
  apiMessagesById: Map<string, ApiMessage>,
): TokenUsage | undefined {
  const message =
    record.messageId !== undefined ? apiMessagesById.get(record.messageId) : undefined;
  return message?.usage ?? record.usage;
}

/**
 * Line of the last text-block-bearing record per message id. Because the
 * badge shows the MESSAGE's usage (not the record's snapshot), a message that
 * emits several text blocks must carry it exactly once — repeating the same
 * total on every block would read as N× the real cost in the timeline list.
 */
function lastTextLineByMessageId(records: SessionData["records"]): Map<string, number> {
  const byId = new Map<string, number>();
  for (const record of records) {
    if (record.type !== "assistant" || !("blocks" in record)) continue;
    if (record.messageId === undefined) continue;
    if (record.blocks.some((b) => b.kind === "text")) byId.set(record.messageId, record.line);
  }
  return byId;
}

/** Whether this text block is its message's last — the badge carrier. */
function carriesUsageBadge(
  record: AssistantRecord,
  block: ContentBlockText,
  lastTextLines: Map<string, number>,
): boolean {
  const texts = record.blocks.filter((b) => b.kind === "text");
  if (texts[texts.length - 1] !== block) return false;
  // No messageId → nothing to group by; the record keeps its own badge.
  if (record.messageId === undefined) return true;
  return lastTextLines.get(record.messageId) === record.line;
}

// ---------------------------------------------------------------------------
// Subagent resolution (shared between list + detail builders)
// ---------------------------------------------------------------------------

interface ResolvedSubagentUsage {
  agentId: string;
  model?: string;
  outputTokens: number;
  costUsd: number;
  costIsComplete: boolean;
  toolCallCount: number;
  toolErrorCount: number;
  durationMs?: number;
}

async function resolveSubagentUsage(
  ref: SubagentRef,
  mainFilePath: string,
  store: ClaudeSessionStore,
): Promise<ResolvedSubagentUsage | undefined> {
  const data = await loadSubagentSessionData(mainFilePath, ref.agentId, store);
  if (data === undefined) return undefined;
  const usage = computeUsage(data);
  const model = data.apiMessages.find((m) => m.model !== undefined)?.model;
  const toolErrorCount = data.toolCalls.filter((c) => c.result?.isError === true).length;
  const durationMs = durationBetween(data.firstTimestamp, data.lastTimestamp);
  return {
    agentId: ref.agentId,
    ...(model !== undefined && { model }),
    outputTokens: usage.total.outputTokens,
    costUsd: usage.total.costUsd,
    costIsComplete: usage.total.costIsComplete,
    toolCallCount: data.toolCalls.length,
    toolErrorCount,
    ...(durationMs !== undefined && { durationMs }),
  };
}

// ---------------------------------------------------------------------------
// buildClaudeTimeline
// ---------------------------------------------------------------------------

/**
 * Ordered, log-derived reconstruction of an entire transcript for the
 * Timeline lens. `store` resolves sidecar subagent/workflow data (defaults to
 * the local filesystem) — pass the SAME store `data`'s transcript itself came
 * from, e.g. an S3-backed store for an S3 session (see `store.ts`), so
 * subagent-launch/workflow enrichment reads from the right place.
 */
export async function buildClaudeTimeline(
  data: SessionData,
  opts: TimelineOptions = {},
  store: ClaudeSessionStore = localClaudeSessionStore,
): Promise<TimelineEntry[]> {
  const toolCallsById = new Map(data.toolCalls.map((c) => [c.toolUseId, c]));
  const launchByTaskId = new Map(data.backgroundLaunches.map((l) => [l.taskId, l]));
  const asyncLaunchIds = asyncAgentLaunchToolUseIds(data);
  const apiMessagesById = new Map(data.apiMessages.map((m) => [m.messageId, m]));
  const lastTextLines = lastTextLineByMessageId(data.records);

  const refByToolUseId = new Map<string, SubagentRef>();
  if (opts.mainFilePath !== undefined) {
    for (const ref of await listSubagentRefs(opts.mainFilePath, store)) {
      if (ref.meta.toolUseId !== undefined) refByToolUseId.set(ref.meta.toolUseId, ref);
    }
  }

  const entries: TimelineEntry[] = [];

  for (const record of data.records) {
    switch (record.type) {
      case "user": {
        if (!("toolResults" in record)) break;
        if (
          record.promptText !== undefined &&
          record.isMeta !== true &&
          record.isCompactSummary !== true
        ) {
          const { text, truncated } = truncate(record.promptText, USER_TEXT_LIMIT);
          entries.push({
            kind: "user",
            text,
            truncated,
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
          });
        } else if (record.taskNotification !== undefined) {
          entries.push(
            buildTaskNotificationEntry(record.taskNotification, record.line, record.timestamp, {
              launchByTaskId,
              toolCallsById,
            }),
          );
        }
        break;
      }
      case "assistant": {
        if (!("blocks" in record)) break;
        for (const block of record.blocks) {
          if (block.kind === "text") {
            entries.push(
              buildAssistantTextEntry(
                record,
                block,
                resolveMessageUsage(record, apiMessagesById),
                carriesUsageBadge(record, block, lastTextLines),
              ),
            );
          } else if (block.kind === "thinking") {
            entries.push(buildThinkingEntry(record, block));
          } else if (block.kind === "tool_use") {
            const call = toolCallsById.get(block.toolUseId);
            if (call === undefined) break;
            if (isSubagentLaunchTool(call.name) || refByToolUseId.has(call.toolUseId)) {
              const ref = refByToolUseId.get(call.toolUseId);
              const entry = await buildSubagentEntry(
                call,
                ref,
                opts,
                asyncLaunchIds.has(call.toolUseId),
                store,
              );
              entries.push(entry);
            } else if (call.name === "Workflow") {
              entries.push(await buildWorkflowToolCallEntry(call, opts, store));
            } else {
              entries.push(buildToolCallEntry(call));
            }
          }
        }
        break;
      }
      case "system": {
        if ("subtype" in record && record.subtype === "compact_boundary") {
          entries.push({
            kind: "compaction",
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            ...("trigger" in record && record.trigger !== undefined && { trigger: record.trigger }),
            ...("preTokens" in record &&
              record.preTokens !== undefined && { preTokens: record.preTokens }),
            ...("postTokens" in record &&
              record.postTokens !== undefined && { postTokens: record.postTokens }),
          });
        } else if ("subtype" in record && record.subtype === "api_error") {
          entries.push({
            kind: "api-error",
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            ...("message" in record && record.message !== undefined && { message: record.message }),
          });
        }
        break;
      }
      case "queue-operation":
      case "attachment": {
        if (!("taskNotification" in record)) break;
        entries.push(
          buildTaskNotificationEntry(record.taskNotification, record.line, record.timestamp, {
            launchByTaskId,
            toolCallsById,
          }),
        );
        break;
      }
      default:
        break;
    }
  }

  return entries;
}

/**
 * `usage` is the message-final usage from `resolveMessageUsage`, and
 * `showUsage` (from `carriesUsageBadge`) confines the badge to the message's
 * last text block; the model chip stays on every block.
 */
function buildAssistantTextEntry(
  record: AssistantRecord,
  block: ContentBlockText,
  usage: TokenUsage | undefined,
  showUsage: boolean,
): AssistantTextEntry {
  const { text, truncated } = truncate(block.text, ASSISTANT_TEXT_LIMIT);
  const costUsd =
    showUsage && record.model !== undefined && usage !== undefined
      ? estimateCostUsd(record.model, usage)
      : undefined;
  return {
    kind: "assistant-text",
    text,
    truncated,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    ...(record.model !== undefined && { model: record.model }),
    ...(showUsage && usage !== undefined && { outputTokens: usage.outputTokens }),
    ...(costUsd !== undefined && { costUsd }),
  };
}

function buildThinkingEntry(record: AssistantRecord, block: ContentBlockThinking): ThinkingEntry {
  const { text, truncated } = truncate(block.text, ASSISTANT_TEXT_LIMIT);
  return {
    kind: "thinking",
    text,
    truncated,
    charCount: block.length,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    ...(record.model !== undefined && { model: record.model }),
  };
}

function buildToolCallEntry(call: ToolCall): ToolCallEntry {
  const status = toolCallStatus(call);
  const durationMs = durationBetween(call.timestamp, call.result?.timestamp);
  return {
    kind: "tool-call",
    toolUseId: call.toolUseId,
    name: call.name,
    inputSummary: summarizeToolInput(call.input),
    status,
    line: call.line,
    ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
    ...(call.result !== undefined && {
      resultSummary: summarizeResultText(call.result.text),
      resultLineCount: countLines(call.result.text),
      resultLine: call.result.line,
    }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

/**
 * A `Workflow` tool call's own `tool_result` text is the only place its run
 * id round-trips back to this specific call (meta.json for the spawned
 * agents carries no `toolUseId` at all — see `analyze.ts`'s
 * `findWorkflowLaunch` for the INVERSE lookup, run id -> tool_use). Matches
 * the explicit `Run ID: <id>` line the harness prints first, falling back to
 * the `subagents/workflows/<id>` transcript-dir path segment.
 */
function extractWorkflowRunId(resultText: string): string | undefined {
  const explicit = /Run ID:\s*(\S+)/.exec(resultText)?.[1];
  if (explicit !== undefined) return explicit;
  return /subagents\/workflows\/([^/\s]+)/.exec(resultText)?.[1];
}

/**
 * Cost/count rollup over a workflow run's member agents, resolved lazily
 * (only when a `Workflow` timeline entry actually needs it) the same way
 * `resolveSubagentUsage` resolves one classic subagent's usage — never
 * pre-computed for the whole session, and never a second usage-bearing tree
 * node (this is a display summary only, see `ToolCallEntry.workflowCostUsd`'s
 * doc comment). `undefined` when no member transcripts are discoverable yet
 * (a run that's still starting, or whose sidecars haven't synced to disk).
 */
async function resolveWorkflowRollup(
  runId: string,
  mainFilePath: string,
  store: ClaudeSessionStore,
): Promise<{ agentCount: number; costUsd: number; costIsComplete: boolean } | undefined> {
  const refs = (await listSubagentRefs(mainFilePath, store)).filter(
    (r) => r.workflowRunId === runId,
  );
  if (refs.length === 0) return undefined;
  let costUsd = 0;
  let costIsComplete = true;
  for (const ref of refs) {
    const data = await loadSubagentSessionData(mainFilePath, ref.agentId, store);
    if (data === undefined) continue;
    const usage = computeUsage(data);
    costUsd += usage.total.costUsd;
    if (!usage.total.costIsComplete) costIsComplete = false;
  }
  return { agentCount: refs.length, costUsd, costIsComplete };
}

/**
 * Enrich a `Workflow` tool call's plain `ToolCallEntry` (from
 * `buildToolCallEntry`) with `workflowRunId`/`workflowName`/
 * `workflowAgentCount`/`workflowCostUsd` when the run can be resolved — see
 * `extractWorkflowRunId`/`resolveWorkflowRollup`. Falls back to the plain
 * entry (no workflow fields) when `opts.mainFilePath` is absent (timeline
 * built without sidecar access) or the run id can't be extracted at all.
 */
async function buildWorkflowToolCallEntry(
  call: ToolCall,
  opts: TimelineOptions,
  store: ClaudeSessionStore,
): Promise<ToolCallEntry> {
  const base = buildToolCallEntry(call);
  const runId = call.result !== undefined ? extractWorkflowRunId(call.result.text) : undefined;
  if (runId === undefined || opts.mainFilePath === undefined) return base;

  const [runs, rollup] = await Promise.all([
    listWorkflowRuns(opts.mainFilePath, store),
    resolveWorkflowRollup(runId, opts.mainFilePath, store),
  ]);
  const run = runs.find((r) => r.runId === runId);

  return {
    ...base,
    workflowRunId: runId,
    ...(run?.workflowName !== undefined && { workflowName: run.workflowName }),
    ...(rollup !== undefined && {
      workflowAgentCount: rollup.agentCount,
      workflowCostUsd: rollup.costUsd,
      workflowCostIsComplete: rollup.costIsComplete,
    }),
  };
}

async function buildSubagentEntry(
  call: ToolCall,
  ref: SubagentRef | undefined,
  opts: TimelineOptions,
  isAsyncLaunch: boolean,
  store: ClaudeSessionStore,
): Promise<SubagentLaunchEntry> {
  const input = asRecord(call.input);
  const agentType = ref?.meta.agentType ?? strField(input, "subagent_type");
  const name = ref?.meta.description ?? strField(input, "description");
  const inputModel = strField(input, "model");
  const promptRaw = strField(input, "prompt") ?? "";
  const { text: promptPreview, truncated: promptTruncated } = truncate(
    collapseWhitespace(promptRaw),
    PROMPT_PREVIEW_LIMIT,
  );

  const entry: SubagentLaunchEntry = {
    kind: "subagent-launch",
    toolUseId: call.toolUseId,
    promptTruncated,
    line: call.line,
    ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
    ...(ref !== undefined && { agentId: ref.agentId }),
    ...(agentType !== undefined && { agentType }),
    ...(name !== undefined && { name }),
    ...(inputModel !== undefined && { model: inputModel }),
    ...(promptPreview !== "" && { promptPreview }),
    ...(call.result !== undefined && { resultLine: call.result.line }),
    // Async launches: the result text is only the launch ack, not the agent's
    // return — leave returnedChars unresolved rather than measuring the ack.
    ...(call.result !== undefined && !isAsyncLaunch && { returnedChars: call.result.text.length }),
  };

  if (ref !== undefined && opts.mainFilePath !== undefined) {
    const usage = await resolveSubagentUsage(ref, opts.mainFilePath, store);
    if (usage !== undefined) {
      if (usage.model !== undefined) entry.model = usage.model;
      entry.outputTokens = usage.outputTokens;
      entry.costUsd = usage.costUsd;
      entry.costIsComplete = usage.costIsComplete;
      entry.toolCallCount = usage.toolCallCount;
      entry.toolErrorCount = usage.toolErrorCount;
      if (usage.durationMs !== undefined) entry.durationMs = usage.durationMs;
    }
  }

  return entry;
}

/**
 * Locate the tool call that originally launched a background task, given its
 * BackgroundLaunch record. Mirrors `computeTaskExecutions`: the launching
 * tool_use's own timestamp/line is the meaningful "start" (the launch record
 * itself — a tool_result carrier — is timestamped slightly later).
 */
function launchingCall(
  launch: SessionData["backgroundLaunches"][number] | undefined,
  toolCallsById: Map<string, ToolCall>,
): ToolCall | undefined {
  return launch?.toolUseId !== undefined ? toolCallsById.get(launch.toolUseId) : undefined;
}

function buildTaskNotificationEntry(
  notification: TaskNotificationInfo,
  line: number,
  timestamp: string | undefined,
  ctx: {
    launchByTaskId: Map<string, SessionData["backgroundLaunches"][number]>;
    toolCallsById: Map<string, ToolCall>;
  },
): TaskNotificationEntry {
  const launch = ctx.launchByTaskId.get(notification.taskId);
  const call = launchingCall(launch, ctx.toolCallsById);
  const startTimestamp = call?.timestamp ?? launch?.timestamp;
  const startLine = call?.line ?? launch?.line;
  const durationMs = durationBetween(startTimestamp, timestamp);
  return {
    kind: "task-notification",
    taskId: notification.taskId,
    background: true,
    line,
    ...(timestamp !== undefined && { timestamp }),
    ...(launch !== undefined && { name: launch.name }),
    ...(notification.status !== undefined && { status: notification.status }),
    ...(notification.exitCode !== undefined && { exitCode: notification.exitCode }),
    ...(durationMs !== undefined && { durationMs }),
    ...(startLine !== undefined && { startLine }),
  };
}

// ---------------------------------------------------------------------------
// getClaudeRecordDetail
// ---------------------------------------------------------------------------

/**
 * Full record at one source line — for the Record detail (L3) slide-over.
 * `store` resolves sidecar subagent/workflow data (defaults to the local
 * filesystem) — see `buildClaudeTimeline`'s doc comment on passing the SAME
 * store `data` came from.
 */
export async function getClaudeRecordDetail(
  data: SessionData,
  line: number,
  opts: TimelineOptions = {},
  store: ClaudeSessionStore = localClaudeSessionStore,
): Promise<RecordDetail | undefined> {
  const record = data.records.find((r) => r.line === line);
  if (record === undefined) return undefined;

  if (record.type === "assistant" && "blocks" in record) {
    const toolUse = record.blocks.find((b): b is ContentBlockToolUse => b.kind === "tool_use");
    if (toolUse !== undefined) {
      const call: ToolCall = data.toolCalls.find((c) => c.toolUseId === toolUse.toolUseId) ?? {
        toolUseId: toolUse.toolUseId,
        name: toolUse.name,
        input: toolUse.input,
        line: record.line,
        ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      };
      if (isSubagentLaunchTool(call.name) || (await hasSubagentRef(call.toolUseId, opts, store))) {
        const ref = await findSubagentRef(call.toolUseId, opts, store);
        return buildSubagentDetail(call, ref, opts, store, data.filePath);
      }
      return buildToolCallDetail(call, data.filePath, store);
    }
    const text = record.blocks.find((b): b is ContentBlockText => b.kind === "text");
    if (text !== undefined) return buildAssistantTextDetail(record, text, data);
    const thinking = record.blocks.find((b): b is ContentBlockThinking => b.kind === "thinking");
    if (thinking !== undefined) return buildThinkingDetail(record, thinking);
    return undefined;
  }

  if (record.type === "user" && "toolResults" in record) {
    if (
      record.promptText !== undefined &&
      record.isMeta !== true &&
      record.isCompactSummary !== true
    ) {
      return {
        kind: "user",
        text: record.promptText,
        line: record.line,
        ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      };
    }
    if (record.taskNotification !== undefined) {
      return buildTaskNotificationDetail(
        record.taskNotification,
        record.line,
        record.timestamp,
        data,
      );
    }
    return undefined;
  }

  if (
    (record.type === "queue-operation" || record.type === "attachment") &&
    "taskNotification" in record
  ) {
    return buildTaskNotificationDetail(
      record.taskNotification,
      record.line,
      record.timestamp,
      data,
    );
  }

  if (record.type === "system" && "subtype" in record && record.subtype === "compact_boundary") {
    return {
      kind: "compaction",
      line: record.line,
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      ...("trigger" in record && record.trigger !== undefined && { trigger: record.trigger }),
      ...("preTokens" in record &&
        record.preTokens !== undefined && { preTokens: record.preTokens }),
      ...("postTokens" in record &&
        record.postTokens !== undefined && { postTokens: record.postTokens }),
    };
  }
  if (record.type === "system" && "subtype" in record && record.subtype === "api_error") {
    return {
      kind: "api-error",
      line: record.line,
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      ...("message" in record && record.message !== undefined && { message: record.message }),
      ...("status" in record && record.status !== undefined && { status: record.status }),
      ...("retryAttempt" in record &&
        record.retryAttempt !== undefined && { retryAttempt: record.retryAttempt }),
    };
  }

  return undefined;
}

/**
 * Unlike the timeline entry (badge confined to the message's last text block
 * — see `carriesUsageBadge`), the detail always reports the owning API
 * message's final usage: a single-record view has no list to double-count in,
 * and "what did this message cost" is the useful answer on any of its blocks.
 */
function buildAssistantTextDetail(
  record: AssistantRecord,
  block: ContentBlockText,
  data: SessionData,
): AssistantTextRecordDetail {
  const usage = resolveMessageUsage(record, new Map(data.apiMessages.map((m) => [m.messageId, m])));
  const costUsd =
    record.model !== undefined && usage !== undefined
      ? estimateCostUsd(record.model, usage)
      : undefined;
  return {
    kind: "assistant-text",
    text: block.text,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    ...(record.model !== undefined && { model: record.model }),
    ...(usage !== undefined && { outputTokens: usage.outputTokens }),
    ...(costUsd !== undefined && { costUsd }),
  };
}

function buildThinkingDetail(
  record: AssistantRecord,
  block: ContentBlockThinking,
): ThinkingRecordDetail {
  return {
    kind: "thinking",
    text: block.text,
    charCount: block.length,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    ...(record.model !== undefined && { model: record.model }),
  };
}

/**
 * `filePath`/`store` enable the drill-down recovery path
 * (`resolveFullResultText`) when `call.result` was capped by the parser's
 * `TOOL_RESULT_TEXT_LIMIT` — `resultTextFullCharCount` stays set on the
 * returned detail only when recovery DIDN'T fully close the gap (unset once
 * `resultText` is genuinely complete), mirroring `ToolCallDetailResult
 * .fullTextLength`'s "present only when still short of the truth" contract.
 */
async function buildToolCallDetail(
  call: ToolCall,
  filePath: string | undefined,
  store: ClaudeSessionStore,
): Promise<ToolCallRecordDetail> {
  const status = toolCallStatus(call);
  const durationMs = durationBetween(call.timestamp, call.result?.timestamp);
  const resultText =
    call.result === undefined
      ? undefined
      : await resolveFullResultText(call.result, call.toolUseId, filePath, store);
  return {
    kind: "tool-call",
    toolUseId: call.toolUseId,
    name: call.name,
    input: call.input,
    status,
    line: call.line,
    ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
    ...(call.result !== undefined &&
      resultText !== undefined && {
        resultText,
        resultLineCount: countLines(resultText),
        resultLine: call.result.line,
        ...(call.result.timestamp !== undefined && { resultTimestamp: call.result.timestamp }),
        ...(call.result.fullTextLength > resultText.length && {
          resultTextFullCharCount: call.result.fullTextLength,
        }),
      }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

async function findSubagentRef(
  toolUseId: string,
  opts: TimelineOptions,
  store: ClaudeSessionStore,
): Promise<SubagentRef | undefined> {
  if (opts.mainFilePath === undefined) return undefined;
  const refs = await listSubagentRefs(opts.mainFilePath, store);
  return refs.find((r) => r.meta.toolUseId === toolUseId);
}

async function hasSubagentRef(
  toolUseId: string,
  opts: TimelineOptions,
  store: ClaudeSessionStore,
): Promise<boolean> {
  return (await findSubagentRef(toolUseId, opts, store)) !== undefined;
}

/**
 * `filePath`/`store` enable the same drill-down recovery `buildToolCallDetail`
 * applies to `resultText` — a subagent launch's `returnedText` is the parent-
 * side `tool_result` of the SAME Agent/Task call, subject to the identical
 * parser cap. `returnedTextFullCharCount` stays set only when recovery
 * didn't fully close the gap, same "still short of the truth" contract as
 * `resultTextFullCharCount`.
 */
async function buildSubagentDetail(
  call: ToolCall,
  ref: SubagentRef | undefined,
  opts: TimelineOptions,
  store: ClaudeSessionStore,
  filePath: string | undefined,
): Promise<SubagentLaunchRecordDetail> {
  const input = asRecord(call.input);
  const agentType = ref?.meta.agentType ?? strField(input, "subagent_type");
  const name = ref?.meta.description ?? strField(input, "description");
  const inputModel = strField(input, "model");
  const prompt = strField(input, "prompt");
  const returnedText =
    call.result === undefined
      ? undefined
      : await resolveFullResultText(call.result, call.toolUseId, filePath, store);

  const detail: SubagentLaunchRecordDetail = {
    kind: "subagent-launch",
    toolUseId: call.toolUseId,
    line: call.line,
    ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
    ...(ref !== undefined && { agentId: ref.agentId }),
    ...(agentType !== undefined && { agentType }),
    ...(name !== undefined && { name }),
    ...(inputModel !== undefined && { model: inputModel }),
    ...(prompt !== undefined && { prompt }),
    ...(call.result !== undefined &&
      returnedText !== undefined && {
        returnedText,
        resultLine: call.result.line,
        ...(call.result.timestamp !== undefined && { resultTimestamp: call.result.timestamp }),
        ...(call.result.fullTextLength > returnedText.length && {
          returnedTextFullCharCount: call.result.fullTextLength,
        }),
      }),
  };

  if (ref !== undefined && opts.mainFilePath !== undefined) {
    const usage = await resolveSubagentUsage(ref, opts.mainFilePath, store);
    if (usage !== undefined) {
      if (usage.model !== undefined) detail.model = usage.model;
      detail.outputTokens = usage.outputTokens;
      detail.costUsd = usage.costUsd;
      detail.costIsComplete = usage.costIsComplete;
      detail.toolCallCount = usage.toolCallCount;
      detail.toolErrorCount = usage.toolErrorCount;
      if (usage.durationMs !== undefined) detail.durationMs = usage.durationMs;
    }
  }

  return detail;
}

function buildTaskNotificationDetail(
  notification: TaskNotificationInfo,
  line: number,
  timestamp: string | undefined,
  data: SessionData,
): TaskNotificationRecordDetail {
  const launch = data.backgroundLaunches.find((l) => l.taskId === notification.taskId);
  const toolCallsById = new Map(data.toolCalls.map((c) => [c.toolUseId, c]));
  const call = launchingCall(launch, toolCallsById);
  const startTimestamp = call?.timestamp ?? launch?.timestamp;
  const startLine = call?.line ?? launch?.line;
  const durationMs = durationBetween(startTimestamp, timestamp);
  return {
    kind: "task-notification",
    taskId: notification.taskId,
    background: true,
    line,
    ...(timestamp !== undefined && { timestamp }),
    ...(launch !== undefined && { name: launch.name }),
    ...(notification.status !== undefined && { status: notification.status }),
    ...(notification.exitCode !== undefined && { exitCode: notification.exitCode }),
    ...(durationMs !== undefined && { durationMs }),
    ...(startLine !== undefined && { startLine }),
  };
}

// ---------------------------------------------------------------------------
// getClaudeToolCallDetail
// ---------------------------------------------------------------------------

/**
 * One tool call and everything associated with it, as a single evidence
 * unit — the call (full input, source line), its result (full text, source
 * line, error status) when resolved, and any records the parser already
 * links to it (today: a background launch's completion notification via
 * `toolUseId` -> `taskId`). Distinct from `getClaudeRecordDetail`: that
 * resolves ONE source line; this resolves one `toolUseId` regardless of
 * which (different) lines the call and its result live on.
 *
 * `undefined` when no tool call with this `toolUseId` exists in `data` —
 * callers can't distinguish "unknown id" from "wrong session" here, same as
 * `getClaudeRecordDetail`'s `undefined` for an unaddressable line; the MCP
 * layer resolves the session separately before calling this.
 *
 * `store` (defaults to the local filesystem) enables the same drill-down
 * recovery `getClaudeRecordDetail` applies — when the result's captured text
 * was capped by the parser's `TOOL_RESULT_TEXT_LIMIT`, this re-reads `data
 * .filePath`'s raw source line to recover the true text (see
 * `resolveFullResultText`) before applying the caller's own cap.
 * `result.fullTextLength` stays set on the response only when recovery
 * didn't fully close the gap (unset once `result.text` is genuinely
 * complete) — same "still short of the truth" contract it always had.
 */
export async function getClaudeToolCallDetail(
  data: SessionData,
  toolUseId: string,
  store: ClaudeSessionStore = localClaudeSessionStore,
): Promise<ToolCallDetail | undefined> {
  const call = data.toolCalls.find((c) => c.toolUseId === toolUseId);
  if (call === undefined) return undefined;

  // The assistant record that carried this tool_use block — its `uuid` is
  // useful cross-reference context, already in `data.records` at zero extra
  // read/parse cost.
  const containingRecord = data.records.find(
    (r): r is AssistantRecord => r.type === "assistant" && "blocks" in r && r.line === call.line,
  );

  const launch = data.backgroundLaunches.find((l) => l.toolUseId === toolUseId);
  const relatedRecords: ToolCallRelatedRecord[] =
    launch === undefined
      ? []
      : data.taskNotifications
          .filter((n) => n.taskId === launch.taskId)
          .map((n) => ({
            kind: "task-notification" as const,
            taskId: n.taskId,
            line: n.line,
            ...(n.timestamp !== undefined && { timestamp: n.timestamp }),
            ...(n.status !== undefined && { status: n.status }),
            ...(n.exitCode !== undefined && { exitCode: n.exitCode }),
          }));

  const resultText =
    call.result === undefined
      ? undefined
      : await resolveFullResultText(call.result, toolUseId, data.filePath, store);

  return {
    toolUseId,
    call: {
      name: call.name,
      input: call.input,
      line: call.line,
      ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
      ...(containingRecord?.uuid !== undefined && { uuid: containingRecord.uuid }),
    },
    result:
      call.result === undefined || resultText === undefined
        ? null
        : {
            isError: call.result.isError,
            text: resultText,
            ...(call.result.fullTextLength > resultText.length && {
              fullTextLength: call.result.fullTextLength,
            }),
            line: call.result.line,
            ...(call.result.timestamp !== undefined && { timestamp: call.result.timestamp }),
          },
    resultMissing: call.result === undefined,
    relatedRecords,
  };
}
