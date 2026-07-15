import type { TimelineEntry } from "../../api.js";

/**
 * Long-turn middle elision (design mock panel 2d, `.elide`/`.eline`) — once
 * an expanded turn's chip/dial-FILTERED entry list runs long, the middle
 * collapses behind a one-line summary so the turn's outcome (its last
 * events) never sits a long scroll away from its start. Pure and
 * render-agnostic: Timeline.tsx owns the per-turn reveal state and JSX; this
 * module only decides which entries land in which bucket.
 *
 * Unrelated to `turnsUpToBudget` in turnGroups.ts, which budgets RAW entry
 * counts per turn for the whole-transcript "show more turns" chunking —
 * that decides which turns render AT ALL, before this module ever runs.
 * Elision only reshapes how one already-decided-to-render, already-filtered
 * turn's entries lay out.
 */

/** Below this many filtered entries, a turn renders in full — no elision. */
export const ELISION_THRESHOLD = 16;

/** How many entries "show N more" pulls off the top of the hidden middle per click. */
export const REVEAL_STEP = 25;

/** Anchor entries always shown at each end of an elided turn (mock: "first 2 + last 2 always render"). */
const ANCHOR_COUNT = 2;

export interface ElisionResult {
  /** Leading entries always visible — the front anchor plus anything revealed via "show N more"/"show all". */
  head: TimelineEntry[];
  /** Entries still collapsed behind the summary row. */
  hidden: TimelineEntry[];
  /** Trailing entries always visible — the turn's outcome. */
  tail: TimelineEntry[];
}

/**
 * Splits one turn's filtered entries into head/hidden/tail. `revealedCount`
 * is how many entries "show N more" has pulled off the TOP of the hidden
 * middle so far (0 = nothing revealed); pass `Number.POSITIVE_INFINITY` for
 * "show all" rather than computing the exact remaining count — this clamps
 * to it anyway.
 *
 * Below `ELISION_THRESHOLD`, or once everything's been revealed, `hidden` is
 * empty and `head` holds the entire list — `head`/`hidden`/`tail` always
 * concatenate back to exactly `entries`, so the render side can key off
 * `hidden.length === 0` alone to decide whether a summary row is needed,
 * with no separate case for "never elided" vs. "elided then fully revealed".
 */
export function elideEntries(
  entries: readonly TimelineEntry[],
  revealedCount: number,
): ElisionResult {
  if (entries.length <= ELISION_THRESHOLD) {
    return { head: entries.slice(), hidden: [], tail: [] };
  }

  const middleEnd = entries.length - ANCHOR_COUNT;
  const middleLength = middleEnd - ANCHOR_COUNT;
  const revealed = Math.min(Math.max(revealedCount, 0), middleLength);

  return {
    head: entries.slice(0, ANCHOR_COUNT + revealed),
    hidden: entries.slice(ANCHOR_COUNT + revealed, middleEnd),
    tail: entries.slice(middleEnd),
  };
}

/**
 * The summary row's kind vocabulary mirrors the Timeline filter chips
 * exactly (see `timelineFilters.ts`'s `chipAllows`) — the mock's own
 * annotation ties the two together ("matching filter chips re-surface
 * elided events"), so a hidden-middle tally reads as the same buckets a
 * chip click would filter by, not the raw wire `kind` strings.
 */
export type ElisionKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "subagent"
  | "error"
  | "compaction";

function elisionKindOf(entry: TimelineEntry): ElisionKind {
  switch (entry.kind) {
    case "user":
      return "user";
    case "assistant-text":
      return "assistant";
    case "thinking":
      return "thinking";
    case "tool-call":
      return entry.status === "error" ? "error" : "tool";
    case "task-notification":
      return "tool";
    case "subagent-launch":
      return "subagent";
    case "compaction":
      return "compaction";
    case "api-error":
      return "error";
  }
}

export interface KindCount {
  kind: ElisionKind;
  count: number;
}

/** Kind buckets shown in the summary row before it falls back to a trailing "+n" — keeps the row to one line, matching the mock. */
export const KIND_COUNT_CAP = 3;

/**
 * Tallies the hidden middle into the chip-shaped buckets above, descending
 * by count (ties keep first-seen order — `Array.sort` is stable). Only the
 * `KIND_COUNT_CAP` biggest nonzero buckets are returned; `overflow` counts
 * how many additional nonzero kinds didn't make the cut, for the summary
 * row's trailing "+n".
 */
export function hiddenKindCounts(hidden: readonly TimelineEntry[]): {
  counts: KindCount[];
  overflow: number;
} {
  const tally = new Map<ElisionKind, number>();
  for (const entry of hidden) {
    const kind = elisionKindOf(entry);
    tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  const sorted = [...tally.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  return {
    counts: sorted.slice(0, KIND_COUNT_CAP),
    overflow: Math.max(0, sorted.length - KIND_COUNT_CAP),
  };
}
