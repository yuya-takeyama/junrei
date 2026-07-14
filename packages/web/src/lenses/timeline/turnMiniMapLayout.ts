import { formatTime } from "../../format.js";
import { isErrorEntry } from "./timelineFilters.js";
import { isOutlierTurn, type TurnGroup } from "./turnGroups.js";

/** Smallest a turn's minimap band is ever allowed to shrink to — below this a
 * single-entry turn stops being a reliable click target. */
export const MIN_TURN_BAND_HEIGHT_PX = 4;

/**
 * Per-turn band heights (px) for the turn-aware minimap track: proportional
 * to each turn's entry count, but never below `minHeight`. Naive proportional
 * sizing alone would starve small turns below a usable click target, so any
 * band that would land under the floor is clamped to it; the height that
 * frees up is redistributed among the remaining bands (a "water-filling"
 * pass, repeated until nothing new clamps). Every remaining band is
 * guaranteed to clear the floor once the pass stabilizes — see the proof
 * sketch below — so the loop is bounded by `counts.length` passes without
 * needing a convergence check.
 *
 * Degenerate case: more turns than the track has room for even at the floor
 * (`minHeight * counts.length >= trackHeight`) splits the track evenly
 * instead — the minimum stops being meaningful once every band is already
 * forced to the same size.
 *
 * Proof sketch that the last unclamped band never itself needs clamping:
 * once only it remains free, its share equals the *entire* remaining height
 * (freeWeight reduces to its own weight, so the ratio is 1). That remaining
 * height is `trackHeight - minHeight * (n - 1)`, which is `> minHeight`
 * exactly when `trackHeight > minHeight * n` — guaranteed by the guard
 * above. So at least one band always stays unclamped and the loop always
 * has somewhere to put the leftover height.
 */
export function layoutTurnBandHeights(
  counts: readonly number[],
  trackHeight: number,
  minHeight: number = MIN_TURN_BAND_HEIGHT_PX,
): number[] {
  const n = counts.length;
  if (n === 0) return [];
  if (trackHeight <= 0) return counts.map(() => 0);
  if (minHeight * n >= trackHeight) return counts.map(() => trackHeight / n);

  const heights = new Array<number>(n).fill(0);
  const clamped = new Array<boolean>(n).fill(false);
  let freeHeight = trackHeight;
  let freeWeight = counts.reduce((sum, c) => sum + c, 0);
  let freeCount = n;

  for (let pass = 0; pass < n; pass++) {
    let clampedThisPass = false;
    for (let i = 0; i < n; i++) {
      if (clamped[i] === true) continue;
      const weight = counts[i] as number;
      const share = freeWeight > 0 ? (freeHeight * weight) / freeWeight : freeHeight / freeCount;
      if (share < minHeight) {
        heights[i] = minHeight;
        clamped[i] = true;
        freeHeight -= minHeight;
        freeWeight -= weight;
        freeCount -= 1;
        clampedThisPass = true;
      }
    }
    if (!clampedThisPass) break;
  }

  for (let i = 0; i < n; i++) {
    if (clamped[i] === true) continue;
    const weight = counts[i] as number;
    heights[i] = freeWeight > 0 ? (freeHeight * weight) / freeWeight : freeHeight / freeCount;
  }

  return heights;
}

/** Minimap hover/label text — "#7 · 14:52", or just "#7" when the turn has no
 * timestamp to show (spec: omit the time part when `startedAt` is undefined). */
export function turnTooltipLabel(index: number, startedAt: string | undefined): string {
  return startedAt === undefined ? `#${index}` : `#${index} · ${formatTime(startedAt)}`;
}

export interface TurnBandFlags {
  /** Reuses `isOutlierTurn` — the same rule that tints the `.trg` row amber. */
  isOutlier: boolean;
  /** Any tool-call error or api-error entry in the turn — matches `isErrorEntry`,
   * the flat minimap's own error definition, so the two rails agree on what "error" means. */
  hasError: boolean;
  /** The turn contains a compaction entry — the same entries `Timeline.tsx`
   * surfaces as a trailing sibling row when the turn itself is collapsed. */
  hasCompaction: boolean;
}

/** Per-turn accent flags for one minimap band, derived once from the group
 * and the session's total turn cost (for the outlier share). */
export function deriveTurnBandFlags(
  group: Pick<TurnGroup, "costUsd" | "entries">,
  totalCostUsd: number,
): TurnBandFlags {
  return {
    isOutlier: isOutlierTurn(group.costUsd, totalCostUsd),
    hasError: group.entries.some(isErrorEntry),
    hasCompaction: group.entries.some((e) => e.kind === "compaction"),
  };
}
