/**
 * Everything Claude-Code-specific. May import `../shared/`. MUST NOT import
 * `../codex/`.
 */

export type { ClaudeSessionAnalysis, ClaudeWorkflowRunSummary } from "./analyze.js";
export { analyzeClaudeSession } from "./analyze.js";
export type {
  BashAsReadCall,
  BashBackgroundCall,
  BashCommandGroup,
  BashHeavyHitter,
  BashLargeResult,
  BashNearDuplicateGroup,
  BashProgramFrequency,
  BashRerunAfterError,
  BashStats,
  BashStatsThread,
  BashTotals,
  BashWaste,
} from "./bash-stats.js";
export {
  computeBashStats,
  LARGE_RESULT_CHARS_THRESHOLD,
  normalizeCommandForDedup,
} from "./bash-stats.js";
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
export type {
  AssistantRecord,
  ClaudeSessionRecord,
  ClaudeTranscript,
  UserRecord,
} from "./types.js";
export type { WorkflowAgentProgress, WorkflowPhase, WorkflowRun } from "./workflows.js";
export { listWorkflowRuns, workflowsDirFor } from "./workflows.js";
