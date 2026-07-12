import type { ClaudeSessionAnalysis } from "./claude/analyze.js";
import type { CodexSessionAnalysis } from "./codex/analyze.js";

export * from "./claude/index.js";
export * from "./codex/index.js";
export * from "./shared/index.js";

/** Either harness's analysis, discriminated on `source`. */
export type AnySessionAnalysis = ClaudeSessionAnalysis | CodexSessionAnalysis;
