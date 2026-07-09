import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseJsonlLine } from "../jsonl.js";
import type { ParseWarning } from "../types.js";
import {
  type CodexEnvelope,
  type CodexTokenUsage,
  codexEnvelopeSchema,
  codexEventAgentMessageSchema,
  codexEventExecCommandEndSchema,
  codexEventTaskCompleteSchema,
  codexEventTaskStartedSchema,
  codexEventThreadNameUpdatedSchema,
  codexEventTokenCountSchema,
  codexEventTurnAbortedSchema,
  codexEventTurnCompleteSchema,
  codexEventTurnStartedSchema,
  codexEventUserMessageSchema,
  codexResponseCompactionSchema,
  codexResponseCompactionSummarySchema,
  codexResponseContextCompactionSchema,
  codexResponseCustomToolCallOutputSchema,
  codexResponseCustomToolCallSchema,
  codexResponseFunctionCallOutputSchema,
  codexResponseFunctionCallSchema,
  codexResponseLocalShellCallSchema,
  codexResponseMessageSchema,
  codexResponseReasoningSchema,
  codexResponseWebSearchCallSchema,
  codexSessionMetaPayloadSchema,
  codexTurnContextPayloadSchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Normalized record model (plain TS — zod is only for the raw wire format)
// ---------------------------------------------------------------------------

export interface CodexRecordBase {
  /** 1-based line number in the rollout JSONL file — provenance anchor. */
  line: number;
  timestamp?: string;
}

export interface CodexGitInfoNormalized {
  commitHash?: string;
  branch?: string;
  repositoryUrl?: string;
}

export interface CodexSessionMetaRecord extends CodexRecordBase {
  type: "sessionMeta";
  id: string;
  /** `session_id` when present, else `id`. */
  sessionId: string;
  forkedFromId?: string;
  parentThreadId?: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  source?: unknown;
  agentNickname?: string;
  /** `agent_role`, falling back to the legacy `agent_type` alias. */
  agentRole?: string;
  agentPath?: string;
  modelProvider?: string;
  /** Presence only — the instructions text itself is not retained. */
  hasBaseInstructions: boolean;
  git?: CodexGitInfoNormalized;
}

export interface CodexTurnContextRecord extends CodexRecordBase {
  type: "turnContext";
  turnId?: string;
  cwd?: string;
  model?: string;
  effort?: string;
}

export type CodexResponseItemInner =
  | { kind: "message"; id?: string; role?: string; text: string; phase?: string }
  | { kind: "reasoning"; id?: string; summaryLength: number; hasEncryptedContent: boolean }
  | {
      kind: "functionCall";
      id?: string;
      callId: string;
      name: string;
      namespace?: string;
      argumentsJson?: string;
    }
  | { kind: "functionCallOutput"; callId: string; text: string; success?: boolean }
  | {
      kind: "customToolCall";
      callId: string;
      name: string;
      namespace?: string;
      input?: string;
      status?: string;
    }
  | { kind: "customToolCallOutput"; callId: string; name?: string; text: string; success?: boolean }
  | { kind: "localShellCall"; callId?: string; status?: string }
  | { kind: "webSearchCall"; status?: string; query?: string }
  | { kind: "compaction"; hasEncryptedContent: boolean }
  | { kind: "other"; rawType: string };

export interface CodexResponseItemRecord extends CodexRecordBase {
  type: "responseItem";
  item: CodexResponseItemInner;
}

/** CamelCased mirror of the raw `CodexTokenUsage` wire shape. */
export interface CodexTokenUsageRaw {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type CodexEventMsgInner =
  | {
      kind: "tokenCount";
      /** `undefined` when the wire `info` was `null` (some `token_count` events carry no usage). */
      info?: {
        totalTokenUsage: CodexTokenUsageRaw;
        lastTokenUsage: CodexTokenUsageRaw;
        modelContextWindow?: number;
      };
      /** Pass-through rate-limit snapshot, when the event carries one. */
      rateLimits?: unknown;
    }
  | { kind: "userMessage"; text?: string }
  | { kind: "agentMessage"; text?: string; phase?: string }
  | { kind: "taskStarted"; turnId?: string }
  | {
      kind: "taskComplete";
      turnId?: string;
      lastAgentMessage?: string;
      durationMs?: number;
      aborted?: boolean;
    }
  | { kind: "execCommandEnd"; callId: string; turnId?: string; exitCode?: number }
  | { kind: "threadNameUpdated"; threadId?: string; threadName: string }
  | { kind: "other"; rawType: string };

export interface CodexEventMsgRecord extends CodexRecordBase {
  type: "eventMsg";
  event: CodexEventMsgInner;
}

export interface CodexCompactedRecord extends CodexRecordBase {
  type: "compacted";
}

export interface CodexOtherRecord extends CodexRecordBase {
  type: "other";
  /** The envelope or inner `type` string that wasn't recognized. */
  rawType: string;
}

export type CodexRecord =
  | CodexSessionMetaRecord
  | CodexTurnContextRecord
  | CodexResponseItemRecord
  | CodexEventMsgRecord
  | CodexCompactedRecord
  | CodexOtherRecord;

export interface CodexTranscript {
  filePath: string;
  /**
   * "legacy" (pre-2026-02-25 format, detected from the first parseable line
   * not being a `session_meta` envelope) and "empty" (no parseable lines)
   * both carry no records — callers skip legacy files rather than attempting
   * to parse them.
   */
  format: "current" | "legacy" | "empty";
  records: CodexRecord[];
  warnings: ParseWarning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `function_call_output` / `custom_tool_call_output` payloads carry an
 * untagged `output` — string, or an object/array we display as JSON. Some
 * outputs wrap the real text in `{content, success}`; unwrap that shape when
 * present so `text` reads like the tool's actual output.
 */
export function coerceOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  if (typeof output === "object" && !Array.isArray(output)) {
    const content = (output as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function extractSuccessFlag(output: unknown): boolean | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const success = (output as Record<string, unknown>).success;
  return typeof success === "boolean" ? success : undefined;
}

function toRawTokenUsage(usage: CodexTokenUsage): CodexTokenUsageRaw {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
  };
}

function otherRecord(
  line: number,
  timestamp: string | undefined,
  rawType: string,
): CodexOtherRecord {
  return { line, type: "other", rawType, ...(timestamp !== undefined && { timestamp }) };
}

// ---------------------------------------------------------------------------
// Envelope-payload normalizers
// ---------------------------------------------------------------------------

function normalizeSessionMeta(
  payload: unknown,
  line: number,
  timestamp: string | undefined,
): CodexRecord {
  const parsed = codexSessionMetaPayloadSchema.safeParse(payload);
  if (!parsed.success) return otherRecord(line, timestamp, "session_meta");
  const p = parsed.data;
  const agentRole = p.agent_role ?? p.agent_type;
  const record: CodexSessionMetaRecord = {
    line,
    type: "sessionMeta",
    id: p.id,
    sessionId: p.session_id ?? p.id,
    hasBaseInstructions: p.base_instructions !== undefined,
    ...(timestamp !== undefined && { timestamp }),
    ...(p.forked_from_id !== undefined && { forkedFromId: p.forked_from_id }),
    ...(p.parent_thread_id !== undefined && { parentThreadId: p.parent_thread_id }),
    ...(p.cwd !== undefined && { cwd: p.cwd }),
    ...(p.originator !== undefined && { originator: p.originator }),
    ...(p.cli_version !== undefined && { cliVersion: p.cli_version }),
    ...(p.source !== undefined && { source: p.source }),
    ...(p.agent_nickname !== undefined && { agentNickname: p.agent_nickname }),
    ...(agentRole !== undefined && { agentRole }),
    ...(p.agent_path !== undefined && { agentPath: p.agent_path }),
    ...(p.model_provider !== undefined && { modelProvider: p.model_provider }),
    ...(p.git !== undefined && {
      git: {
        ...(p.git.commit_hash !== undefined && { commitHash: p.git.commit_hash }),
        ...(p.git.branch !== undefined && { branch: p.git.branch }),
        ...(p.git.repository_url !== undefined && { repositoryUrl: p.git.repository_url }),
      },
    }),
  };
  return record;
}

function normalizeTurnContext(
  payload: unknown,
  line: number,
  timestamp: string | undefined,
): CodexRecord {
  const parsed = codexTurnContextPayloadSchema.safeParse(payload);
  if (!parsed.success) return otherRecord(line, timestamp, "turn_context");
  const p = parsed.data;
  const record: CodexTurnContextRecord = {
    line,
    type: "turnContext",
    ...(timestamp !== undefined && { timestamp }),
    ...(p.turn_id !== undefined && { turnId: p.turn_id }),
    ...(p.cwd !== undefined && { cwd: p.cwd }),
    ...(p.model !== undefined && { model: p.model }),
    ...(p.effort !== undefined && { effort: p.effort }),
  };
  return record;
}

function parseResponseItemInner(payload: unknown, rawType: string): CodexResponseItemInner {
  switch (rawType) {
    case "message": {
      const parsed = codexResponseMessageSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      const text = (parsed.data.content ?? [])
        .map((block) => block.text ?? "")
        .filter((t) => t !== "")
        .join("\n");
      return {
        kind: "message",
        text,
        ...(parsed.data.id !== undefined && { id: parsed.data.id }),
        ...(parsed.data.role !== undefined && { role: parsed.data.role }),
        ...(parsed.data.phase !== undefined && { phase: parsed.data.phase }),
      };
    }
    case "reasoning": {
      const parsed = codexResponseReasoningSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "reasoning",
        summaryLength: JSON.stringify(parsed.data.summary ?? []).length,
        hasEncryptedContent: parsed.data.encrypted_content !== undefined,
        ...(parsed.data.id !== undefined && { id: parsed.data.id }),
      };
    }
    case "function_call": {
      const parsed = codexResponseFunctionCallSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "functionCall",
        callId: parsed.data.call_id,
        name: parsed.data.name,
        ...(parsed.data.id !== undefined && { id: parsed.data.id }),
        ...(parsed.data.namespace !== undefined && { namespace: parsed.data.namespace }),
        ...(parsed.data.arguments !== undefined && { argumentsJson: parsed.data.arguments }),
      };
    }
    case "function_call_output": {
      const parsed = codexResponseFunctionCallOutputSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      const success = extractSuccessFlag(parsed.data.output);
      return {
        kind: "functionCallOutput",
        callId: parsed.data.call_id,
        text: coerceOutputText(parsed.data.output),
        ...(success !== undefined && { success }),
      };
    }
    case "custom_tool_call": {
      const parsed = codexResponseCustomToolCallSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "customToolCall",
        callId: parsed.data.call_id,
        name: parsed.data.name,
        ...(parsed.data.namespace !== undefined && { namespace: parsed.data.namespace }),
        ...(parsed.data.input !== undefined && { input: parsed.data.input }),
        ...(parsed.data.status !== undefined && { status: parsed.data.status }),
      };
    }
    case "custom_tool_call_output": {
      const parsed = codexResponseCustomToolCallOutputSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      const success = extractSuccessFlag(parsed.data.output);
      return {
        kind: "customToolCallOutput",
        callId: parsed.data.call_id,
        text: coerceOutputText(parsed.data.output),
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(success !== undefined && { success }),
      };
    }
    case "local_shell_call": {
      const parsed = codexResponseLocalShellCallSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "localShellCall",
        ...(parsed.data.call_id !== undefined && { callId: parsed.data.call_id }),
        ...(parsed.data.status !== undefined && { status: parsed.data.status }),
      };
    }
    case "web_search_call": {
      const parsed = codexResponseWebSearchCallSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      const query = parsed.data.action?.query ?? parsed.data.action?.queries?.[0];
      return {
        kind: "webSearchCall",
        ...(parsed.data.status !== undefined && { status: parsed.data.status }),
        ...(query !== undefined && { query }),
      };
    }
    case "compaction": {
      const parsed = codexResponseCompactionSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "compaction",
        hasEncryptedContent: parsed.data.encrypted_content !== undefined,
      };
    }
    case "compaction_summary": {
      const parsed = codexResponseCompactionSummarySchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "compaction",
        hasEncryptedContent: parsed.data.encrypted_content !== undefined,
      };
    }
    case "context_compaction": {
      const parsed = codexResponseContextCompactionSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "compaction",
        hasEncryptedContent: parsed.data.encrypted_content !== undefined,
      };
    }
    default:
      return { kind: "other", rawType };
  }
}

