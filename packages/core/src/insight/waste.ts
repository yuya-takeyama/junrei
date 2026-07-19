/**
 * Shared mapping from the raw Bash-analysis `opportunities` (and oversized
 * subagent returns) into the insight layer's flat, dollar-ranked `WasteItem`
 * shape — used by both `buildBriefing` (cross-session ranking) and
 * `buildSessionInsight` (single-session ranking) so the two never diverge on
 * how a waste finding is titled/priced.
 */
import type { BashOpportunity } from "../shared/bash-opportunities.js";
import type { SessionSource } from "../shared/session-analysis.js";
import type { WasteItem } from "./types.js";

/** Where a waste finding was observed. */
export interface WasteProvenance {
  source: SessionSource;
  sessionId: string;
  title?: string;
}

/** A subagent whose return to its parent was large enough to flag. */
export interface OversizedReturn {
  agentId: string;
  returnedChars: number;
  /** Priced return cost, when the agent's model was known. */
  costUsd?: number;
}

/** Chars at/above which a subagent return is treated as an oversized-context waste finding. */
export const OVERSIZED_RETURN_CHARS = 20_000;

/** Convert one session's Bash opportunities into `WasteItem`s carrying its provenance. */
export function opportunitiesToWaste(
  opportunities: readonly BashOpportunity[],
  provenance: WasteProvenance,
): WasteItem[] {
  return opportunities.map((op) => ({
    class: op.class,
    title: op.title,
    fix: op.fixText,
    ...(op.estUsdSaved !== undefined && { impactUsd: op.estUsdSaved }),
    provenance: {
      source: provenance.source,
      sessionId: provenance.sessionId,
      ...(provenance.title !== undefined && { title: provenance.title }),
    },
  }));
}

/** Convert oversized subagent returns into `oversized-return` `WasteItem`s. */
export function oversizedReturnsToWaste(
  returns: readonly OversizedReturn[],
  provenance: WasteProvenance,
): WasteItem[] {
  return returns
    .filter((r) => r.returnedChars >= OVERSIZED_RETURN_CHARS)
    .map((r) => ({
      class: "oversized-return" as const,
      title: `Subagent ${r.agentId} returned ${r.returnedChars.toLocaleString()} chars to its parent`,
      fix: "Have the subagent return a compact summary (file paths + a short conclusion), not its full working output.",
      ...(r.costUsd !== undefined && { impactUsd: r.costUsd }),
      provenance: {
        source: provenance.source,
        sessionId: provenance.sessionId,
        ...(provenance.title !== undefined && { title: provenance.title }),
      },
    }));
}

/**
 * Rank waste findings by dollar impact, descending — items with a KNOWN
 * `impactUsd` always sort above items whose impact is unknown (an unknown
 * impact is not treated as `0`; it's "we couldn't price this", and a priced
 * finding is always the more actionable one to show first).
 */
export function rankWaste(items: readonly WasteItem[]): WasteItem[] {
  return [...items].sort((a, b) => {
    if (a.impactUsd === undefined && b.impactUsd === undefined) return 0;
    if (a.impactUsd === undefined) return 1;
    if (b.impactUsd === undefined) return -1;
    return b.impactUsd - a.impactUsd;
  });
}
