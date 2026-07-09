/**
 * Zod schemas for the raw Codex CLI rollout JSONL format
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`), current format only
 * (session_meta-first files — see `discovery.ts`/`parser.ts` for the legacy
 * fallback).
 *
 * Every object uses `z.looseObject` so unknown/future fields pass through
 * instead of being stripped or rejected — the upstream format has ~75
 * `event_msg` variants and many Desktop-only `turn_context` fields we don't
 * need to model. `parser.ts` looks up the right schema per discriminant and
 * degrades anything unmatched (unknown type, or a known type whose payload
 * fails validation) to a generic record rather than throwing.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// session_meta
// ---------------------------------------------------------------------------

export const codexGitInfoSchema = z.looseObject({
  commit_hash: z.string().optional(),
  branch: z.string().optional(),
  repository_url: z.string().optional(),
});
export type CodexGitInfo = z.infer<typeof codexGitInfoSchema>;

export const codexSessionMetaPayloadSchema = z.looseObject({
  id: z.string(),
  session_id: z.string().optional(),
  forked_from_id: z.string().optional(),
  parent_thread_id: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  originator: z.string().optional(),
  cli_version: z.string().optional(),
  source: z.unknown().optional(),
  agent_nickname: z.string().optional(),
  agent_role: z.string().optional(),
  /** Legacy alias for `agent_role`. */
  agent_type: z.string().optional(),
  agent_path: z.string().optional(),
  model_provider: z.string().optional(),
  /** Large — presence is all `parser.ts` records, not the text itself. */
  base_instructions: z.string().optional(),
  git: codexGitInfoSchema.optional(),
});
export type CodexSessionMetaPayload = z.infer<typeof codexSessionMetaPayloadSchema>;

// ---------------------------------------------------------------------------
// turn_context
// ---------------------------------------------------------------------------

export const codexTurnContextPayloadSchema = z.looseObject({
  turn_id: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  summary: z.unknown().optional(),
  approval_policy: z.string().optional(),
  sandbox_policy: z.unknown().optional(),
  collaboration_mode: z.unknown().optional(),
});
export type CodexTurnContextPayload = z.infer<typeof codexTurnContextPayloadSchema>;

// ---------------------------------------------------------------------------
// response_item — inner discriminated union
// ---------------------------------------------------------------------------

const codexContentBlockSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
});

export const codexResponseMessageSchema = z.looseObject({
  type: z.literal("message"),
  id: z.string().optional(),
  role: z.string().optional(),
  content: z.array(codexContentBlockSchema).optional(),
  phase: z.string().optional(),
});
export type CodexResponseMessage = z.infer<typeof codexResponseMessageSchema>;

export const codexResponseReasoningSchema = z.looseObject({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  summary: z.array(z.unknown()).optional(),
  content: z.array(z.unknown()).nullable().optional(),
  encrypted_content: z.string().optional(),
});
export type CodexResponseReasoning = z.infer<typeof codexResponseReasoningSchema>;

export const codexResponseFunctionCallSchema = z.looseObject({
  type: z.literal("function_call"),
  id: z.string().optional(),
  name: z.string(),
  namespace: z.string().optional(),
  arguments: z.string().optional(),
  call_id: z.string(),
});
export type CodexResponseFunctionCall = z.infer<typeof codexResponseFunctionCallSchema>;

export const codexResponseFunctionCallOutputSchema = z.looseObject({
  type: z.literal("function_call_output"),
  id: z.string().optional(),
  call_id: z.string(),
  /** Untagged: string, object, or array — coerce lazily with `coerceOutputText`. */
  output: z.unknown(),
});
export type CodexResponseFunctionCallOutput = z.infer<typeof codexResponseFunctionCallOutputSchema>;

export const codexResponseCustomToolCallSchema = z.looseObject({
  type: z.literal("custom_tool_call"),
  id: z.string().optional(),
  status: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  namespace: z.string().optional(),
  input: z.string().optional(),
});
export type CodexResponseCustomToolCall = z.infer<typeof codexResponseCustomToolCallSchema>;

