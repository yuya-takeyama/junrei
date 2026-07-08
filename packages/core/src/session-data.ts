import type {
  AssistantRecord,
  SessionRecord,
  TokenUsage,
  Transcript,
  UserRecord,
} from "./types.js";

/** One deduplicated API message (usage is repeated across JSONL records). */
export interface ApiMessage {
  messageId: string;
  model?: string;
  usage?: TokenUsage;
  timestamp?: string;
  line: number;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  messageId?: string;
  line: number;
  timestamp?: string;
  result?: {
    isError: boolean;
    text: string;
    line: number;
    timestamp?: string;
  };
}

export interface UserPrompt {
  text: string;
  timestamp?: string;
  line: number;
}

export interface CompactionEvent {
  line: number;
  timestamp?: string;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

/** A task launched into the background: Bash (run_in_background) or async Agent. */
export interface BackgroundLaunch {
  kind: "bash" | "agent";
  taskId: string;
  name: string;
  toolUseId?: string;
  line: number;
  timestamp?: string;
}

/** Harness-injected completion notice for a background task. */
export interface TaskNotificationEvent {
  taskId: string;
  status?: string;
  exitCode?: number;
  line: number;
  timestamp?: string;
}

/** Structured view of one transcript, ready for metric computation. */
export interface SessionData {
  records: SessionRecord[];
  apiMessages: ApiMessage[];
  toolCalls: ToolCall[];
  userPrompts: UserPrompt[];
  compactions: CompactionEvent[];
  backgroundLaunches: BackgroundLaunch[];
  taskNotifications: TaskNotificationEvent[];
  apiErrorCount: number;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  warningCount: number;
}

export function buildSessionData(transcript: Transcript): SessionData {
  const apiMessagesById = new Map<string, ApiMessage>();
  const toolCalls: ToolCall[] = [];
  const toolCallsById = new Map<string, ToolCall>();
  // Results can appear BEFORE their tool_use record in file order (parallel
  // batches interleave); unmatched results are parked here and linked after
  // the full pass.
  const pendingResults = new Map<string, NonNullable<ToolCall["result"]>>();
  const userPrompts: UserPrompt[] = [];
  const compactions: CompactionEvent[] = [];
  const backgroundLaunches: BackgroundLaunch[] = [];
  const taskNotifications: TaskNotificationEvent[] = [];
  let apiErrorCount = 0;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const record of transcript.records) {
    if ("timestamp" in record && record.timestamp !== undefined) {
      firstTimestamp ??= record.timestamp;
      lastTimestamp = record.timestamp;
    }
    if ("cwd" in record && record.cwd !== undefined) cwd ??= record.cwd;
    if ("gitBranch" in record && record.gitBranch !== undefined) gitBranch ??= record.gitBranch;
    if ("version" in record && record.version !== undefined) version ??= record.version;

    switch (record.type) {
      case "assistant":
        if ("blocks" in record) {
          collectAssistant(record, apiMessagesById, toolCalls, toolCallsById);
        }
        break;
      case "user":
        if ("toolResults" in record) {
          collectUser(
            record,
            userPrompts,
            toolCallsById,
            pendingResults,
            backgroundLaunches,
            taskNotifications,
          );
        }
        break;
      case "system":
        if ("subtype" in record && record.subtype === "compact_boundary") {
          compactions.push({
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            ...("trigger" in record && record.trigger !== undefined && { trigger: record.trigger }),
            ...("preTokens" in record &&
              record.preTokens !== undefined && { preTokens: record.preTokens }),
            ...("postTokens" in record &&
              record.postTokens !== undefined && { postTokens: record.postTokens }),
          });
        } else if ("subtype" in record && record.subtype === "api_error") {
          apiErrorCount += 1;
        }
        break;
      case "queue-operation":
      case "attachment":
        if ("taskNotification" in record) {
          taskNotifications.push({
            taskId: record.taskNotification.taskId,
            line: record.line,
            ...(record.taskNotification.status !== undefined && {
              status: record.taskNotification.status,
            }),
            ...(record.taskNotification.exitCode !== undefined && {
              exitCode: record.taskNotification.exitCode,
            }),
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
          });
        }
        break;
      case "ai-title":
        if ("title" in record) aiTitle = record.title;
        break;
      case "custom-title":
        if ("title" in record) customTitle = record.title;
        break;
      default:
        break;
    }
  }

  // Second pass: link results that arrived before their tool_use record.
  for (const [toolUseId, result] of pendingResults) {
    const call = toolCallsById.get(toolUseId);
    if (call !== undefined && call.result === undefined) {
      call.result = result;
    }
  }

