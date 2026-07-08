import { estimateCostUsd } from "./pricing/pricing.js";
import type { SessionData, ToolCall } from "./session-data.js";

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
}

export interface UsageSummary {
  byModel: ModelUsageSummary[];
  total: TokenTotals & { costUsd: number; costIsComplete: boolean };
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
    const cost = estimateCostUsd(model, message.usage);
    if (cost === undefined) {
      entry.unpriced = true;
    } else {
      entry.costUsd = (entry.costUsd ?? 0) + cost;
    }
  }

  const models = [...byModel.values()];
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costIsComplete: true,
  };
  for (const entry of models) {
    total.inputTokens += entry.inputTokens;
    total.outputTokens += entry.outputTokens;
    total.cacheReadTokens += entry.cacheReadTokens;
    total.cacheCreationTokens += entry.cacheCreationTokens;
    total.costUsd += entry.costUsd ?? 0;
    if (entry.unpriced) total.costIsComplete = false;
  }
  return {
    byModel: models.map(({ unpriced, ...rest }) => rest),
    total,
  };
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