function normalizeResponseItem(
  payload: unknown,
  line: number,
  timestamp: string | undefined,
): CodexRecord {
  const rawType =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).type
      : undefined;
  if (typeof rawType !== "string") return otherRecord(line, timestamp, "response_item");
  const record: CodexResponseItemRecord = {
    line,
    type: "responseItem",
    item: parseResponseItemInner(payload, rawType),
    ...(timestamp !== undefined && { timestamp }),
  };
  return record;
}

function parseEventMsgInner(payload: unknown, rawType: string): CodexEventMsgInner {
  switch (rawType) {
    case "token_count": {
      const parsed = codexEventTokenCountSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      const rateLimits = parsed.data.rate_limits;
      if (parsed.data.info === null || parsed.data.info === undefined) {
        return { kind: "tokenCount", ...(rateLimits !== undefined && { rateLimits }) };
      }
      const info = parsed.data.info;
      return {
        kind: "tokenCount",
        info: {
          totalTokenUsage: toRawTokenUsage(info.total_token_usage),
          lastTokenUsage: toRawTokenUsage(info.last_token_usage),
          ...(info.model_context_window !== undefined && {
            modelContextWindow: info.model_context_window,
          }),
        },
        ...(rateLimits !== undefined && { rateLimits }),
      };
    }
    case "user_message": {
      const parsed = codexEventUserMessageSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "userMessage",
        ...(parsed.data.message !== undefined && { text: parsed.data.message }),
      };
    }
    case "agent_message": {
      const parsed = codexEventAgentMessageSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "agentMessage",
        ...(parsed.data.message !== undefined && { text: parsed.data.message }),
        ...(parsed.data.phase !== undefined && { phase: parsed.data.phase }),
      };
    }
    case "task_started":
    case "turn_started": {
      const schema =
        rawType === "task_started" ? codexEventTaskStartedSchema : codexEventTurnStartedSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "taskStarted",
        ...(parsed.data.turn_id !== undefined && { turnId: parsed.data.turn_id }),
      };
    }
    case "task_complete":
    case "turn_complete": {
      const schema =
        rawType === "task_complete" ? codexEventTaskCompleteSchema : codexEventTurnCompleteSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "taskComplete",
        ...(parsed.data.turn_id !== undefined && { turnId: parsed.data.turn_id }),
        ...(parsed.data.last_agent_message != null && {
          lastAgentMessage: parsed.data.last_agent_message,
        }),
        ...(parsed.data.duration_ms != null && { durationMs: parsed.data.duration_ms }),
      };
    }
    case "turn_aborted":
    case "task_aborted": {
      const parsed = codexEventTurnAbortedSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "taskComplete",
        aborted: true,
        ...(parsed.data.turn_id !== undefined && { turnId: parsed.data.turn_id }),
        ...(parsed.data.duration_ms != null && { durationMs: parsed.data.duration_ms }),
      };
    }
    case "exec_command_end": {
      const parsed = codexEventExecCommandEndSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "execCommandEnd",
        callId: parsed.data.call_id,
        ...(parsed.data.turn_id !== undefined && { turnId: parsed.data.turn_id }),
        ...(parsed.data.exit_code !== undefined && { exitCode: parsed.data.exit_code }),
      };
    }
    case "thread_name_updated": {
      const parsed = codexEventThreadNameUpdatedSchema.safeParse(payload);
      if (!parsed.success) return { kind: "other", rawType };
      return {
        kind: "threadNameUpdated",
        threadName: parsed.data.thread_name,
        ...(parsed.data.thread_id !== undefined && { threadId: parsed.data.thread_id }),
      };
    }
    default:
      return { kind: "other", rawType };
  }
}

