import type { SessionJson } from "../../api.js";

type CompactionEventLike = SessionJson["compactions"][number];
type TurnUsageLike = SessionJson["turnUsage"][number];

export type TimelineItem =
  | { kind: "turn"; turn: TurnUsageLike; index: number }
  | { kind: "compaction"; compaction: CompactionEventLike };

/**
 * Interleave `turns` (already in ascending line order — one per user prompt)
 * with `compactions` (arbitrary order) purely by source line, for the
 * per-turn stacked bar chart's `.svd` dividers:
 *
 * - A compaction whose line is <= a turn's line is placed immediately
 *   BEFORE that turn (so a compaction before the first turn lands at the
 *   very start; one between two turns lands right before the later one).
 * - Any compaction whose line is greater than every turn's line is
 *   appended at the very end (compaction after the last turn).
 *
 * Pure and presentation-agnostic — the caller decides how to render each
 * item kind (turn column vs. `.svd` divider).
 */
export function interleaveTurnsAndCompactions(
  turns: readonly TurnUsageLike[],
  compactions: readonly CompactionEventLike[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const sortedCompactions = [...compactions].sort((a, b) => a.line - b.line);
  let compactionIndex = 0;

  const emitCompactionsUpTo = (lineInclusiveUpperBound: number | undefined) => {
    while (
      compactionIndex < sortedCompactions.length &&
      (lineInclusiveUpperBound === undefined ||
        (sortedCompactions[compactionIndex] as CompactionEventLike).line <= lineInclusiveUpperBound)
    ) {
      items.push({
        kind: "compaction",
        compaction: sortedCompactions[compactionIndex] as CompactionEventLike,
      });
      compactionIndex += 1;
    }
  };

  turns.forEach((turn, index) => {
    emitCompactionsUpTo(turn.line);
    items.push({ kind: "turn", turn, index });
  });
  emitCompactionsUpTo(undefined); // remaining compactions after the last turn

  return items;
}

export interface StackHeights {
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  output: number;
}

const MAX_STACK_PX = 110;
const MIN_SEGMENT_PX = 1;

/** Total of a turn's 4 stackable components — the basis for the shared scale across all turns. */
export function turnStackTotal(turn: TurnUsageLike): number {
  return turn.cacheReadTokens + turn.cacheCreationTokens + turn.inputTokens + turn.outputTokens;
}

/**
 * Linear-scale one turn's 4 token components to stacked-bar segment heights
 * (px), where `maxTotal` (the largest `turnStackTotal` across every turn in
 * the chart) maps to `MAX_STACK_PX`. Any nonzero component gets at least
 * `MIN_SEGMENT_PX` so it stays visible even when tiny relative to the rest.
 */
export function turnStackHeights(turn: TurnUsageLike, maxTotal: number): StackHeights {
  const scale = maxTotal > 0 ? MAX_STACK_PX / maxTotal : 0;
  const px = (value: number) => (value > 0 ? Math.max(MIN_SEGMENT_PX, value * scale) : 0);
  return {
    cacheRead: px(turn.cacheReadTokens),
    cacheWrite: px(turn.cacheCreationTokens),
    freshIn: px(turn.inputTokens),
    output: px(turn.outputTokens),
  };
}
