import { estimateCostComponents } from "./pricing/pricing.js";
import type { SessionData, TaskNotificationEvent, ToolCall } from "./session-data.js";

// ---------------------------------------------------------------------------
// Tokens & cost
// ---------------------------------------------------------------------------

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelUsageSummary extends TokenTotals {
  model: string;
  messageCount: number;
  /** undefined when the model has no known pricing. */
  costUsd?: number;
  /** The cache-creation ("cache write") slice of costUsd; undefined under the same conditions as costUsd. */
  cacheWriteCostUsd?: number;
}

export interface UsageSummary {
  byModel: ModelUsageSummary[];
  total: TokenTotals & { costUsd: number; costIsComplete: boolean; cacheWriteCostUsd?: number };
}

export function computeUsage(data: SessionData): UsageSummary {
  const byModel = new Map<string, ModelUsageSummary & { unpriced: boolean }>();
  for (const message of data.apiMessages) {
    if (message.usage === undefined) continue;
    const model = message.model ?? "unknown";
    let entry = byModel.get(model);
    if (entry === undefined) {
      entry = {
        model,
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        unpriced: false,
      };
      byModel.set(model, entry);
    }
    entry.messageCount += 1;
    entry.inputTokens += message.usage.inputTokens;
    entry.outputTokens += message.usage.outputTokens;
    entry.cacheReadTokens += message.usage.cacheReadTokens;
    entry.cacheCreationTokens += message.usage.cacheCreationTokens;
    const cost = estimateCostComponents(model, message.usage);
    if (cost === undefined) {
      entry.unpriced = true;
    } else {
      entry.costUsd = (entry.costUsd ?? 0) + cost.totalCost;
      entry.cacheWriteCostUsd = (entry.cacheWriteCostUsd ?? 0) + cost.cacheCreationCost;
    }
  }

  const models = [...byModel.values()];
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    cacheWriteCostUsd: 0,
    costIsComplete: true,
  };
  for (const entry of models) {
    total.inputTokens += entry.inputTokens;
    total.outputTokens += entry.outputTokens;
    total.cacheReadTokens += entry.cacheReadTokens;
    total.cacheCreationTokens += entry.cacheCreationTokens;
    total.costUsd += entry.costUsd ?? 0;
    total.cacheWriteCostUsd += entry.cacheWriteCostUsd ?? 0;
    if (entry.unpriced) total.costIsComplete = false;
  }
  return {
    byModel: models.map(({ unpriced, ...rest }) => rest),
    total,
  };
}

// ---------------------------------------------------------------------------
// Per-turn token composition
// ---------------------------------------------------------------------------

