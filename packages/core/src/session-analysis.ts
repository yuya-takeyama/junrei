import type { ContextPoint, ModelUsageSummary, TokenTotals, UsageSummary } from "./metrics.js";
import type { CompactionEvent } from "./session-data.js";

/** Which harness produced a session transcript. */
export type SessionSource = "claude-code" | "codex";

/**
 * Fields genuinely shared between Claude Code and Codex CLI session
 * analyses. Harness-specific detail — Claude's subagent tree and per-tool
 * breakdowns, Codex's turn/tool-call metadata — lives on the discriminated
 * `ClaudeSessionAnalysis` / `CodexSessionAnalysis` variants (see
 * `analyze.ts` and `codex/analyze.ts`) instead of being faked here with
 * empty placeholders.
 */
export interface SessionAnalysisCore {
  sessionId: string;
  filePath: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  userTurnCount: number;
  models: string[];
  /** Main transcript only — Codex sessions have no subagent concept, so this equals `totalUsage`'s token side. */
  usage: UsageSummary;
  /** Main + all subagents (Claude) or just the session itself (Codex). */
  totalUsage: TokenTotals & { costUsd: number; costIsComplete: boolean };
  /** Per-model usage, merged (recursively for Claude) by model id. */
  totalUsageByModel: ModelUsageSummary[];
  contextTimeline: ContextPoint[];
  compactions: CompactionEvent[];
  firstUserPrompt?: string;
  /** Source line of the first user prompt (provenance for the Overview lens's "L<n>" ref). */
  firstUserPromptLine?: number;
  parseWarningCount: number;
}
