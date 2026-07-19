/**
 * Insight layer — the "conclusion-first" composition tier over the raw
 * analysis functions, plus the repo-local learning ledger. See each module's
 * doc comment; the server (PR2) wires these into the MCP surface and REST.
 */

export type {
  Briefing,
  BriefingLearnings,
  BriefingSessionInput,
  BriefingSubagentLaunch,
  BriefingSummary,
  BriefingWin,
  BuildBriefingInput,
} from "./briefing.js";
export { buildBriefing } from "./briefing.js";
export type {
  EvidenceFetchers,
  EvidenceResult,
  EvidenceSelect,
  SelectEvidenceInput,
} from "./evidence.js";
export { selectEvidence } from "./evidence.js";
export type {
  CreateLearningInput,
  ListLearningsFilter,
  ListLearningsResult,
  UpdateLearningPatch,
} from "./learningsStore.js";
export {
  createLearning,
  listLearnings,
  resolveRepoRoot,
  updateLearning,
} from "./learningsStore.js";
export { approxTokens, buildMeta } from "./meta.js";
export type {
  DelegationPattern,
  FindPatternsInput,
  FindPatternsResult,
  PatternKind,
  PatternSessionInput,
  PatternTextHit,
  WastePattern,
} from "./patterns.js";
export { findPatterns } from "./patterns.js";
export type {
  CostDriver,
  DelegationHealth,
  Recommendation,
  SessionInsight,
  SessionInsightInput,
  SessionInsightSummary,
} from "./sessionInsight.js";
export { buildSessionInsight } from "./sessionInsight.js";
export type {
  Detail,
  InsightMeta,
  Learning,
  LearningSource,
  LearningStatus,
  LearningVerification,
  WasteItem,
} from "./types.js";
export type { OversizedReturn, WasteProvenance } from "./waste.js";
export {
  OVERSIZED_RETURN_CHARS,
  opportunitiesToWaste,
  oversizedReturnsToWaste,
  rankWaste,
} from "./waste.js";
