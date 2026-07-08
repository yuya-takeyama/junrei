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

/** Structured view of one transcript, ready for metric computation. */
export interface SessionData {
  records: SessionRecord[];
  apiMessages: ApiMessage[];
  toolCalls: ToolCall[];
  userPrompts: UserPrompt[];
  compactions: CompactionEvent[];
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
  const userPrompts: UserPrompt[] = [];
  const compactions: CompactionEvent[] = [];
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
          collectUser(record, userPrompts, toolCallsById);
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

  const title = customTitle ?? aiTitle;
  return {
    records: transcript.records,
    apiMessages: [...apiMessagesById.values()],
    toolCalls,
    userPrompts,
    compactions,
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
): void {
  for (const result of record.toolResults) {
    const call = toolCallsById.get(result.toolUseId);
    if (call !== undefined && call.result === undefined) {
      call.result = {
        isError: result.isError,
        text: result.text,
        line: record.line,
        ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      };
    }
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
