/**
 * Session-detail percentile seam ("Bash tab v2" header strip's percentile
 * chip — "pNN for this repo · M.Mx median") — the one small server addition
 * the redesign needed, per the web-layer convention that `packages/web`
 * never imports `@junrei/core` directly (types cross via Hono-inferred JSON
 * only, see `packages/web/src/api.ts`). `@junrei/core`'s `percentileRank`
 * (a pure numeric primitive over `RepoOverviewBashDistribution`'s sorted
 * arrays — see `overview.ts`) does the actual rank math; this module is just
 * the session-detail-specific glue: pick which figure to rank ($ when both
 * this session's own figure AND the repo distribution have enough priced
 * samples, else chars) and the "not enough repo history yet" gate.
 *
 * Deliberately NOT exported as part of `RepoOverview` itself — a session's
 * OWN figure only exists at the session-detail route, not at
 * `computeRepoOverview` time, so this stays a separate small function the
 * detail routes (`app.ts`) call after they already have both the session's
 * own bash figure and that session's repo's `RepoOverviewBash`.
 */
import { percentileRank } from "@junrei/core";
import type { RepoOverviewBash } from "./overview.js";

/**
 * `pct` — 0-100, one decimal (see `percentileRank`'s own "mean rank" method).
 * `medianRatio` — this session's own figure ÷ the distribution's median,
 * rounded to 2 decimals; `undefined` when the median is 0 (a ratio against
 * zero is meaningless, not "0x"). `sampleCount` — how many sessions fed the
 * ranked distribution, so the web layer can render "for N sessions" instead
 * of a bare, uncontextualized percentile.
 */
export interface SessionBashPercentile {
  pct: number;
  medianRatio?: number;
  sampleCount: number;
}

/**
 * Below this many sessions in the repo's own Bash distribution, a percentile
 * rank is too noisy to show at all (a rank against 2 other sessions isn't a
 * real baseline) — the chip stays hidden entirely rather than rendering a
 * misleadingly precise-looking number. Matches the product-owner-facing
 * "the repo has >= 5 sessions with bash data" gate from the redesign brief.
 */
const MIN_SESSIONS_FOR_PERCENTILE = 5;

/** The middle value of an ALREADY-sorted-ascending array — `undefined` only for an empty array (never reachable here, callers already gate on length). */
function median(sortedAscending: readonly number[]): number | undefined {
  const n = sortedAscending.length;
  if (n === 0) return undefined;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAscending[mid];
  const lo = sortedAscending[mid - 1];
  const hi = sortedAscending[mid];
  return lo === undefined || hi === undefined ? undefined : (lo + hi) / 2;
}

/**
 * This session's own Bash figure, on WHICHEVER basis the repo distribution
 * can rank it against — see `computeSessionBashPercentile`'s doc comment for
 * why `estUsd` is main-thread-only for a Codex session specifically (not
 * just "whatever `BashStats.totals` says").
 */
export interface SessionBashFigure {
  // `| undefined` explicit (not just `?:`) — the caller composes this from
  // `BashTotals.estUsd`, itself typed `estUsd?: number` but frequently
  // spread from a real `number | undefined` local (see app.ts's two call
  // sites), and `exactOptionalPropertyTypes` rejects assigning an explicit
  // `undefined` value to a bare `?:` field. Same pattern as `format.ts`'s
  // `DelegationShareScope.costUsd` on the web side.
  estUsd?: number | undefined;
  resultChars: number;
}

/**
 * Ranks `ownFigure` against `bash`'s repo-wide distribution — `undefined`
 * when the repo doesn't yet have `MIN_SESSIONS_FOR_PERCENTILE` sessions with
 * Bash data (every matched session always contributes a `resultChars`
 * sample, even `0` for a Bash-free session — see
 * `RepoOverviewBashDistribution`'s doc comment — so `distribution.
 * resultChars.length` IS the repo's own Bash-tracked session count).
 *
 * Basis choice: $ when BOTH `ownFigure.estUsd` is known AND the repo's own
 * `estUsd` distribution itself has enough priced samples to rank against
 * (same `MIN_SESSIONS_FOR_PERCENTILE` bar, applied a second time since a
 * repo can clear the overall-session bar while still having too few PRICED
 * sessions to rank $ meaningfully); otherwise chars — the exact same $-else-
 * tokens fallback the header strip's own headline figure uses, so the chip
 * always describes the SAME number the headline shows.
 *
 * CALLER'S RESPONSIBILITY — the Codex main-thread-only caveat: for a Codex
 * session, `ownFigure` must be the session's OWN main-thread-only figure
 * (`getCodexSessionBashStatsMainOnly`, sources/codex.ts), NOT its detail
 * view's `bashStats.totals` (which can be forest-inclusive once a
 * sub-agent forest exists — `getCodexSession`'s own doc comment). The repo
 * distribution's per-session samples are themselves always built from each
 * Codex session's main-thread-only `bashSummary` (list-item time never pays
 * the forest re-parse cost — see `sources/codex.ts`'s `toCodexListItem`
 * comment), so ranking the detail view's forest-inclusive figure against
 * that distribution would compare two different bases and produce a
 * percentile that doesn't mean what it claims to. This is exactly why the
 * web layer's percentile chip carries a footnote for Codex sessions ("this
 * session's own detail figure may be larger than what's ranked here") —
 * see `bashLensFormat.ts`'s `buildHeaderStrip`.
 */
export function computeSessionBashPercentile(
  ownFigure: SessionBashFigure,
  bash: RepoOverviewBash,
): SessionBashPercentile | undefined {
  if (bash.distribution.resultChars.length < MIN_SESSIONS_FOR_PERCENTILE) return undefined;

  const useUsd =
    ownFigure.estUsd !== undefined &&
    bash.distribution.estUsd.length >= MIN_SESSIONS_FOR_PERCENTILE;
  const sorted = useUsd ? bash.distribution.estUsd : bash.distribution.resultChars;
  // `useUsd` guarantees `ownFigure.estUsd !== undefined` in that branch.
  const value = useUsd ? (ownFigure.estUsd as number) : ownFigure.resultChars;

  const pct = percentileRank(sorted, value);
  if (pct === undefined) return undefined;

  const med = median(sorted);
  const medianRatio =
    med !== undefined && med > 0 ? Math.round((value / med) * 100) / 100 : undefined;

  return {
    pct: Math.round(pct * 10) / 10,
    ...(medianRatio !== undefined && { medianRatio }),
    sampleCount: sorted.length,
  };
}
