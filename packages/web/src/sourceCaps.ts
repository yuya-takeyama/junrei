import type { AnySessionJson, SessionListItem } from "./api.js";

/**
 * What a given session's own source can honestly show — one place to look up
 * "does this source have X" instead of scattering `session.source ===
 * "claude-code"` (or `"codex"`) checks across every lens component. Each
 * flag names a UI-visible capability rather than a raw data field, so a
 * caller reads intent (`caps.hasApiErrors`) rather than re-deriving it.
 *
 * Only covers capabilities that were previously expressed as inline
 * `session.source === ...` conditionals in more than one place, or whose
 * name clarifies non-obvious asymmetry (Codex's estimated-cost marker).
 * Purely local one-off branches (e.g.
 * `SessionShell`'s "turns" lens gate, which already reads `CODEX_LENSES`)
 * are left as direct `source` checks — routing them through this module too
 * would just be indirection with no shared meaning.
 */
export interface SourceCaps {
  /** Per-tool-call breakdown (`toolStats`) — Claude only, no Codex equivalent. */
  hasToolStats: boolean;
  /** Repetition/loop detector findings — Claude only (no Codex repetition detector). */
  hasRepetitions: boolean;
  /** Background-task log (Bash/Agent runs, preview servers) — Claude only. */
  hasTaskExecutions: boolean;
  /** Per-API-message error log — Claude only (Codex has no "API error" concept). */
  hasApiErrors: boolean;
  /** Per-turn cache-write cost composition chart — Claude only (Codex has no cache-write cost). */
  hasTurnCompositionChart: boolean;
  /** True when the session's cost is a Codex API-list-price estimate rather than a billed Claude Code amount. */
  costIsEstimated: boolean;
}

const CLAUDE_CAPS: SourceCaps = {
  hasToolStats: true,
  hasRepetitions: true,
  hasTaskExecutions: true,
  hasApiErrors: true,
  hasTurnCompositionChart: true,
  costIsEstimated: false,
};

const CODEX_CAPS: SourceCaps = {
  hasToolStats: false,
  hasRepetitions: false,
  hasTaskExecutions: false,
  hasApiErrors: false,
  hasTurnCompositionChart: false,
  costIsEstimated: true,
};

/** Resolve capabilities for a full session analysis (AnySessionJson) or a session-list row. */
export function capsFor(session: Pick<AnySessionJson | SessionListItem, "source">): SourceCaps {
  return session.source === "codex" ? CODEX_CAPS : CLAUDE_CAPS;
}
