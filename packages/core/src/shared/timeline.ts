/**
 * Cross-harness timeline/record-detail vocabulary — the `TimelineEntry` /
 * `RecordDetail` variant shapes and text-formatting helpers both
 * `claude/timeline.ts` and `codex/timeline.ts` build against, so the web
 * renders either harness's Timeline lens (L2) / Record detail (L3) with the
 * same components (see packages/web/src/lenses/Timeline.tsx /
 * RecordDetail.tsx) — no per-harness entry kind or renderer exists or is
 * needed.
 *
 * Everything here is derived strictly from what the log actually contains —
 * no estimates are presented as facts. Notably:
 *  - There is no per-message API-latency field anywhere in Claude Code's
 *    JSONL schema, so `assistant-text` entries never carry a duration — it is
 *    NOT approximated from timestamp deltas between records.
 *  - There is no "effort" field recorded anywhere for subagent launches, so
 *    `subagent-launch` entries never populate `effort`.
 */

// ---------------------------------------------------------------------------
// Entry / detail types
// ---------------------------------------------------------------------------

export type ToolCallStatus = "ok" | "error" | "missing-result";

interface EntryBase {
  line: number;
  timestamp?: string;
}

export interface UserEntry extends EntryBase {
  kind: "user";
  text: string;
  truncated: boolean;
}

export interface AssistantTextEntry extends EntryBase {
  kind: "assistant-text";
  text: string;
  truncated: boolean;
  model?: string;
  outputTokens?: number;
  /** undefined when the model has no known pricing. */
  costUsd?: number;
  /** No such field exists in the log today — always undefined; kept for forward-compat. */
  apiDurationMs?: number;
}

export interface ThinkingEntry extends EntryBase {
  kind: "thinking";
  text: string;
  truncated: boolean;
  /** Always the full (pre-truncation) length, mirroring `AssistantTextEntry`. */
  charCount: number;
  model?: string;
}

export interface ToolCallEntry extends EntryBase {
  kind: "tool-call";
  toolUseId: string;
  name: string;
  inputSummary: string;
  status: ToolCallStatus;
  resultSummary?: string;
  resultLineCount?: number;
  durationMs?: number;
  resultLine?: number;
  /**
   * Set only for a Claude Code `Workflow` tool call whose run id could be
   * resolved from its own `tool_result` text (see `claude/timeline.ts`'s
   * `buildWorkflowToolCallEntry`) — deliberately kept on the SAME
   * `"tool-call"` entry kind rather than a new one (there's exactly one
   * `Workflow` call per run, not one per spawned agent, so it doesn't fit
   * `SubagentLaunchEntry`'s one-entry-per-agent shape; see design rationale
   * in `analyze.ts`'s `ClaudeWorkflowRunSummary`). `workflowAgentCount`/
   * `workflowCostUsd` are a rollup over the run's member agents (their own
   * transcripts, resolved the same lazy way `resolveSubagentUsage` resolves
   * one subagent's usage) — never a second usage-bearing node, just a
   * display summary.
   */
  workflowRunId?: string;
  workflowName?: string;
  workflowAgentCount?: number;
  workflowCostUsd?: number;
  /** False when the rollup includes a model with no known pricing — mirrors `SubagentLaunchEntry.costIsComplete`. */
  workflowCostIsComplete?: boolean;
}

export interface SubagentLaunchEntry extends EntryBase {
  kind: "subagent-launch";
  toolUseId: string;
  /** undefined until the sidecar transcript is resolved (needs `mainFilePath`). */
  agentId?: string;
  agentType?: string;
  name?: string;
  model?: string;
  /** Never populated today — no "effort" field exists anywhere in the log. */
  effort?: string;
  promptPreview?: string;
  promptTruncated: boolean;
  /**
   * Length of the parent-side tool_result text; undefined while unresolved
   * (no result yet) — and always undefined for ASYNC launches, whose
   * tool_result is only the launch-ack boilerplate, not the agent's return
   * (that arrives later as a task-notification whose text isn't captured).
   */
  returnedChars?: number;
  resultLine?: number;
  /** Below: the agent's own usage/duration, resolved only when `mainFilePath` is given
   *  and the sidecar transcript can be read — otherwise all left undefined. */
  outputTokens?: number;
  costUsd?: number;
  costIsComplete?: boolean;
  durationMs?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
}