export interface TurnUsage {
  /** Source line of the user prompt that opened this turn. */
  line: number;
  timestamp?: string;
  /** Fresh (uncached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiMessageCount: number;
}

/**
 * Per-turn token composition, main transcript only — one entry per user
 * prompt (the same records `SessionData.userPrompts` collects), aggregating
 * every API message issued while answering it.
 *
 * Attribution: a message is folded into the turn opened by the greatest
 * prompt line at or before the message's own line; messages that somehow
 * precede the first prompt (rare) fall into that first turn. Sessions with
 * no user prompts return `[]`.
 *
 * Compaction boundaries are NOT folded into this array — callers interleave
 * `SessionData.compactions` (by line) between turns for display instead, so
 * this stays a pure per-turn token breakdown.
 */
export function computeTurnUsage(data: SessionData): TurnUsage[] {
  if (data.userPrompts.length === 0) return [];

  const turns: TurnUsage[] = data.userPrompts.map((prompt) => ({
    line: prompt.line,
    ...(prompt.timestamp !== undefined && { timestamp: prompt.timestamp }),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    apiMessageCount: 0,
  }));

  const messages = [...data.apiMessages].sort((a, b) => a.line - b.line);
  let turnIndex = 0;
  for (const message of messages) {
    if (message.usage === undefined) continue;
    while (
      turnIndex + 1 < turns.length &&
      (turns[turnIndex + 1] as TurnUsage).line <= message.line
    ) {
      turnIndex += 1;
    }
    const turn = turns[turnIndex] as TurnUsage;
    turn.inputTokens += message.usage.inputTokens;
    turn.outputTokens += message.usage.outputTokens;
    turn.cacheReadTokens += message.usage.cacheReadTokens;
    turn.cacheCreationTokens += message.usage.cacheCreationTokens;
    turn.apiMessageCount += 1;
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Context timeline
// ---------------------------------------------------------------------------

export interface ContextPoint {
  messageId: string;
  timestamp?: string;
  line: number;
  /** input + cache_read + cache_creation — the effective request context. */
  contextTokens: number;
  outputTokens: number;
}

export function computeContextTimeline(data: SessionData): ContextPoint[] {
  const points: ContextPoint[] = [];
  for (const message of data.apiMessages) {
    if (message.usage === undefined) continue;
    points.push({
      messageId: message.messageId,
      line: message.line,
      contextTokens:
        message.usage.inputTokens +
        message.usage.cacheReadTokens +
        message.usage.cacheCreationTokens,
      outputTokens: message.usage.outputTokens,
      ...(message.timestamp !== undefined && { timestamp: message.timestamp }),
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Tool stats & error classification
// ---------------------------------------------------------------------------

export type ToolErrorCategory =
  | "file-not-found"
  | "string-not-found"
  | "command-failed"
  | "permission-denied"
  | "interrupted"
  | "timeout"
  | "other";

const ERROR_PATTERNS: ReadonlyArray<readonly [ToolErrorCategory, RegExp]> = [
  [
    "file-not-found",
    /(file does not exist|no such file|not found: .*\.(ts|js|tsx|jsx|json|md)|ENOENT)/i,
  ],
  ["string-not-found", /(string to replace not found|old_string.*not found|not found in file)/i],
  [
    "permission-denied",
    /(permission denied|not allowed|denied by|requires approval|EACCES|user (declined|rejected|doesn't want))/i,
  ],
  ["interrupted", /(request interrupted|interrupted by user|\[interrupted\])/i],
  ["timeout", /(timed? ?out)/i],
  ["command-failed", /(exit code [1-9]|command failed|fatal:|error:)/i],
];

export function classifyToolError(text: string): ToolErrorCategory {
  for (const [category, pattern] of ERROR_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return "other";
}

export interface ToolStat {
  name: string;
  callCount: number;
  errorCount: number;
  /** Calls with no recorded result (session end, crash, streaming gap). */
  missingResultCount: number;
  errorCategories: Partial<Record<ToolErrorCategory, number>>;
}

export function computeToolStats(data: SessionData): ToolStat[] {
  const stats = new Map<string, ToolStat>();
  for (const call of data.toolCalls) {
    let stat = stats.get(call.name);
    if (stat === undefined) {
      stat = {
        name: call.name,
        callCount: 0,
        errorCount: 0,
        missingResultCount: 0,
        errorCategories: {},
      };
      stats.set(call.name, stat);
    }
    stat.callCount += 1;
    if (call.result === undefined) {
      stat.missingResultCount += 1;
    } else if (call.result.isError) {
      stat.errorCount += 1;
      const category = classifyToolError(call.result.text);
      stat.errorCategories[category] = (stat.errorCategories[category] ?? 0) + 1;
    }
  }
  return [...stats.values()].sort((a, b) => b.callCount - a.callCount);
}

// ---------------------------------------------------------------------------
// Repetition / loop detection
// ---------------------------------------------------------------------------

export interface RepetitionFinding {
  kind: "identical-call-run" | "file-reread" | "repeated-failure";
  tool: string;
  count: number;
  /** Human-readable identifier: command, file path, etc. (truncated). */
  subject: string;
  /** Line numbers of the involved tool_use records (provenance). */
  lines: number[];
}

const FILE_REREAD_THRESHOLD = 4;
const DETAIL_LIMIT = 200;

function callSubject(call: ToolCall): string {
  if (typeof call.input === "object" && call.input !== null) {
    const input = call.input as Record<string, unknown>;
    for (const key of ["file_path", "command", "pattern", "query", "url", "prompt"]) {
      const value = input[key];
      if (typeof value === "string") return value.slice(0, DETAIL_LIMIT);
    }
  }
  return JSON.stringify(call.input ?? null).slice(0, DETAIL_LIMIT);
}

export function computeRepetitions(data: SessionData): RepetitionFinding[] {
  const findings: RepetitionFinding[] = [];

  // 1. Runs of consecutive identical calls (same tool + identical input).
  let runStart = 0;
  const calls = data.toolCalls;
  for (let i = 1; i <= calls.length; i += 1) {
    const previous = calls[i - 1];
    const current = calls[i];
    const sameAsPrevious =
      current !== undefined &&
      previous !== undefined &&
      current.name === previous.name &&
      JSON.stringify(current.input) === JSON.stringify(previous.input);
    if (!sameAsPrevious) {
      const runLength = i - runStart;
      const first = calls[runStart];
      if (runLength >= 2 && first !== undefined) {
        findings.push({
          kind: "identical-call-run",
          tool: first.name,
          count: runLength,
          subject: callSubject(first),
          lines: calls.slice(runStart, i).map((c) => c.line),
        });
      }
      runStart = i;
    }
  }

  // 2. Same file read many times.
  const readsByFile = new Map<string, ToolCall[]>();
  for (const call of calls) {
    if (call.name !== "Read") continue;
    const input = call.input;
    if (typeof input !== "object" || input === null) continue;
    const filePath = (input as Record<string, unknown>).file_path;
    if (typeof filePath !== "string") continue;
    const list = readsByFile.get(filePath) ?? [];
    list.push(call);
    readsByFile.set(filePath, list);
  }
  for (const [filePath, reads] of readsByFile) {
    if (reads.length >= FILE_REREAD_THRESHOLD) {
      findings.push({
        kind: "file-reread",
        tool: "Read",
        count: reads.length,
        subject: filePath,
        lines: reads.map((c) => c.line),
      });
    }
  }

  // 3. The same failing call repeated (same tool + input, >= 2 error results).
  const failuresByKey = new Map<string, ToolCall[]>();
  for (const call of calls) {
    if (call.result?.isError !== true) continue;
    const key = `${call.name} ${JSON.stringify(call.input)}`;
    const list = failuresByKey.get(key) ?? [];
    list.push(call);
    failuresByKey.set(key, list);
  }
  for (const failures of failuresByKey.values()) {
    const first = failures[0];
    if (failures.length >= 2 && first !== undefined) {
      findings.push({
        kind: "repeated-failure",
        tool: first.name,
        count: failures.length,
        subject: callSubject(first),
        lines: failures.map((c) => c.line),
      });
    }
  }

  return findings.sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Task executions
// ---------------------------------------------------------------------------

export interface TaskExecutionInfo {
  kind: "bash" | "agent" | "preview-server";
  /** True when explicitly launched into the background (run_in_background / async agent). */
  background: boolean;
  taskId: string;
  name: string;
  status: "completed" | "failed" | "stopped" | "unresolved";
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  /** Line of the launching record (provenance). */
  startLine: number;
  completionLine?: number | undefined;
}

const PREVIEW_START_TOOL = "mcp__Claude_Preview__preview_start";
const PREVIEW_STOP_TOOL = "mcp__Claude_Preview__preview_stop";

/**
 * Reconstruct task executions the way Claude Code's Background-tasks panel
 * counts them: every Bash command and Agent run (foreground and background)
 * plus preview dev servers.
 *
 * Foreground executions complete with their tool_result (duration = result
 * timestamp − call timestamp, which includes harness/queue latency).
 * Background launches are joined with harness task-notifications by task id.
 * "unresolved" means no completion evidence exists in the log — e.g. the task
 * outlived the session.
 */
export function computeTaskExecutions(data: SessionData): TaskExecutionInfo[] {
  const tasks: TaskExecutionInfo[] = [];

  // Last notification per task id wins (agents can notify more than once).
  const notificationsByTask = new Map<string, TaskNotificationEvent>();
  for (const notification of data.taskNotifications) {
    notificationsByTask.set(notification.taskId, notification);
  }
  const launchesByToolUseId = new Map<string, (typeof data.backgroundLaunches)[number]>();
  for (const launch of data.backgroundLaunches) {
    if (launch.toolUseId !== undefined) launchesByToolUseId.set(launch.toolUseId, launch);
  }

  const stopsByServerId = new Map<string, ToolCall>();
  for (const call of data.toolCalls) {
    if (call.name !== PREVIEW_STOP_TOOL) continue;
    const serverId = stringInput(call, "serverId");
    if (serverId !== undefined) stopsByServerId.set(serverId, call);
  }

  for (const call of data.toolCalls) {
    if (call.name === "Bash" || call.name === "Agent" || call.name === "Task") {
      const kind = call.name === "Bash" ? "bash" : "agent";
      const launch = launchesByToolUseId.get(call.toolUseId);
      if (launch !== undefined) {
        // Background execution: completion comes from a task notification.
        const notification = notificationsByTask.get(launch.taskId);
        tasks.push({
          kind,
          background: true,
          taskId: launch.taskId,
          name: launch.name,
          status: backgroundStatus(notification),
          startLine: call.line,
          startedAt: call.timestamp ?? launch.timestamp,
          completedAt: notification?.timestamp,
          completionLine: notification?.line,
          durationMs: spanMs(call.timestamp ?? launch.timestamp, notification?.timestamp),
        });
      } else {
        // Foreground execution: the tool_result is the completion.
        const name =
          stringInput(call, "description") ??
          stringInput(call, "command") ??
          stringInput(call, "prompt") ??
          call.name;
        let status: TaskExecutionInfo["status"] = "unresolved";
        if (call.result !== undefined) {
          status = call.result.isError ? "failed" : "completed";
        }
        tasks.push({
          kind,
          background: false,
          taskId: call.toolUseId,
          name: name.slice(0, 120),
          status,
          startLine: call.line,
          startedAt: call.timestamp,
          completedAt: call.result?.timestamp,
          completionLine: call.result?.line,
          durationMs: spanMs(call.timestamp, call.result?.timestamp),
        });
      }
    } else if (call.name === PREVIEW_START_TOOL) {
      const name = stringInput(call, "name") ?? "preview server";
      const serverId = parseServerId(call.result?.text);
      const stop = serverId !== undefined ? stopsByServerId.get(serverId) : undefined;
      tasks.push({
        kind: "preview-server",
        background: true,
        taskId: serverId ?? `preview:${String(call.line)}`,
        name,
        status: stop !== undefined ? "stopped" : "unresolved",
        startLine: call.line,
        startedAt: call.timestamp,
        completedAt: stop?.timestamp,
        completionLine: stop?.line,
        durationMs: spanMs(call.timestamp, stop?.timestamp),
      });
    }
  }

  return tasks.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

function backgroundStatus(
  notification: TaskNotificationEvent | undefined,
): TaskExecutionInfo["status"] {
  if (notification === undefined) return "unresolved";
  if (notification.exitCode !== undefined) {
    return notification.exitCode === 0 ? "completed" : "failed";
  }
  if (notification.status === "failed") return "failed";
  return "completed";
}

function stringInput(call: ToolCall, key: string): string | undefined {
  if (typeof call.input !== "object" || call.input === null) return undefined;
  const value = (call.input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function parseServerId(resultText: string | undefined): string | undefined {
  if (resultText === undefined) return undefined;
  const match = /"serverId":\s*"([^"]+)"/.exec(resultText);
  return match?.[1];
}

function spanMs(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const delta = Date.parse(end) - Date.parse(start);
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

// ---------------------------------------------------------------------------
// Exploration profile
// ---------------------------------------------------------------------------

export interface ExplorationProfile {
  readToolCalls: number;
  editToolCalls: number;
  /** reads per edit; undefined when there are no edits. */
  readEditRatio?: number;
  distinctFilesRead: number;
  distinctFilesEdited: number;
  /** Index (1-based) of the user turn during which the first edit happened. */
  firstEditUserTurn?: number;
  /** Milliseconds from session start to the first edit tool call. */
  timeToFirstEditMs?: number;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function computeExploration(data: SessionData): ExplorationProfile {
  let readToolCalls = 0;
  let editToolCalls = 0;
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  let firstEdit: ToolCall | undefined;

  for (const call of data.toolCalls) {
    const input =
      typeof call.input === "object" && call.input !== null
        ? (call.input as Record<string, unknown>)
        : undefined;
    const filePath = typeof input?.file_path === "string" ? input.file_path : undefined;
    if (READ_TOOLS.has(call.name)) {
      readToolCalls += 1;
      if (call.name === "Read" && filePath !== undefined) filesRead.add(filePath);
    } else if (EDIT_TOOLS.has(call.name)) {
      editToolCalls += 1;
      if (filePath !== undefined) filesEdited.add(filePath);
      firstEdit ??= call;
    }
  }

  const profile: ExplorationProfile = {
    readToolCalls,
    editToolCalls,
    distinctFilesRead: filesRead.size,
    distinctFilesEdited: filesEdited.size,
  };
  if (editToolCalls > 0) {
    profile.readEditRatio = readToolCalls / editToolCalls;
  }
  if (firstEdit !== undefined) {
    let turn = 0;
    for (const prompt of data.userPrompts) {
      if (prompt.line > firstEdit.line) break;
      turn += 1;
    }
    if (turn > 0) profile.firstEditUserTurn = turn;
    if (firstEdit.timestamp !== undefined && data.firstTimestamp !== undefined) {
      const delta = Date.parse(firstEdit.timestamp) - Date.parse(data.firstTimestamp);
      if (Number.isFinite(delta) && delta >= 0) profile.timeToFirstEditMs = delta;
    }
  }
  return profile;
}
