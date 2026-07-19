/**
 * Everything Claude-Code-specific. May import `../shared/`. MUST NOT import
 * `../codex/`.
 */

export type { ClaudeSessionAnalysis, ClaudeWorkflowRunSummary } from "./analyze.js";
export { analyzeClaudeSession } from "./analyze.js";
// The `Bash*`/`BashStats`/`BashWaste` DATA TYPES are now harness-neutral
// (`../shared/bash-stats.ts`) and exported from `shared/index.ts` only — see
// that file's doc comment. `BashStatsThread` (the Claude-adapter's own INPUT
// contract) and `computeBashStats` (the Claude adapter FUNCTION, a distinct
// signature from the shared engine of the same name — see `bash-stats.ts`)
// stay here, genuinely Claude-only.
export type { BashStatsThread } from "./bash-stats.js";
export { computeBashStats } from "./bash-stats.js";
export { loadClaudeDesktopTitles, resolveClaudeDesktopSessionsDirs } from "./desktop.js";
export type { ClaudeSessionFileRef } from "./discovery.js";
export {
  findClaudeSessionFileById,
  listClaudeSessionFiles,
  resolveClaudeProjectsDirs,
} from "./discovery.js";
export type {
  EvaluationTrace,
  EvaluationTraceCaptureEnrichment,
  EvaluationTraceChannelDeclaration,
  EvaluationTraceEnrichment,
  EvaluationTraceEvent,
  EvaluationTraceHiddenCall,
  EvaluationTraceInjectedContext,
  EvaluationTraceInputs,
  EvaluationTraceOtelEnrichment,
  EvaluationTraceProvenance,
  EvaluationTraceReconstructionSummary,
  EvaluationTraceRecoveredText,
  EvaluationTraceRequestCapture,
  EvaluationTraceSessionMeta,
} from "./evaluation-trace.js";
export { buildEvaluationTrace, EVALUATION_TRACE_SCHEMA } from "./evaluation-trace.js";
export type {
  ClaudeTurnStep,
  ClaudeTurnUsage,
  ExplorationProfile,
  RepetitionFinding,
  TaskExecutionInfo,
  ToolErrorCategory,
  ToolStat,
} from "./metrics.js";
export {
  backgroundStatus,
  classifyToolError,
  computeContextTimeline,
  computeExploration,
  computeFileAccess,
  computeRepetitions,
  computeSkillInvocations,
  computeTaskExecutions,
  computeToolStats,
  computeTurnUsage,
  computeUsage,
  spanMs,
} from "./metrics.js";
export type {
  OtelApiRequestStats,
  OtelCostSource,
  OtelDurationStats,
  OtelHealthEvent,
  OtelSessionAnalysis,
  OtelToolDecision,
  ParseOtelSessionOptions,
} from "./otel.js";
export { extractSessionId, parseOtelSessionLines } from "./otel.js";
export { parseClaudeTranscriptFile, parseClaudeTranscriptLines } from "./parser.js";
export { joinPath } from "./paths.js";
export * from "./reconstruction/index.js";
export { extractClaudeSearchFields } from "./search.js";
export type {
  ApiErrorLogEntry,
  ApiMessage,
  SessionData,
  ToolCall,
  UserPrompt,
} from "./session-data.js";
export { buildSessionData } from "./session-data.js";
export type { ClaudeSessionStore, ClaudeSidecarFileRef } from "./store.js";
export { localClaudeSessionStore } from "./store.js";
export type { SubagentMeta, SubagentRef } from "./subagents.js";
export { listSubagentRefs, loadSubagentSessionData, subagentsDirFor } from "./subagents.js";
export {
  buildClaudeTimeline,
  getClaudeRecordDetail,
  getClaudeToolCallDetail,
  summarizeToolInput,
} from "./timeline.js";
// The `Tool*`/`ToolUsageStats` DATA TYPES are harness-neutral
// (`../shared/tool-usage-stats.ts`) and exported from `shared/index.ts` only —
// same convention as `Bash*` above. `ToolUsageStatsThread` (the Claude
// adapter's own INPUT contract) and `computeToolUsageStats` (the Claude adapter
// FUNCTION, a distinct signature from the shared engine of the same name) stay
// here, genuinely Claude-only.
export type { ToolUsageStatsThread } from "./tool-usage-stats.js";
export { computeToolUsageStats } from "./tool-usage-stats.js";
export type {
  AssistantRecord,
  ClaudeSessionRecord,
  ClaudeTranscript,
  UserRecord,
} from "./types.js";
export type { WorkflowAgentProgress, WorkflowPhase, WorkflowRun } from "./workflows.js";
export { listWorkflowRuns, workflowsDirFor } from "./workflows.js";