function normalizeEventMsg(
  payload: unknown,
  line: number,
  timestamp: string | undefined,
): CodexRecord {
  const rawType =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).type
      : undefined;
  if (typeof rawType !== "string") return otherRecord(line, timestamp, "event_msg");
  const record: CodexEventMsgRecord = {
    line,
    type: "eventMsg",
    event: parseEventMsgInner(payload, rawType),
    ...(timestamp !== undefined && { timestamp }),
  };
  return record;
}

function normalizeEnvelope(envelope: CodexEnvelope, line: number): CodexRecord {
  const timestamp = envelope.timestamp;
  switch (envelope.type) {
    case "session_meta":
      return normalizeSessionMeta(envelope.payload, line, timestamp);
    case "turn_context":
      return normalizeTurnContext(envelope.payload, line, timestamp);
    case "response_item":
      return normalizeResponseItem(envelope.payload, line, timestamp);
    case "event_msg":
      return normalizeEventMsg(envelope.payload, line, timestamp);
    case "compacted":
      return { line, type: "compacted", ...(timestamp !== undefined && { timestamp }) };
    default:
      // inter_agent_communication(_metadata), world_state, and any future
      // envelope type — tolerated generically, counted via `type: "other"`.
      return otherRecord(line, timestamp, envelope.type);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Stream-parse one Codex rollout JSONL file. Legacy (pre-2026-02-25) files —
 * detected by the first parseable line not being a `session_meta` envelope —
 * return `format: "legacy"` with no records; callers should skip these
 * rather than attempting to interpret the older schema.
 */
export async function parseCodexTranscriptFile(filePath: string): Promise<CodexTranscript> {
  const records: CodexRecord[] = [];
  const warnings: ParseWarning[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let line = 0;
  let format: CodexTranscript["format"] | undefined;

  for await (const text of rl) {
    line += 1;
    if (text.trim() === "") continue;
    const raw = parseJsonlLine(text);
    if (raw === null) {
      warnings.push({ line, reason: "malformed JSON" });
      continue;
    }

    if (format === undefined) {
      const isCurrentFormat =
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).type === "session_meta";
      if (!isCurrentFormat) {
        return { filePath, format: "legacy", records: [], warnings };
      }
      format = "current";
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warnings.push({ line, reason: "not an object" });
      continue;
    }
    const envelopeResult = codexEnvelopeSchema.safeParse(raw);
    if (!envelopeResult.success) {
      warnings.push({ line, reason: "missing envelope type" });
      continue;
    }
    records.push(normalizeEnvelope(envelopeResult.data, line));
  }

  return { filePath, format: format ?? "empty", records, warnings };
}