export interface TaskNotificationEntry extends EntryBase {
  kind: "task-notification";
  taskId: string;
  name?: string;
  background: boolean;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  /** Line of the launching tool call, when linkable. */
  startLine?: number;
}

export interface CompactionEntry extends EntryBase {
  kind: "compaction";
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

export interface ApiErrorEntry extends EntryBase {
  kind: "api-error";
  message?: string;
}

export type TimelineEntry =
  | UserEntry
  | AssistantTextEntry
  | ThinkingEntry
  | ToolCallEntry
  | SubagentLaunchEntry
  | TaskNotificationEntry
  | CompactionEntry
  | ApiErrorEntry;

interface DetailBase {
  line: number;
  timestamp?: string;
}

export interface UserRecordDetail extends DetailBase {
  kind: "user";
  text: string;
}

/**
 * Harness-injected context persisted as a synthetic user record — today only
 * Codex produces these (AGENTS.md merges / `<user_instructions>` /
 * `<environment_context>` response_items, see `isSyntheticUserText` in
 * `codex/analyze.ts`); Claude's isMeta injections stay unexposed here. Kept
 * as its own kind rather than `"user"` so the slide-over never presents
 * injected context as something the human typed.
 */
export interface InjectedContextRecordDetail extends DetailBase {
  kind: "injected-context";
  /** Full injected text, synthetic header line included. */
  text: string;
  charCount: number;
}

export interface AssistantTextRecordDetail extends DetailBase {
  kind: "assistant-text";
  text: string;
  model?: string;
  outputTokens?: number;
  costUsd?: number;
}

export interface ThinkingRecordDetail extends DetailBase {
  kind: "thinking";
  /** Full thinking text — no truncation, unlike the timeline entry's preview. */
  text: string;
  charCount: number;
  model?: string;
}

export interface ToolCallRecordDetail extends DetailBase {
  kind: "tool-call";
  toolUseId: string;
  name: string;
  /** Full input — caller pretty-prints. */
  input: unknown;
  status: ToolCallStatus;
  /**
   * The tool_result's text — genuinely full whenever the Claude producer
   * (`claude/timeline.ts`'s `buildToolCallDetail`) could recover it (re-reads
   * the record's raw source line to undo the parser's parse-time capture
   * cap; see that module's doc comment). Codex never caps this field at all.
   */
  resultText?: string;
  resultLineCount?: number;
  resultLine?: number;
  resultTimestamp?: string;
  durationMs?: number;
  /**
   * The result's TRUE original character count — Claude only, present ONLY
   * when recovery couldn't close the gap (line unreadable, no matching
   * block, or no source file at all) and `resultText` is therefore STILL
   * short of the truth. Absent whenever `resultText` is already complete,
   * whether because there was never a cap or because recovery succeeded.
   * Mirrors `ToolCallDetailResult.fullTextLength`'s contract exactly.
   */
  resultTextFullCharCount?: number;
}

export interface SubagentLaunchRecordDetail extends DetailBase {
  kind: "subagent-launch";
  toolUseId: string;
  agentId?: string;
  agentType?: string;
  name?: string;
  model?: string;
  effort?: string;
  /** Full prompt as given to the subagent (from the spawning tool call's input). */
  prompt?: string;
  /**
   * Full parent-side tool_result text — genuinely full whenever recovery
   * succeeded, same "undo the parser's capture cap" mechanism `resultText`
   * uses on `ToolCallRecordDetail` (the launch's own tool_result is capped
   * the identical way). See `returnedTextFullCharCount`.
   */
  returnedText?: string;
  resultLine?: number;
  resultTimestamp?: string;
  outputTokens?: number;
  costUsd?: number;
  costIsComplete?: boolean;
  durationMs?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  /**
   * The TRUE original character count of `returnedText` — present ONLY when
   * recovery couldn't close the gap and `returnedText` is therefore still
   * short of the truth. Same contract as `ToolCallRecordDetail
   * .resultTextFullCharCount`.
   */
  returnedTextFullCharCount?: number;
}

export interface TaskNotificationRecordDetail extends DetailBase {
  kind: "task-notification";
  taskId: string;
  name?: string;
  background: boolean;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  startLine?: number;
}

export interface CompactionRecordDetail extends DetailBase {
  kind: "compaction";
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

export interface ApiErrorRecordDetail extends DetailBase {
  kind: "api-error";
  message?: string;
  status?: number;
  retryAttempt?: number;
}

export type RecordDetail =
  | UserRecordDetail
  | InjectedContextRecordDetail
  | AssistantTextRecordDetail
  | ThinkingRecordDetail
  | ToolCallRecordDetail
  | SubagentLaunchRecordDetail
  | TaskNotificationRecordDetail
  | CompactionRecordDetail
  | ApiErrorRecordDetail;

// ---------------------------------------------------------------------------
// Tool-call detail (get_tool_call MCP tool) — a full call+result UNIT,
// distinct from the single-line `RecordDetail` above: a call's own line and
// its result's line are always different JSONL records, so this type carries
// BOTH plus explicit "is anything missing" signaling instead of resolving one
// line at a time. Cross-harness, same reasoning as `RecordDetail`: one
// vocabulary, two producers (Claude: `claude/timeline.ts`'s
// `getClaudeToolCallDetail`; Codex: `codex/timeline.ts`'s
// `getCodexToolCallDetail`).
// ---------------------------------------------------------------------------

export interface ToolCallDetailCall {
  name: string;
  /** Full input as parsed — caller pretty-prints. */
  input: unknown;
  /** 1-based source line of the tool_use/function_call record. */
  line: number;
  timestamp?: string;
  /** uuid of the containing record, when cheaply resolvable — Claude only (Codex records carry no uuid). */
  uuid?: string;
}

export interface ToolCallDetailResult {
  isError: boolean;
  /** Full result text as captured (Claude: bounded by the parser's global capture cap — see `fullTextLength`). */
  text: string;
  /**
   * The result's TRUE original character count, present only when it exceeds
   * `text.length` — Claude only (the parser caps captured tool_result text at
   * a fixed length; Codex captures result text uncapped, so this never
   * appears there). Lets a caller distinguish "the tool said this much" from
   * "the tool said at least this much, more was cut before it ever reached
   * this API" — never mistake `text.length` alone for the tool's true output
   * size.
   */
  fullTextLength?: number;
  /** 1-based source line of the tool_result/`*_output`/`exec_command_end` record. */
  line: number;
  timestamp?: string;
}

/**
 * A record linked to a tool call by structure the parser already
 * establishes — today only a background task's completion notification,
 * linked via `toolUseId` -> `taskId` (Claude only; Codex has no background-
 * task/notification concept, so this list is always empty there). Never
 * heuristic: an empty array means no such linkage exists in the parsed data,
 * not that none was looked for.
 */
export interface ToolCallRelatedRecord {
  kind: "task-notification";
  taskId: string;
  line: number;
  timestamp?: string;
  status?: string;
  exitCode?: number;
}

export interface ToolCallDetail {
  toolUseId: string;
  call: ToolCallDetailCall;
  /** `null` when the result record can't be found — see `resultMissing`. */
  result: ToolCallDetailResult | null;
  /** Explicit companion to `result: null` — absence is declared, never implied. */
  resultMissing: boolean;
  relatedRecords: ToolCallRelatedRecord[];
}

export interface TimelineOptions {
  /**
   * Path to the MAIN session's JSONL file. Needed to resolve subagent-launch
   * linkage (the sidecar `subagents/` dir lives alongside it) — this is true
   * even when `data` itself is a subagent's own SessionData, since nested
   * agents share the same top-level sidecar directory. When omitted,
   * `subagent-launch` entries still appear (derived from in-band tool-call
   * data) but `agentId`/usage/duration fields stay undefined. Claude-only —
   * Codex has no sidecar-transcript concept.
   */
  mainFilePath?: string;
}

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

const RESULT_SUMMARY_LIMIT = 160;

// Exported so both `claude/timeline.ts` and `codex/timeline.ts` build their
// entries/detail with the exact same text formatting rules, instead of
// redefining them.

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

export function truncateOneLine(text: string, limit: number): string {
  return truncate(collapseWhitespace(text), limit).text;
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function durationBetween(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const delta = Date.parse(end) - Date.parse(start);
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

export function summarizeResultText(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const base = firstLine.length > 0 ? firstLine : collapseWhitespace(text);
  return truncate(base, RESULT_SUMMARY_LIMIT).text;
}
