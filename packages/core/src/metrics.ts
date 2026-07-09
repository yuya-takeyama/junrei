import { estimateCostComponents } from "./pricing/pricing.js";
import type { SessionData, TaskNotificationEvent, ToolCall, UserPrompt } from "./session-data.js";
import type { SessionRecord } from "./types.js";

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

// ---------------------------------------------------------------------------
// File access (Files & skills lens, row 1)
// ---------------------------------------------------------------------------

/** One transcript's own read/edit/injection tally for a single file path. */
export interface FileAccessAgg {
  path: string;
  reads: number;
  edits: number;
  /**
   * Count of times this path's content was pushed into context WITHOUT a
   * Read/Edit tool call — CLAUDE.md/MEMORY.md "Contents of ...:" system-reminder
   * headers and Skill `SKILL.md` loads (see `computeFileAccess`). A path can be
   * injected-only (reads/edits both 0) — it was loaded into context, just never
   * opened by the agent itself.
   */
  injectedCount?: number;
  /** Cumulative injected character count, paired with `injectedCount`. */
  injectedChars?: number;
  /** Earliest timestamp among this transcript's touches of the path. */
  firstTimestamp?: string;
  /** Earliest line among this transcript's touches of the path. */
  firstLine?: number;
}

export type FileAccessThread = "main" | "subagent" | "both";

export interface FileAccessEntry {
  /** Path as given in the tool input (absolute). */
  path: string;
  /** Read + NotebookRead calls, main + every subagent, merged. */
  reads: number;
  /** Edit + Write + MultiEdit + NotebookEdit calls, main + every subagent, merged. */
  edits: number;
  /** Context injections of this path, main + every subagent, merged — see `FileAccessAgg.injectedCount`. */
  injectedCount?: number;
  /** Cumulative injected character count, paired with `injectedCount`. */
  injectedChars?: number;
  /** Earliest timestamp across every transcript that touched this path. */
  firstTouchTimestamp?: string;
  /** Line of the first MAIN-transcript touch, if any — omitted when only subagents touched the path. */
  firstTouchLine?: number;
  threads: FileAccessThread;
}

export interface FileAccessResult {
  fileAccess: FileAccessEntry[];
  /** True when the merged path count exceeded the cap and entries were dropped. */
  fileAccessTruncated: boolean;
  /** Number of distinct paths dropped by the cap — present only when truncated. */
  fileAccessOmittedCount?: number;
}

const FILE_READ_TOOLS = new Set(["Read", "NotebookRead"]);
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FILE_ACCESS_CAP = 500;

/**
 * "Contents of <abs-path> (<label>):" headers the harness injects into a user
 * turn's text — CLAUDE.md (project + global) and the auto-memory MEMORY.md,
 * both bare and wrapped in a `<system-reminder>` block. Anchored at line start
 * with a trailing ":" after a parenthesized label so ordinary prose never
 * matches, and only absolute paths qualify.
 */
const CONTENTS_OF_HEADER = /^Contents of (\/.+?) \([^)]*\):$/gm;

interface ContentsOfInjection {
  path: string;
  chars: number;
  line: number;
  timestamp?: string;
}

/**
 * Every "Contents of ...:" header found in any record's `promptText` (not
 * just non-meta `userPrompts` — mirrors `computeSkillInvocations`'s
 * defensive direct scan of `data.records`). When one turn injects several
 * files, a header's body is the span up to the NEXT header (or end of text)
 * — the actual injected span, not a per-file guess.
 */
function collectContentsOfInjections(records: readonly SessionRecord[]): ContentsOfInjection[] {
  const injections: ContentsOfInjection[] = [];
  for (const record of records) {
    if (!("promptText" in record) || record.promptText === undefined) continue;
    const text = record.promptText;
    const matches = [...text.matchAll(CONTENTS_OF_HEADER)];
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i];
      const path = match?.[1];
      if (match?.index === undefined || path === undefined) continue;
      const bodyStart = match.index + match[0].length;
      const bodyEnd = matches[i + 1]?.index ?? text.length;
      injections.push({
        path,
        chars: bodyEnd - bodyStart,
        line: record.line,
        ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      });
    }
  }
  return injections;
}

