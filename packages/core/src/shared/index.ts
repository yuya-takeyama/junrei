/**
 * Agent-agnostic vocabulary and helpers shared by the `claude/` and `codex/`
 * trees. MUST NOT import from either of those trees.
 */

// `BashOpportunity*` are `BashStats.opportunities`' own item shape (see
// `bash-opportunities.ts`'s module doc comment) — exported from here
// alongside the rest of the Bash-analysis output vocabulary above, same
// "shared data shape, one canonical export site" convention.
export type {
  BashOpportunity,
  BashOpportunityClass,
  BashOpportunityEvidence,
  BashOpportunityLever,
  BashOpportunitySavingsBasis,
} from "./bash-opportunities.js";
/**
 * `Bash*`/`BashStats`/`BashWaste` are the harness-neutral OUTPUT shapes of
 * the Bash-analysis engine (`./bash-stats.ts`) — exported from here only
 * (never re-declared in `claude/index.ts`/`codex/index.ts`), same "shared
 * data shape, one canonical export site" convention `FileAccessEntry`/
 * `SkillInvocation` already follow below. The engine FUNCTION
 * (`computeBashStats` in `./bash-stats.ts`) and its `NeutralBashCall`/
 * `NeutralBashThread` input types are deliberately NOT exported from this
 * barrel: each harness's own `computeBashStats` (`claude/bash-stats.ts`,
 * `codex/bash-stats.ts`) has a DIFFERENT input signature (Claude:
 * `BashStatsThread[]` wrapping `SessionData`; Codex: a `CodexTranscript`),
 * so re-exporting the shared engine under the same bare name here would
 * collide with Claude's own adapter export at the `@junrei/core` barrel
 * level (`index.ts`'s `export *`).
 */
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
  BashThreadGroup,
  BashTotals,
  BashWaste,
} from "./bash-stats.js";
export { LARGE_RESULT_CHARS_THRESHOLD, normalizeCommandForDedup } from "./bash-stats.js";
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
  CacheableTokenTotals,
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
export { cacheHitRate, foldFileAccess, mergeFileAccess, mergeUsageByModel } from "./metrics.js";
export { percentileRank } from "./percentile.js";
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
// `ToolErrorCategory` (defined in `./tool-error.ts`) is re-exported at the
// `@junrei/core` barrel via `claude/index.ts` (through `claude/metrics.ts`),
// its long-standing export site — NOT re-exported here too, to avoid an
// ambiguous duplicate `export *` at `index.ts`.
//
// `Tool*`/`ToolUsageStats` are the harness-neutral OUTPUT shapes of the
// cross-tool usage engine (`./tool-usage-stats.ts`) — exported from here only,
// same "shared data shape, one canonical export site" convention `BashStats`
// follows above. The engine FUNCTION (`computeToolUsageStats`) and its
// `NeutralToolCall`/`NeutralToolThread` INPUT types are NOT exported from this
// barrel: each harness's own adapter (`claude/tool-usage-stats.ts`,
// `codex/tool-usage-stats.ts`) has a different input signature, so re-exporting
// the shared engine under the same bare name would collide at the `@junrei/core`
// barrel level — identical reasoning to `computeBashStats` above.
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
export { durationBetween } from "./timeline.js";
export type {
  ToolGroup,
  ToolHeavyHitter,
  ToolUsageStats,
  ToolUsageTotals,
} from "./tool-usage-stats.js";
export type {
  TrendBashSummary,
  TrendBucket,
  TrendDelegationCostSplit,
  TrendDelegationSlice,
  TrendDelta,
  TrendModelCost,
  TrendModelUsageEntry,
  TrendSessionItem,
  TrendSpikeDay,
  TrendSubagentReturn,
  TrendsOptions,
  TrendsReport,
  TrendTokenTotals,
  TrendTopSession,
  TrendWindow,
  TrendWindowTotals,
} from "./trends.js";
export { computeTrends } from "./trends.js";
export type { ParseWarning, TokenUsage } from "./types.js";
