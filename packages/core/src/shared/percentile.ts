/**
 * Percentile-rank helper for cross-session baselines ("this session's Bash
 * $ spend is P88 for this repo") — the numeric primitive `overview.ts`'s
 * per-repo Bash distribution (`RepoOverviewBashDistribution`) and a future
 * web/MCP layer combine: the overview exposes each repo's sorted per-session
 * values, a session already carries its own `bashSummary` figure (both
 * harnesses — see `sources/shared.ts`), and `percentileRank` is the join
 * between the two. Deliberately a pure numeric function over a plain
 * `number[]`, with no `BashStats`/session-item dependency, so it's reusable
 * for ANY per-session metric a later baseline wants to rank (cost, tokens,
 * duration — not just Bash), and independently unit-testable with exact
 * values.
 */

/**
 * Percentile rank (0-100) of `value` within `sortedAscending` — the "mean
 * rank"/"midpoint" method: a value strictly below `value` counts as a full
 * point, a value EQUAL to `value` counts as HALF a point (so a value tied
 * with every other entry lands at the 50th percentile, not artificially at
 * the top or bottom of its own tie group), and
 * `percentile = (countBelow + countEqual / 2) / n * 100`.
 *
 * `sortedAscending` MUST already be sorted ascending — this function does
 * NOT sort it (callers already hold the sorted array, e.g.
 * `RepoOverviewBashDistribution`'s arrays, so re-sorting on every call would
 * be wasted work); an unsorted input silently produces a meaningless result,
 * not an error, since there is no cheap in-function way to distinguish
 * "unsorted" from "sorted but not what the caller expected".
 *
 * Returns `undefined` — never `0`, which is a real, meaningful percentile —
 * for an empty `sortedAscending` (no distribution to rank against).
 *
 * `value` need not itself be a member of `sortedAscending` (e.g. ranking a
 * brand-new session's figure against an already-computed repo baseline that
 * doesn't yet include it) — both "above the whole array" (100) and "below
 * the whole array" (0) are well-defined.
 *
 * Runs in O(log n) via two binary searches (`countBelow`/`countAtOrBelow`)
 * rather than a linear scan — the array can be as large as a repo's whole
 * session count (bounded by `MAX_LIST_LIMIT`, but still worth not scanning
 * twice per call if a caller ranks many sessions against the same
 * distribution).
 */
export function percentileRank(
  sortedAscending: readonly number[],
  value: number,
): number | undefined {
  const n = sortedAscending.length;
  if (n === 0) return undefined;
  const below = countBelow(sortedAscending, value);
  const atOrBelow = countAtOrBelow(sortedAscending, value);
  const equal = atOrBelow - below;
  return ((below + equal / 2) / n) * 100;
}

/** Count of entries strictly less than `value` — lower-bound binary search. */
function countBelow(sortedAscending: readonly number[], value: number): number {
  let lo = 0;
  let hi = sortedAscending.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midValue = sortedAscending[mid];
    if (midValue !== undefined && midValue < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Count of entries less than or equal to `value` — upper-bound binary search. */
function countAtOrBelow(sortedAscending: readonly number[], value: number): number {
  let lo = 0;
  let hi = sortedAscending.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midValue = sortedAscending[mid];
    if (midValue !== undefined && midValue <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