/**
 * Per-transcript file-access tally — Grep/Glob/LS are deliberately excluded
 * (searches, not file touches). Calls with a missing or non-string
 * `file_path` are skipped. `toolCalls` is already in ascending line order
 * (see `buildSessionData`), so the first call touching a path is naturally
 * its first touch — no need to compare timestamps across entries.
 *
 * Beyond Read/Edit tool calls, this also tallies context INJECTIONS of a
 * path — content that entered the model's context without any tool call:
 * CLAUDE.md/MEMORY.md "Contents of ...:" headers (`collectContentsOfInjections`
 * above) and Skill `SKILL.md` loads (`collectSkillFileInjections`, defined
 * with the rest of the skill-injection matching further down this file, which
 * this reuses). A path can end up injected-only (reads/edits both 0).
 */
export function computeFileAccess(data: SessionData): Map<string, FileAccessAgg> {
  const map = new Map<string, FileAccessAgg>();

  const touch = (path: string, line: number, timestamp: string | undefined): FileAccessAgg => {
    let entry = map.get(path);
    if (entry === undefined) {
      entry = {
        path,
        reads: 0,
        edits: 0,
        firstLine: line,
        ...(timestamp !== undefined && { firstTimestamp: timestamp }),
      };
      map.set(path, entry);
    } else {
      if (line < (entry.firstLine ?? line)) entry.firstLine = line;
      if (
        timestamp !== undefined &&
        (entry.firstTimestamp === undefined || timestamp < entry.firstTimestamp)
      ) {
        entry.firstTimestamp = timestamp;
      }
    }
    return entry;
  };

  for (const call of data.toolCalls) {
    const isRead = FILE_READ_TOOLS.has(call.name);
    const isEdit = FILE_EDIT_TOOLS.has(call.name);
    if (!isRead && !isEdit) continue;
    const input =
      typeof call.input === "object" && call.input !== null
        ? (call.input as Record<string, unknown>)
        : undefined;
    const filePath = typeof input?.file_path === "string" ? input.file_path : undefined;
    if (filePath === undefined) continue;

    const entry = touch(filePath, call.line, call.timestamp);
    if (isRead) entry.reads += 1;
    else entry.edits += 1;
  }

  for (const injection of collectContentsOfInjections(data.records)) {
    const entry = touch(injection.path, injection.line, injection.timestamp);
    entry.injectedCount = (entry.injectedCount ?? 0) + 1;
    entry.injectedChars = (entry.injectedChars ?? 0) + injection.chars;
  }
  for (const injection of collectSkillFileInjections(data)) {
    const entry = touch(injection.path, injection.line, injection.timestamp);
    entry.injectedCount = (entry.injectedCount ?? 0) + 1;
    entry.injectedChars = (entry.injectedChars ?? 0) + injection.chars;
  }

  return map;
}

/**
 * Merge one main transcript's file-access map with the (already-summed)
 * combined map from every subagent transcript, then cap the result — see
 * `FileAccessEntry`'s field docs for the exact semantics of each derived
 * field (`firstTouchLine` only ever comes from the main transcript;
 * `firstTouchTimestamp` is the earliest across all transcripts).
 *
 * Cap: when the merged path count exceeds `FILE_ACCESS_CAP`, keep the 500
 * paths with the highest `reads + edits`, breaking ties by path (stable)
 * so the kept set is deterministic — then re-sort the kept entries back to
 * path order for display.
 */
