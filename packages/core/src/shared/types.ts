/**
 * Cross-harness token/parse vocabulary — lifted out of Claude Code's record
 * model (`claude/types.ts`) because Codex's own parser (`codex/parser.ts`)
 * and analyzer (`codex/analyze.ts`) need the exact same shapes: per-message
 * token accounting and a line-anchored parse warning, neither of which
 * depends on either harness's own record schema.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Ephemeral cache-creation breakdown when present. */
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
}

export interface ParseWarning {
  line: number;
  reason: string;
}