export const codexResponseCustomToolCallOutputSchema = z.looseObject({
  type: z.literal("custom_tool_call_output"),
  id: z.string().optional(),
  call_id: z.string(),
  name: z.string().optional(),
  output: z.unknown(),
});
export type CodexResponseCustomToolCallOutput = z.infer<
  typeof codexResponseCustomToolCallOutputSchema
>;

export const codexResponseLocalShellCallSchema = z.looseObject({
  type: z.literal("local_shell_call"),
  id: z.string().optional(),
  call_id: z.string().optional(),
  status: z.string().optional(),
  action: z.unknown().optional(),
});
export type CodexResponseLocalShellCall = z.infer<typeof codexResponseLocalShellCallSchema>;

export const codexResponseWebSearchCallSchema = z.looseObject({
  type: z.literal("web_search_call"),
  id: z.string().optional(),
  status: z.string().optional(),
  action: z
    .looseObject({
      type: z.string().optional(),
      query: z.string().optional(),
      queries: z.array(z.string()).optional(),
    })
    .optional(),
});
export type CodexResponseWebSearchCall = z.infer<typeof codexResponseWebSearchCallSchema>;

export const codexResponseCompactionSchema = z.looseObject({
  type: z.literal("compaction"),
  id: z.string().optional(),
  encrypted_content: z.string().optional(),
});
export type CodexResponseCompaction = z.infer<typeof codexResponseCompactionSchema>;

export const codexResponseCompactionSummarySchema = codexResponseCompactionSchema.extend({
  type: z.literal("compaction_summary"),
});
export const codexResponseContextCompactionSchema = codexResponseCompactionSchema.extend({
  type: z.literal("context_compaction"),
});

/** `response_item` inner-type discriminant -> schema, for `parser.ts`'s dispatch table. */
export const codexResponseItemSchemasByType: Record<string, z.ZodType> = {
  message: codexResponseMessageSchema,
  reasoning: codexResponseReasoningSchema,
  function_call: codexResponseFunctionCallSchema,
  function_call_output: codexResponseFunctionCallOutputSchema,
  custom_tool_call: codexResponseCustomToolCallSchema,
  custom_tool_call_output: codexResponseCustomToolCallOutputSchema,
  local_shell_call: codexResponseLocalShellCallSchema,
  web_search_call: codexResponseWebSearchCallSchema,
  compaction: codexResponseCompactionSchema,
  compaction_summary: codexResponseCompactionSummarySchema,
  context_compaction: codexResponseContextCompactionSchema,
};

// ---------------------------------------------------------------------------
// event_msg — inner discriminated union (subset of ~75 upstream variants)
// ---------------------------------------------------------------------------

export const codexTokenUsageSchema = z.looseObject({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
  total_tokens: z.number(),
});
export type CodexTokenUsage = z.infer<typeof codexTokenUsageSchema>;

export const codexTokenCountInfoSchema = z.looseObject({
  total_token_usage: codexTokenUsageSchema,
  last_token_usage: codexTokenUsageSchema,
  model_context_window: z.number().optional(),
});
export type CodexTokenCountInfo = z.infer<typeof codexTokenCountInfoSchema>;

export const codexEventTokenCountSchema = z.looseObject({
  type: z.literal("token_count"),
  info: codexTokenCountInfoSchema.nullable().optional(),
  rate_limits: z.unknown().optional(),
});
export type CodexEventTokenCount = z.infer<typeof codexEventTokenCountSchema>;

export const codexEventUserMessageSchema = z.looseObject({
  type: z.literal("user_message"),
  message: z.string().optional(),
  images: z.unknown().optional(),
  local_images: z.unknown().optional(),
  text_elements: z.unknown().optional(),
});
export type CodexEventUserMessage = z.infer<typeof codexEventUserMessageSchema>;