export function mergeFileAccess(
  main: ReadonlyMap<string, FileAccessAgg>,
  subagents: ReadonlyMap<string, FileAccessAgg>,
): FileAccessResult {
  const paths = new Set([...main.keys(), ...subagents.keys()]);
  const entries: FileAccessEntry[] = [];
  for (const path of paths) {
    const m = main.get(path);
    const s = subagents.get(path);
    const reads = (m?.reads ?? 0) + (s?.reads ?? 0);
    const edits = (m?.edits ?? 0) + (s?.edits ?? 0);
    const injectedCount = (m?.injectedCount ?? 0) + (s?.injectedCount ?? 0);
    const injectedChars = (m?.injectedChars ?? 0) + (s?.injectedChars ?? 0);
    const threads: FileAccessThread =
      m !== undefined && s !== undefined ? "both" : m !== undefined ? "main" : "subagent";
    let firstTouchTimestamp: string | undefined;
    if (m?.firstTimestamp !== undefined && s?.firstTimestamp !== undefined) {
      firstTouchTimestamp =
        m.firstTimestamp < s.firstTimestamp ? m.firstTimestamp : s.firstTimestamp;
    } else {
      firstTouchTimestamp = m?.firstTimestamp ?? s?.firstTimestamp;
    }
    entries.push({
      path,
      reads,
      edits,
      ...(injectedCount > 0 && { injectedCount }),
      ...(injectedChars > 0 && { injectedChars }),
      ...(firstTouchTimestamp !== undefined && { firstTouchTimestamp }),
      ...(m?.firstLine !== undefined && { firstTouchLine: m.firstLine }),
      threads,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length <= FILE_ACCESS_CAP) {
    return { fileAccess: entries, fileAccessTruncated: false };
  }

  const omittedCount = entries.length - FILE_ACCESS_CAP;
  // Injections count toward the keep-score too — an injected-only file (e.g.
  // CLAUDE.md) would otherwise always score 0 and be the first dropped.
  const score = (e: FileAccessEntry) => e.reads + e.edits + (e.injectedCount ?? 0);
  const kept = [...entries]
    .sort((a, b) => {
      const scoreDiff = score(b) - score(a);
      return scoreDiff !== 0 ? scoreDiff : a.path.localeCompare(b.path);
    })
    .slice(0, FILE_ACCESS_CAP)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { fileAccess: kept, fileAccessTruncated: true, fileAccessOmittedCount: omittedCount };
}

/** Fold `source` into `target` in place — sums reads/edits/injections, keeps the earliest timestamp/line. */
export function foldFileAccess(
  target: Map<string, FileAccessAgg>,
  source: ReadonlyMap<string, FileAccessAgg>,
): void {
  for (const [path, entry] of source) {
    const existing = target.get(path);
    if (existing === undefined) {
      target.set(path, { ...entry });
      continue;
    }
    existing.reads += entry.reads;
    existing.edits += entry.edits;
    if (entry.injectedCount !== undefined) {
      existing.injectedCount = (existing.injectedCount ?? 0) + entry.injectedCount;
    }
    if (entry.injectedChars !== undefined) {
      existing.injectedChars = (existing.injectedChars ?? 0) + entry.injectedChars;
    }
    if (
      entry.firstTimestamp !== undefined &&
      (existing.firstTimestamp === undefined || entry.firstTimestamp < existing.firstTimestamp)
    ) {
      existing.firstTimestamp = entry.firstTimestamp;
    }
    if (
      entry.firstLine !== undefined &&
      (existing.firstLine === undefined || entry.firstLine < existing.firstLine)
    ) {
      existing.firstLine = entry.firstLine;
    }
  }
}

// ---------------------------------------------------------------------------
// Skill invocations (Files & skills lens, row 1 right column)
// ---------------------------------------------------------------------------

export interface SkillInvocation {
  /** Skill tool call vs a `<command-name>` slash-command user record. */
  kind: "skill" | "command";
  /** `input.skill` for a Skill call, or the command name (incl. leading "/") for a slash command. */
  name: string;
  /** `input.args` / `<command-args>` content, capped at `DETAIL_LIMIT` chars. */
  argsPreview?: string;
  line: number;
  timestamp?: string;
  /** 1-based user-turn index — same greatest-prompt-line-<= attribution as `computeTurnUsage`. */
  userTurn?: number;
  /**
   * Skill tool only: full (untruncated) length of the tool_result text, when
   * known. For a `Skill` call this is just the ~44-char "Launching skill: …"
   * acknowledgment — see `injectedChars` for the actual context payload.
   */
  resultChars?: number;
  /**
   * Skill tool only: full length of the harness-injected SKILL.md body (the
   * `isMeta` user record matched via `findInjection` below), when found. This
   * — not `resultChars` — is the number that matters for context/cost
   * analysis. Undefined when no matching injection record exists: older
   * transcript formats, or skills whose frontmatter renders a templated
   * prompt instead of injecting the file verbatim (observed for
   * `commit-commands:*`, whose injected text starts with "## Context", never
   * "Base directory for this skill:") — never guessed.
   */
  injectedChars?: number;
  /** Source line of the matched injection record (provenance), paired with `injectedChars`. */
  injectionLine?: number;
}

const COMMAND_NAME_PATTERN = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_PATTERN = /<command-args>([^<]*)<\/command-args>/;
const INJECTION_PREFIX = "Base directory for this skill:";

interface InjectionCandidate {
  line: number;
  timestamp?: string;
  /** Absolute base directory exactly as reported by the harness — `collectSkillFileInjections` joins this with `/SKILL.md`. */
  basePath: string;
  /** Trailing path segment of the base directory — see `skillShortName`. */
  shortName: string;
  chars: number;
  consumed: boolean;
}

/**
 * `input.skill` values are sometimes `plugin:skill` (e.g.
 * `anthropic-skills:skill-creator`), but the on-disk base directory the
 * harness injects never reproduces the plugin prefix — verified against real
 * transcripts, where the same invocation's injection base directory ends in
 * plain `.../skills/skill-creator` (observed under a
 * `local-agent-mode-sessions/skills-plugin/<uuid>/<uuid>/skills/<name>` path
 * for plugin skills, and `.claude/skills/<name>` / a `bundled-skills/<hash>/
 * <name>` path for project/bundled ones). So matching is done on the trailing
 * path segment against the part of `input.skill` after the last `:`.
 */
function skillShortName(skillId: string): string {
  const idx = skillId.lastIndexOf(":");
  return idx === -1 ? skillId : skillId.slice(idx + 1);
}

/**
 * Every `isMeta` user record whose text is a skill-body injection, in file
 * order — one candidate per record, each consumable by at most one `Skill`
 * invocation (see `findInjection`).
 */
function collectInjectionCandidates(records: readonly SessionRecord[]): InjectionCandidate[] {
  const candidates: InjectionCandidate[] = [];
  for (const record of records) {
    if (!("isMeta" in record) || record.isMeta !== true) continue;
    if (!("promptText" in record)) continue;
    const text = record.promptText;
    if (text === undefined || !text.startsWith(INJECTION_PREFIX)) continue;
    const newlineIndex = text.indexOf("\n");
    const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
    const basePath = firstLine.slice(INJECTION_PREFIX.length).trim();
    const segments = basePath.split("/").filter((segment) => segment !== "");
    const shortName = segments[segments.length - 1];
    if (shortName === undefined) continue;
    candidates.push({
      line: record.line,
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      basePath,
      shortName,
      chars: text.length,
      consumed: false,
    });
  }
  return candidates;
}

/**
 * Nearest-forward match: the first not-yet-consumed candidate after
 * `afterLine` whose base-directory short name matches `skillName`, scanning
 * candidates in ascending line order. Marks the match `consumed` so a later
 * invocation of the same skill name can't double-attribute it — this is what
 * makes multiple invocations (same or different skills) in one turn each get
 * their own payload instead of everyone grabbing the first injection record.
 */
function findInjection(
  candidates: InjectionCandidate[],
  afterLine: number,
  skillName: string,
): InjectionCandidate | undefined {
  const shortName = skillShortName(skillName);
  for (const candidate of candidates) {
    if (candidate.consumed || candidate.line <= afterLine || candidate.shortName !== shortName) {
      continue;
    }
    candidate.consumed = true;
    return candidate;
  }
  return undefined;
}

interface SkillFileInjection {
  path: string;
  chars: number;
  line: number;
  timestamp?: string;
}

/**
 * `<baseDir>/SKILL.md` context injections for THIS transcript's own `Skill`
 * tool calls — called from `computeFileAccess` above (forward reference; safe
 * since it only runs at call time, after the whole module has loaded). Reuses
 * `findInjection`'s nearest-forward matching rather than sharing state with
 * `computeSkillInvocations`, so it also covers subagent-invoked skills, which
 * `computeSkillInvocations` (main transcript only) never sees.
 */
function collectSkillFileInjections(data: SessionData): SkillFileInjection[] {
  const injections: SkillFileInjection[] = [];
  const candidates = collectInjectionCandidates(data.records);
  for (const call of data.toolCalls) {
    if (call.name !== "Skill") continue;
    const input =
      typeof call.input === "object" && call.input !== null
        ? (call.input as Record<string, unknown>)
        : undefined;
    const skillName = typeof input?.skill === "string" ? input.skill : undefined;
    if (skillName === undefined) continue;
    const injection = findInjection(candidates, call.result?.line ?? call.line, skillName);
    if (injection === undefined) continue;
    injections.push({
      path: `${injection.basePath}/SKILL.md`,
      chars: injection.chars,
      line: injection.line,
      ...(injection.timestamp !== undefined && { timestamp: injection.timestamp }),
    });
  }
  return injections;
}

/**
 * 1-based index of the user turn open at `line` — mirrors `computeTurnUsage`'s
 * "greatest prompt line at or before this line" attribution, without
 * building the full `TurnUsage[]` array. `undefined` only when there are no
 * user prompts at all; a line before the first prompt still falls into turn 1
 * (same fallback `computeTurnUsage` documents).
 */
function turnIndexForLine(prompts: readonly UserPrompt[], line: number): number | undefined {
  if (prompts.length === 0) return undefined;
  let idx = 0;
  for (let i = 1; i < prompts.length; i += 1) {
    const prompt = prompts[i];
    if (prompt !== undefined && prompt.line <= line) idx = i;
    else break;
  }
  return idx + 1;
}

/**
 * Skill/command invocations, MAIN transcript only (like `computeToolStats`).
 * Two independent sources, merged and sorted by line:
 *  - Skill tool calls (`name === "Skill"`, `input.skill` the skill id).
 *  - Slash-command user records — the parser captures their full XML-ish
 *    text as `promptText` unconditionally (see `parser.ts#normalizeUser`),
 *    so this scans `data.records` directly rather than `data.userPrompts`:
 *    that keeps detection working even if a future harness version starts
 *    marking these records `isMeta` (which would otherwise exclude them
 *    from `userPrompts`/turn counting, but not from this scan).
 */
export function computeSkillInvocations(data: SessionData): SkillInvocation[] {
  const invocations: SkillInvocation[] = [];
  const injectionCandidates = collectInjectionCandidates(data.records);

  for (const call of data.toolCalls) {
    if (call.name !== "Skill") continue;
    const input =
      typeof call.input === "object" && call.input !== null
        ? (call.input as Record<string, unknown>)
        : undefined;
    const skillName = typeof input?.skill === "string" ? input.skill : undefined;
    if (skillName === undefined) continue;
    const argsValue = input?.args;
    const argsPreview =
      typeof argsValue === "string" ? argsValue.slice(0, DETAIL_LIMIT) : undefined;
    const userTurn = turnIndexForLine(data.userPrompts, call.line);
    // Scan forward from the tool_result (falling back to the call itself when
    // unresolved) — the injection record always follows the ACK in file order.
    const injection = findInjection(injectionCandidates, call.result?.line ?? call.line, skillName);
    invocations.push({
      kind: "skill",
      name: skillName,
      line: call.line,
      ...(call.timestamp !== undefined && { timestamp: call.timestamp }),
      ...(argsPreview !== undefined && { argsPreview }),
      ...(userTurn !== undefined && { userTurn }),
      ...(call.result?.fullTextLength !== undefined && { resultChars: call.result.fullTextLength }),
      ...(injection !== undefined && {
        injectedChars: injection.chars,
        injectionLine: injection.line,
      }),
    });
  }

  for (const record of data.records) {
    if (!("promptText" in record) || record.promptText === undefined) continue;
    const nameMatch = COMMAND_NAME_PATTERN.exec(record.promptText);
    if (nameMatch?.[1] === undefined || nameMatch[1] === "") continue;
    const argsMatch = COMMAND_ARGS_PATTERN.exec(record.promptText);
    const argsPreview =
      argsMatch?.[1] !== undefined && argsMatch[1] !== ""
        ? argsMatch[1].slice(0, DETAIL_LIMIT)
        : undefined;
    const userTurn = turnIndexForLine(data.userPrompts, record.line);
    invocations.push({
      kind: "command",
      name: nameMatch[1],
      line: record.line,
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      ...(argsPreview !== undefined && { argsPreview }),
      ...(userTurn !== undefined && { userTurn }),
    });
  }

  return invocations.sort((a, b) => a.line - b.line);
}
