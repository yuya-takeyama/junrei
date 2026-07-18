/**
 * "Virtual wire" reconstruction layer (Goshuin Phase C). Reconstructs the
 * per-request Anthropic `/v1/messages` payload for a Claude Code main-loop
 * request from the session log + attachments + a user-local per-CLI-version
 * template + current disk state, with every part labelled by a confidence
 * class. See `types.ts` for the vocabulary and `reconstruct.ts` for the API.
 */

export { renderAgentListingBlock, renderSkillListingBlock } from "./attachments.js";
export {
  deriveCurrentDate,
  type RenderedDiskContextBlock,
  renderClaudeMdContextBlock,
} from "./disk-context.js";
export {
  deriveReconstructionSessionMeta,
  listReconstructableRequests,
  loadReconstructionInput,
  reconstructRequest,
} from "./reconstruct.js";
export {
  buildTurns,
  parseReconstructionRecords,
  type ReplayBlock,
  type ReplayResult,
  type ReplayStats,
  type ReplayTurn,
} from "./replay.js";
export {
  applyCacheControlStrip,
  applyCallerStrip,
  applyContentForm,
  applyThinkingDrop,
  RULE_CACHE_CONTROL_STRIP,
  RULE_CALLER_STRIP,
  RULE_CONTENT_FORM,
  RULE_QUEUE_OPERATION_SKIP,
  RULE_TASK_NOTIFICATION_PREAMBLE,
  RULE_THINKING_DROP,
} from "./rules.js";
export {
  parseReconstructionTemplate,
  type SubstitutionResult,
  type SubstitutionValues,
  substituteTemplateText,
} from "./template.js";
export type {
  ConfidenceClass,
  DiskContext,
  DiskContextFile,
  DiskContextProvider,
  DiskFileProvenance,
  Provenance,
  ReconAssistantRecord,
  ReconAttachmentRecord,
  ReconContentBlock,
  ReconOtherRecord,
  ReconstructableRequestRef,
  ReconstructedMessage,
  ReconstructedMessageBlock,
  ReconstructedParamEntry,
  ReconstructedParams,
  ReconstructedRequest,
  ReconstructedSection,
  ReconstructedSystemBlock,
  ReconstructionInput,
  ReconstructionProviders,
  ReconstructionRecord,
  ReconstructionSessionMeta,
  ReconstructionTemplate,
  ReconstructionTemplateProvider,
  ReconstructionTemplateSystemBlock,
  ReconUserRecord,
} from "./types.js";
