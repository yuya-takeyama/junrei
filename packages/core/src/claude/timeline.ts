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
 *    (`TOOL_RESULT_TEXT_LIMIT` in parser.ts); `resultLineCount` and full
 *    result text in record detail reflect that captured slice, not
 *    necessarily the tool's true output length.
 */

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
  type ToolCallEntry,
  type ToolCallRecordDetail,
  type ToolCallStatus,
  truncate,
  truncateOneLine,
} from "../shared/timeline.js";
import { computeUsage } from "./metrics.js";
import type { SessionData, ToolCall } from "./session-data.js";
import { asyncAgentLaunchToolUseIds } from "./session-data.js";
import { listSubagentRefs, loadSubagentSessionData, type SubagentRef } from "./subagents.js";
import type {
  AssistantRecord,
  ContentBlockText,
  ContentBlockThinking,
  ContentBlockToolUse,
  TaskNotificationInfo,
} from "./types.js";

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
): Promise<ResolvedSubagentUsage | undefined> {
  const data = await loadSubagentSessionData(mainFilePath, ref.agentId);
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

/** Ordered, log-derived reconstruction of an entire transcript for the Timeline lens. */
export async function buildClaudeTimeline(
  data: SessionData,
  opts: TimelineOptions = {},
): Promise<TimelineEntry[]> {
  const toolCallsById = new Map(data.toolCalls.map((c) => [c.toolUseId, c]));
  const launchByTaskId = new Map(data.backgroundLaunches.map((l) => [l.taskId, l]));
  const asyncLaunchIds = asyncAgentLaunchToolUseIds(data);

  const refByToolUseId = new Map<string, SubagentRef>();
  if (opts.mainFilePath !== undefined) {
    for (const ref of await listSubagentRefs(opts.mainFilePath)) {
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
            entries.push(buildAssistantTextEntry(record, block));
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
              );
              entries.push(entry);
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

function buildAssistantTextEntry(
  record: AssistantRecord,
  block: ContentBlockText,
): AssistantTextEntry {
  const { text, truncated } = truncate(block.text, ASSISTANT_TEXT_LIMIT);
  const costUsd =
    record.model !== undefined && record.usage !== undefined
      ? estimateCostUsd(record.model, record.usage)
      : undefined;
  return {
    kind: "assistant-text",
    text,
    truncated,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    ...(record.model !== undefined && { model: record.model }),
    ...(record.usage !== undefined && { outputTokens: record.usage.outputTokens }),
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

async function buildSubagentEntry(
  call: ToolCall,
  ref: SubagentRef | undefined,
  opts: TimelineOptions,
  isAsyncLaunch: boolean,
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
    const usage = await resolveSubagentUsage(ref, opts.mainFilePath);
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

/** Full record at one source line — for the Record detail (L3) slide-over. */
export async function getClaudeRecordDetail(
  data: SessionData,
  line: number,
  opts: TimelineOptions = {},
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
      if (isSubagentLaunchTool(call.name) || (await hasSubagentRef(call.toolUseId, opts))) {
        const ref = await findSubagentRef(call.toolUseId, opts);
        return buildSubagentDetail(call, ref, opts);
      }
      return buildToolCallDetail(call);
    }
    const text = record.blocks.find((b): b is ContentBlockText => b.kind === "text");
    if (text !== undefined) return buildAssistantTextDetail(record, text);
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

function buildAssistantTextDetail(
  record: AssistantRecord,
  block: ContentBlockText,
): AssistantTextRecordDetail {
  const costUsd =
    record.model !== undefined && record.usage !== undefined
      ? estimateCostUsd(record.model, record.usage)
      : undefined;
  return {
    kind: "assistant-text",
    text: block.text,
    line: record.line,
    ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    ...(record.model !== undefined && { model: record.model }),
    ...(record.usage !== undefined && { outputTokens: record.usage.outputTokens }),
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

function buildToolCallDetail(call: ToolCall): ToolCallRecordDetail {
  const status = toolCallStatus(call);
  const durationMs = durationBetween(call.timestamp, call.result?.timestamp);
  return {
    kind: "tool-call",
    toolUseId: call.toolUseId,
    name: call.name,
    input: call.input,
    status,
    line: call.line,
    ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
    ...(call.result !== undefined && {
      resultText: call.result.text,
      resultLineCount: countLines(call.result.text),
      resultLine: call.result.line,
      ...(call.result.timestamp !== undefined && { resultTimestamp: call.result.timestamp }),
    }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

async function findSubagentRef(
  toolUseId: string,
  opts: TimelineOptions,
): Promise<SubagentRef | undefined> {
  if (opts.mainFilePath === undefined) return undefined;
  const refs = await listSubagentRefs(opts.mainFilePath);
  return refs.find((r) => r.meta.toolUseId === toolUseId);
}

async function hasSubagentRef(toolUseId: string, opts: TimelineOptions): Promise<boolean> {
  return (await findSubagentRef(toolUseId, opts)) !== undefined;
}

async function buildSubagentDetail(
  call: ToolCall,
  ref: SubagentRef | undefined,
  opts: TimelineOptions,
): Promise<SubagentLaunchRecordDetail> {
  const input = asRecord(call.input);
  const agentType = ref?.meta.agentType ?? strField(input, "subagent_type");
  const name = ref?.meta.description ?? strField(input, "description");
  const inputModel = strField(input, "model");
  const prompt = strField(input, "prompt");

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
    ...(call.result !== undefined && {
      returnedText: call.result.text,
      resultLine: call.result.line,
      ...(call.result.timestamp !== undefined && { resultTimestamp: call.result.timestamp }),
    }),
  };

  if (ref !== undefined && opts.mainFilePath !== undefined) {
    const usage = await resolveSubagentUsage(ref, opts.mainFilePath);
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
