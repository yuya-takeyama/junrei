/**
 * Deterministic promotions of the cost-performance study's qualitative
 * discoveries (see `docs/cost-playbook.md` §1 and
 * `docs/research/2026-07-cost-performance-study.md`'s internal cluster) into
 * first-class, computable metrics. Both `buildSessionInsight` (one session)
 * and `buildBriefing` (a window) classify sessions through THIS module, so the
 * single-session callout and the briefing roll-up can never disagree on where
 * a session sits on the archetype axis.
 *
 * The method the study calls "the coupled loop": a deep read discovered these
 * structures (archetype by main-cost share, never-compacted context lifetime,
 * the long-implementer turn tail); promoting them here lets quantitative
 * monitoring watch them from now on.
 */

/**
 * Where a session sits on the main-loop cost-share axis (study §1 diagnosis
 * protocol): `marathon` = orchestrator-dominated (main ≥85%), `fan-out` =
 * subagent-dominated (main ≤55%), `mixed` = in between. Classified from cost
 * share ALONE — the risk that a marathon actually cost too much is carried
 * separately by `ContextLifetime.warning`, not folded into this axis (a
 * no-subagent session is a marathon by construction because main IS ≥85%; the
 * study's C6 is explicit that high main% is only a risk factor when paired
 * with high context lifetime, which the warning flag — not the archetype —
 * expresses).
 */
export type SessionArchetype = "marathon" | "fan-out" | "mixed";

/** main-cost share at/above which a session is a MARATHON (study §1). */
export const MARATHON_MAIN_SHARE = 0.85;
/** main-cost share at/below which a session is a FAN-OUT (study §1). */
export const FAN_OUT_MAIN_SHARE = 0.55;

/** ctxMax above which a never-compacted session earns the context-lifetime warning (study R1: "Alarm above 200K ctx"). */
export const CTX_WARNING_TOKENS = 200_000;

/** Subagent tool-call count above which a subagent is worth WATCHING (study A5/R4: cap ~60). */
export const TURN_WATCH_THRESHOLD = 60;
/** Subagent tool-call count above which a subagent is a turn-budget OUTLIER — "treat >150 as a design failure" (study R4). */
export const TURN_OUTLIER_THRESHOLD = 150;

/**
 * Classify a session by its main-loop cost share (`delegation.main.costUsd /
 * totalCostUsd`). A `null` share means the session couldn't be priced, so it
 * can't be placed on the cost axis at all — reported as `mixed` (the neutral
 * middle) rather than guessing a tier; the caller still exposes the raw share
 * (here, `null`) so the ambiguity is visible.
 */
export function classifyArchetype(mainCostShare: number | null): SessionArchetype {
  if (mainCostShare === null) return "mixed";
  if (mainCostShare >= MARATHON_MAIN_SHARE) return "marathon";
  if (mainCostShare <= FAN_OUT_MAIN_SHARE) return "fan-out";
  return "mixed";
}

/** True when a session ran past the context alarm with no compaction to relieve it — the study's single biggest lever (R1/A1). */
export function isContextLifetimeWarning(ctxMaxTokens: number, compactionCount: number): boolean {
  return ctxMaxTokens > CTX_WARNING_TOKENS && compactionCount === 0;
}
