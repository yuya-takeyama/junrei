/**
 * Agent-agnostic vocabulary and helpers shared by the `claude/` and `codex/`
 * trees. MUST NOT import from either of those trees.
 */

export type {
  CompletenessStatus,
  SourceCompleteness,
  SourceCompletenessEntry,
  SourceKind,
} from "./completeness.js";
export { buildSourceCompleteness } from "./completeness.js";
export type {
  DelegationModelSlice,
  DelegationScopeSlice,
  DelegationSummary,
} from "./delegation.js";
export { computeDelegationSummary } from "./delegation.js";
export { parseJsonlLine } from "./jsonl.js";
export type {
  ContextPoint,
  FileAccessAgg,
  FileAccessEntry,
  FileAccessResult,
  FileAccessThread,
  ModelUsageSummary,
  SkillInvocation,
  TokenTotals,
  UsageSummary,
} from "./metrics.js";
export { foldFileAccess, mergeFileAccess, mergeUsageByModel } from "./metrics.js";
export type { CostComponents } from "./pricing/pricing.js";
export {
  estimateCostComponents,
  estimateCostUsd,
  findModelPricing,
  pricingSnapshotInfo,
} from "./pricing/pricing.js";
export type { RepoIdentity } from "./repo.js";
export { deriveRepoIdentity, normalizeRepoUrl } from "./repo.js";
export type { SearchableField, SearchFieldKind } from "./search.js";
export { flattenToSearchText } from "./search.js";
export type { CompactionEvent, SessionAnalysisCore, SessionSource } from "./session-analysis.js";
export type { ParsedShellCommand, ShellSegment } from "./shell/parser.js";
export {
  KNOWN_COMMAND_FAMILIES,
  KNOWN_WRAPPER_COMMANDS,
  parseShellCommand,
  primaryCommand,
} from "./shell/parser.js";
export type { SubagentNode } from "./subagent-node.js";
export type {
  ApiErrorEntry,
  ApiErrorRecordDetail,
  AssistantTextEntry,
  AssistantTextRecordDetail,
  CompactionEntry,
  CompactionRecordDetail,
  RecordDetail,
  SubagentLaunchEntry,
  SubagentLaunchRecordDetail,
  TaskNotificationEntry,
  TaskNotificationRecordDetail,
  ThinkingEntry,
  ThinkingRecordDetail,
  TimelineEntry,
  TimelineOptions,
  ToolCallDetail,
  ToolCallDetailCall,
  ToolCallDetailResult,
  ToolCallEntry,
  ToolCallRecordDetail,
  ToolCallRelatedRecord,
  ToolCallStatus,
  UserEntry,
  UserRecordDetail,
} from "./timeline.js";
export type { ParseWarning, TokenUsage } from "./types.js";