  const title = customTitle ?? aiTitle;
  return {
    records: transcript.records,
    apiMessages: [...apiMessagesById.values()],
    toolCalls,
    userPrompts,
    compactions,
    backgroundLaunches,
    taskNotifications,
    apiErrorCount,
    ...(title !== undefined && { title }),
    ...(cwd !== undefined && { cwd }),
    ...(gitBranch !== undefined && { gitBranch }),
    ...(version !== undefined && { version }),
    ...(firstTimestamp !== undefined && { firstTimestamp }),
    ...(lastTimestamp !== undefined && { lastTimestamp }),
    warningCount: transcript.warnings.length,
  };
}

function collectAssistant(
  record: AssistantRecord,
  apiMessagesById: Map<string, ApiMessage>,
  toolCalls: ToolCall[],
  toolCallsById: Map<string, ToolCall>,
): void {
  // Dedupe usage by message.id: each JSONL record carries one content block
  // of the same API message with identical usage.
  if (record.messageId !== undefined && !apiMessagesById.has(record.messageId)) {
    apiMessagesById.set(record.messageId, {
      messageId: record.messageId,
      line: record.line,
      ...(record.model !== undefined && { model: record.model }),
      ...(record.usage !== undefined && { usage: record.usage }),
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    });
  }
  for (const block of record.blocks) {
    if (block.kind !== "tool_use") continue;
    const call: ToolCall = {
      toolUseId: block.toolUseId,
      name: block.name,
      input: block.input,
      line: record.line,
      ...(record.messageId !== undefined && { messageId: record.messageId }),
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    };
    toolCalls.push(call);
    toolCallsById.set(block.toolUseId, call);
  }
}

function collectUser(
  record: UserRecord,
  userPrompts: UserPrompt[],
  toolCallsById: Map<string, ToolCall>,
  pendingResults: Map<string, NonNullable<ToolCall["result"]>>,
  backgroundLaunches: BackgroundLaunch[],
  taskNotifications: TaskNotificationEvent[],
): void {
  for (const result of record.toolResults) {
    const resolved = {
      isError: result.isError,
      text: result.text,
      line: record.line,
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    };
    const call = toolCallsById.get(result.toolUseId);
    if (call !== undefined) {
      if (call.result === undefined) call.result = resolved;
    } else if (!pendingResults.has(result.toolUseId)) {
      pendingResults.set(result.toolUseId, resolved);
    }
  }
  if (record.taskNotification !== undefined) {
    taskNotifications.push({
      taskId: record.taskNotification.taskId,
      line: record.line,
      ...(record.taskNotification.status !== undefined && {
        status: record.taskNotification.status,
      }),
      ...(record.taskNotification.exitCode !== undefined && {
        exitCode: record.taskNotification.exitCode,
      }),
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    });
  }
  if (record.toolUseDetail !== undefined) {
    collectBackgroundLaunch(record, toolCallsById, backgroundLaunches);
  }
  if (
    record.promptText !== undefined &&
    record.isMeta !== true &&
    record.isCompactSummary !== true
  ) {
    userPrompts.push({
      text: record.promptText,
      line: record.line,
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    });
  }
}

const LAUNCH_NAME_LIMIT = 120;

function collectBackgroundLaunch(
  record: UserRecord,
  toolCallsById: Map<string, ToolCall>,
  backgroundLaunches: BackgroundLaunch[],
): void {
  const detail = record.toolUseDetail;
  if (detail === undefined) return;
  const toolUseId = record.toolResults[0]?.toolUseId;
  const call = toolUseId !== undefined ? toolCallsById.get(toolUseId) : undefined;
  const input =
    typeof call?.input === "object" && call.input !== null
      ? (call.input as Record<string, unknown>)
      : undefined;

  if (detail.backgroundTaskId !== undefined) {
    const description = typeof input?.description === "string" ? input.description : undefined;
    const command = typeof input?.command === "string" ? input.command : undefined;
    backgroundLaunches.push({
      kind: "bash",
      taskId: detail.backgroundTaskId,
      name: (description ?? command ?? "background command").slice(0, LAUNCH_NAME_LIMIT),
      line: record.line,
      ...(toolUseId !== undefined && { toolUseId }),
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    });
  }
  if (detail.asyncAgentId !== undefined) {
    const description = typeof input?.description === "string" ? input.description : undefined;
    backgroundLaunches.push({
      kind: "agent",
      taskId: detail.asyncAgentId,
      name: (detail.asyncAgentDescription ?? description ?? "subagent").slice(0, LAUNCH_NAME_LIMIT),
      line: record.line,
      ...(toolUseId !== undefined && { toolUseId }),
      ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
    });
  }
}