export const codexEventAgentMessageSchema = z.looseObject({
  type: z.literal("agent_message"),
  message: z.string().optional(),
  phase: z.string().optional(),
});
export type CodexEventAgentMessage = z.infer<typeof codexEventAgentMessageSchema>;

export const codexEventTaskStartedSchema = z.looseObject({
  type: z.literal("task_started"),
  turn_id: z.string().optional(),
  // Epoch seconds on current wire; older payloads used RFC3339 strings.
  started_at: z.union([z.number(), z.string()]).nullable().optional(),
  model_context_window: z.number().nullable().optional(),
});
export type CodexEventTaskStarted = z.infer<typeof codexEventTaskStartedSchema>;

/** Wire alias for `task_started`. */
export const codexEventTurnStartedSchema = codexEventTaskStartedSchema.extend({
  type: z.literal("turn_started"),
});

export const codexEventTaskCompleteSchema = z.looseObject({
  type: z.literal("task_complete"),
  turn_id: z.string().optional(),
  last_agent_message: z.string().nullable().optional(),
  // Epoch seconds on current wire; older payloads used RFC3339 strings.
  completed_at: z.union([z.number(), z.string()]).nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  time_to_first_token_ms: z.number().nullable().optional(),
});
export type CodexEventTaskComplete = z.infer<typeof codexEventTaskCompleteSchema>;

/** Wire alias for `task_complete`. */
export const codexEventTurnCompleteSchema = codexEventTaskCompleteSchema.extend({
  type: z.literal("turn_complete"),
});

/** Emitted instead of `task_complete` when the user interrupts a turn. */
export const codexEventTurnAbortedSchema = z.looseObject({
  type: z.union([z.literal("turn_aborted"), z.literal("task_aborted")]),
  turn_id: z.string().optional(),
  duration_ms: z.number().nullable().optional(),
});
export type CodexEventTurnAborted = z.infer<typeof codexEventTurnAbortedSchema>;

export const codexEventExecCommandEndSchema = z.looseObject({
  type: z.literal("exec_command_end"),
  call_id: z.string(),
  turn_id: z.string().optional(),
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  exit_code: z.number().optional(),
  duration: z.unknown().optional(),
  status: z.string().optional(),
});
export type CodexEventExecCommandEnd = z.infer<typeof codexEventExecCommandEndSchema>;

export const codexEventThreadNameUpdatedSchema = z.looseObject({
  type: z.literal("thread_name_updated"),
  thread_id: z.string().optional(),
  thread_name: z.string(),
});
export type CodexEventThreadNameUpdated = z.infer<typeof codexEventThreadNameUpdatedSchema>;

/** `event_msg` inner-type discriminant -> schema, for `parser.ts`'s dispatch table. */
export const codexEventMsgSchemasByType: Record<string, z.ZodType> = {
  token_count: codexEventTokenCountSchema,
  user_message: codexEventUserMessageSchema,
  agent_message: codexEventAgentMessageSchema,
  task_started: codexEventTaskStartedSchema,
  turn_started: codexEventTurnStartedSchema,
  task_complete: codexEventTaskCompleteSchema,
  turn_complete: codexEventTurnCompleteSchema,
  exec_command_end: codexEventExecCommandEndSchema,
  thread_name_updated: codexEventThreadNameUpdatedSchema,
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Loose top-level envelope check — every line is `{timestamp, type, payload}`.
 * Payload is validated separately per `type` (see the dispatch tables above)
 * so an unknown envelope type, or a known type with a malformed payload,
 * degrades to a generic record instead of failing the whole line.
 */
export const codexEnvelopeSchema = z.looseObject({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: z.unknown().optional(),
});
export type CodexEnvelope = z.infer<typeof codexEnvelopeSchema>;

export const CODEX_KNOWN_ENVELOPE_TYPES = new Set([
  "session_meta",
  "response_item",
  "turn_context",
  "event_msg",
  "compacted",
]);
