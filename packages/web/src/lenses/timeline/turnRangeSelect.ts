/**
 * Shift-click range-expand semantics (design mock 2i: "Shift-click expands a
 * range"). Pure and render-agnostic, same idiom as `elision.ts` — the anchor
 * bookkeeping (which line is "last plain-/⌥-clicked") stays in
 * `Timeline.tsx`'s `rangeAnchorLine` state; this module only decides which
 * lines a shift-click affects and what state they should end up in. See
 * `handleTurnRowClick`, the only caller.
 */

export interface RangeExpandResult {
  /** Turn `anchorLine`s that must all end up in the SAME expand state — the
   * inclusive range between the anchor and the shift-clicked target, in turn
   * (display) order regardless of which end the anchor/target fall on. */
  affectedLines: readonly number[];
  /** The state every line in `affectedLines` should end up in — always the
   * shift-clicked row's OWN pre-click state, inverted: a collapsed target
   * expands the whole range, an expanded target collapses it. */
  expand: boolean;
}

/**
 * `orderedLines` is every turn's `anchorLine` in display order (the caller
 * derives it from `turnGroups`, never from `turnOverrides` — a `Set` carries
 * no ordering). Returns `null` when the anchor or target isn't present in
 * `orderedLines` (a filtered/rebuilt turn list could in principle drop a
 * stale anchor) — callers fall back to treating the click as a plain click,
 * the same handling as "no prior anchor" (mock 2i).
 */
export function computeShiftClickRange(
  orderedLines: readonly number[],
  anchorLine: number,
  targetLine: number,
  targetWasExpanded: boolean,
): RangeExpandResult | null {
  const anchorIdx = orderedLines.indexOf(anchorLine);
  const targetIdx = orderedLines.indexOf(targetLine);
  if (anchorIdx === -1 || targetIdx === -1) return null;

  const [start, end] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  return {
    affectedLines: orderedLines.slice(start, end + 1),
    expand: !targetWasExpanded,
  };
}
