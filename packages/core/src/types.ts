/**
 * Lenient record model for Claude Code session JSONL files.
 *
 * The on-disk schema drifts across Claude Code versions, so every field is
 * optional except `type`. Unknown record types are preserved as `OtherRecord`
 * and counted, never fatal.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Ephemeral cache-creation breakdown when present. */
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
}

export interface ContentBlockText {
  kind: "text";
  text: string;
}

export interface ContentBlockThinking {
  kind: "thinking";
  /** Character length only — thinking content itself is not retained. */
  length: number;
}

export interface ContentBlockToolUse {
  kind: "tool_use";
  toolUseId: string;
  name: string;
  input: unknown;
}

export type AssistantContentBlock = ContentBlockText | ContentBlockThinking | ContentBlockToolUse;

export interface RecordBase {
  /** 1-based line number in the JSONL file — provenance anchor. */
  line: number;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  agentId?: string;
}

export interface UserRecord extends RecordBase {
  type: "user";
  /** Plain-text content of a human prompt (undefined for tool-result carriers). */
  promptText?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  toolResults: ToolResultInfo[];
}

export interface ToolResultInfo {
  toolUseId: string;
  isError: boolean;
  /** Extracted text content (truncated), for error classification. */
  text: string;
}

export interface AssistantRecord extends RecordBase {
  type: "assistant";
  requestId?: string;
  messageId?: string;
  model?: string;
  usage?: TokenUsage;
  blocks: AssistantContentBlock[];
}

export interface CompactBoundaryRecord extends RecordBase {
  type: "system";
  subtype: "compact_boundary";
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

export interface ApiErrorRecord extends RecordBase {
  type: "system";
  subtype: "api_error";
  retryAttempt?: number;
}

export interface OtherSystemRecord extends RecordBase {
  type: "system";
  subtype?: string;
}

export type SystemRecord = CompactBoundaryRecord | ApiErrorRecord | OtherSystemRecord;

export interface TitleRecord {
  line: number;
  type: "ai-title" | "custom-title";
  title: string;
}

export interface OtherRecord {
  line: number;
  type: string;
}

export type SessionRecord = UserRecord | AssistantRecord | SystemRecord | TitleRecord | OtherRecord;

export interface ParseWarning {
  line: number;
  reason: string;
}

export interface Transcript {
  filePath: string;
  records: SessionRecord[];
  warnings: ParseWarning[];
}
