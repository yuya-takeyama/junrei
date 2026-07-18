import type { TrendBucket, TrendSpikeDay } from "@junrei/core";

/**
 * Pure per-day derived metrics and chart-geometry helpers for the Trends
 * screen (`../Trends.tsx`) — split out from the render components the same
 * way `contextCost/timelineLayout.ts` splits stack-height math out of
 * `TurnCompositionChart.tsx`, so the arithmetic is testable without mounting
 * anything.
 */

// ---------------------------------------------------------------------------
// Per-day derived metrics (efficiency small multiples, cadence panel)
// ---------------------------------------------------------------------------

/**
 * Compactions per session for one day — null (not 0) on a day with zero
 * sessions, since "0 compactions / 0 sessions" isn't a real rate, it's an
 * undefined one; the efficiency sparkline (`EfficiencyMultiples.tsx`) treats
 * null as a gap to skip, never a 0 to plot.
 */
export function compactionsPerSession(
  bucket: Pick<TrendBucket, "compactionCount" | "sessionCount">,
): number | null {
  return bucket.sessionCount > 0 ? bucket.compactionCount / bucket.sessionCount : null;
}

/** Average subagent-return size for one day — null when no subagent returned anything that day (`subagentReturn` is null, or a defensive 0-count guard). */
export function avgSubagentReturnChars(bucket: Pick<TrendBucket, "subagentReturn">): number | null {
  const r = bucket.subagentReturn;
  return r !== null && r.count > 0 ? r.totalChars / r.count : null;
}

/**
 * Crude chars -> tokens estimate (chars ÷ 4, the same rule-of-thumb used
 * industry-wide when no real tokenizer is on hand) — the mission's own
 * benchmark ("typical worker summary: 1–2k tokens", docs/concept.md §4.6) is
 * stated in tokens, but every return-size figure this app actually measures
 * (`returnedChars`) is in chars, so `EfficiencyMultiples.tsx`'s subagent-
 * return panel needs SOME conversion to compare like with like. Labeled
 * explicitly as an estimate wherever it's shown (never presented as an exact
 * token count) — see that component's doc comment.
 */
export function approxTokensFromChars(chars: number): number {
  return chars / 4;
}

/** The window's single largest subagent return, in chars — the max of every bucket's own `subagentReturn.maxChars` (already itself a max across sessions, see `@junrei/core`'s `TrendSubagentReturn.maxChars`). Null when nothing in the window has a `subagentReturn` at all (e.g. an all-Codex window). Surfaces the outlier a mean alone would hide — see `EfficiencyMultiples.tsx`. */
export function windowMaxSubagentReturnChars(buckets: readonly TrendBucket[]): number | null {
  const maxes = buckets
    .map((b) => b.subagentReturn?.maxChars)
    .filter((v): v is number => v !== undefined);
  return maxes.length > 0 ? Math.max(...maxes) : null;
}

/** Average session duration for one day — null (not 0) on a day with zero sessions, same reasoning as `compactionsPerSession`. */
export function avgDurationMs(
  bucket: Pick<TrendBucket, "totalDurationMs" | "sessionCount">,
): number | null {
  return bucket.sessionCount > 0 ? bucket.totalDurationMs / bucket.sessionCount : null;
}

/** One cadence-panel bar: session count (+ compact turns/avg-duration sublabel data), height relative to the window's busiest day. */
export interface CadenceBar {
  date: string;
  sessionCount: number;
  userTurnCount: number;
  avgDurationMs: number | null;
  /** 0–100, this day's session count as a percentage of the window's busiest day (0 when every day is empty). */
  heightPct: number;
}

/** Shapes `buckets` into render-ready cadence bars — mirrors `repoOverviewHelpers.ts`'s `dayBars`, but by session count rather than cost. */
export function cadenceBars(buckets: readonly TrendBucket[]): CadenceBar[] {
  const maxSessions = Math.max(0, ...buckets.map((b) => b.sessionCount));
  return buckets.map((b) => ({
    date: b.date,
    sessionCount: b.sessionCount,
    userTurnCount: b.userTurnCount,
    avgDurationMs: avgDurationMs(b),
    heightPct: maxSessions > 0 ? (b.sessionCount / maxSessions) * 100 : 0,
  }));
}

// ---------------------------------------------------------------------------
// Spike-day lookup (daily cost chart markers)
// ---------------------------------------------------------------------------

/** Indexes `anomalies.spikeDays` by date for O(1) per-column lookup while rendering the daily cost chart. */
export function spikeDayLookup(spikeDays: readonly TrendSpikeDay[]): Map<string, TrendSpikeDay> {
  return new Map(spikeDays.map((s) => [s.date, s]));
}

// ---------------------------------------------------------------------------
// Sparse x-axis date labels (DailyCostChart / DelegationSplitChart)
// ---------------------------------------------------------------------------

/**
 * Short "Jul 9" label for a `YYYY-MM-DD` LOCAL calendar day. Parses the key
 * as a local date (not UTC) since `date` is already a local calendar-day key
 * — see `TrendBucket.date`'s doc comment. Shared by every Trends chart that
 * shows a date axis (`CadencePanel.tsx`, `DailyCostChart.tsx`,
 * `DelegationSplitChart.tsx`) rather than re-derived per component.
 */
export function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y + m + d)) {
    return dateKey;
  }
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Indices (into a `count`-length buckets array) to show an x-axis date label
 * at — always the first and last, plus up to `maxLabels - 2` more, evenly
 * spaced between them. Deliberately SPARSE (unlike `CadencePanel.tsx`'s own
 * cadence bars, which label every single day under wider 22px-max bars):
 * `DailyCostChart`/`DelegationSplitChart` columns are narrower (16px max,
 * see `MAX_STACK_PX`'s sibling `.scol` rule), so labeling all 30 columns of
 * the widest window would overlap illegibly — this instead guarantees the
 * window's start/end are always readable, with a handful of in-between
 * anchors.
 */
export function sparseAxisIndices(count: number, maxLabels = 6): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (maxLabels - 1);
  const indices = new Set<number>();
  for (let i = 0; i < maxLabels; i++) {
    indices.add(Math.round(i * step));
  }
  return [...indices].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Daily cost-by-model stacked chart geometry
// ---------------------------------------------------------------------------

/**
 * Distinct models across every bucket, ordered by their TOTAL cost across
 * the whole window (descending) — a single window-wide stacking/legend order
 * so a model's color and stack position stay consistent across every day's
 * column instead of being re-sorted per day.
 */
export function modelStackOrder(buckets: readonly TrendBucket[]): string[] {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const m of bucket.byModel) {
      totals.set(m.model, (totals.get(m.model) ?? 0) + (m.costUsd ?? 0));
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
}

/**
 * Pixel scale shared by every `.stk`/`.scol`/`.sseg` stacked-bar chart in the
 * app (see `contextCost/timelineLayout.ts`'s identical `MAX_STACK_PX`/
 * `MIN_SEGMENT_PX`, which this mirrors for the same reason: `.scol` carries
 * no explicit CSS height — it sizes to its `.sseg` children's own heights via
 * `align-items: flex-end` on `.stk` — so a PERCENTAGE height on `.sseg` would
 * resolve against an `auto`-height containing block and collapse to nothing.
 * Only an absolute unit (px) actually renders, hence every segment height in
 * this module is px, not a 0–100 percentage like `cadenceBars`' single-level
 * `.rob-bar` reuse (whose containing block DOES have an explicit CSS height).
 */
const MAX_STACK_PX = 110;
const MIN_SEGMENT_PX = 1;

export interface DailyModelSegment {
  model: string;
  costUsd: number;
  /** Px height within the shared `MAX_STACK_PX` scale — see this module's doc comment on why px, not a percentage. */
  heightPx: number;
}

/**
 * One day's stacked segments, in `order` (see `modelStackOrder`), each
 * scaled against `maxCost` (the window's costliest single day) so every
 * column shares one y-axis. Zero-cost models are dropped — a 0px segment
 * would still occupy a legend swatch slot were it kept, and (unlike a bar's
 * total) contributes nothing visually to a stack. Any priced (>0) segment
 * gets at least `MIN_SEGMENT_PX` so it stays visible even when tiny relative
 * to the window's costliest day.
 */
export function dailyModelSegments(
  bucket: TrendBucket,
  order: readonly string[],
  maxCost: number,
): DailyModelSegment[] {
  const scale = maxCost > 0 ? MAX_STACK_PX / maxCost : 0;
  const byModel = new Map(bucket.byModel.map((m) => [m.model, m.costUsd ?? 0]));
  return order
    .map((model) => ({ model, costUsd: byModel.get(model) ?? 0 }))
    .filter((s) => s.costUsd > 0)
    .map((s) => ({ ...s, heightPx: Math.max(MIN_SEGMENT_PX, s.costUsd * scale) }));
}

/** The window's costliest single day, across every bucket — the shared y-axis scale for the daily cost chart. */
export function windowMaxCost(buckets: readonly TrendBucket[]): number {
  return Math.max(0, ...buckets.map((b) => b.totalCostUsd));
}

// ---------------------------------------------------------------------------
// Delegation split (main vs subagents) chart geometry
// ---------------------------------------------------------------------------

export interface DelegationSplitHeights {
  /** undefined when this day's main-scope cost is unpriced (some usage that day has no known pricing) — the bar renders no main segment rather than guessing. */
  mainCostUsd?: number;
  /** undefined under the same "unpriced" condition as `mainCostUsd`, for the subagents scope. */
  subCostUsd?: number;
  /** Px heights within the shared `MAX_STACK_PX` scale — see the module doc comment above `dailyModelSegments`. */
  mainHeightPx: number;
  subHeightPx: number;
  /** True when either scope's cost is unpriced this day — the chart marks such a column instead of silently under-drawing it. */
  unpriced: boolean;
}

/** One day's main/subagent stacked-split heights, scaled against `maxCost` (see `windowMaxCost`). Unpriced scopes (`costUsd === undefined`) draw as an absent (0px) segment rather than a guessed one — see `DelegationSplitHeights.unpriced`. */
export function delegationSplitHeights(
  bucket: TrendBucket,
  maxCost: number,
): DelegationSplitHeights {
  const scale = maxCost > 0 ? MAX_STACK_PX / maxCost : 0;
  const mainCostUsd = bucket.delegation.main.costUsd;
  const subCostUsd = bucket.delegation.subagents.costUsd;
  const px = (v: number | undefined) =>
    v !== undefined && v > 0 ? Math.max(MIN_SEGMENT_PX, v * scale) : 0;
  return {
    ...(mainCostUsd !== undefined && { mainCostUsd }),
    ...(subCostUsd !== undefined && { subCostUsd }),
    mainHeightPx: px(mainCostUsd),
    subHeightPx: px(subCostUsd),
    unpriced: mainCostUsd === undefined || subCostUsd === undefined,
  };
}

// ---------------------------------------------------------------------------
// Efficiency small-multiples sparkline geometry
// ---------------------------------------------------------------------------

export interface SparklinePoint {
  x: number;
  y: number;
  index: number;
  value: number;
}

export interface SparklineGeometry {
  /** One array per contiguous run of non-null values — a null breaks the polyline into a new segment instead of interpolating across the gap (see the option's doc comment: "null gaps skipped not drawn as 0"). */
  segments: SparklinePoint[][];
  min: number;
  max: number;
  /** Pixel y-range for an optional reference band (see `opts.referenceBand`) — present only when one was passed in AND the resulting span is positive (an all-null series with no `domain` override has nothing to scale a band against). */
  referenceBandY?: { top: number; bottom: number };
}

export interface SparklineGeometryOptions {
  /**
   * Overrides the auto (min/max-of-the-data) y-domain entirely — e.g. a
   * fixed `{min: 0, max: 1}` for a 0..1 RATE series (cache hit rate) so a
   * stable near-ceiling run (say, steady 95–98%) renders as the flat,
   * healthy line it actually is instead of auto-scaling that narrow band to
   * fill the whole sparkline height and reading as a wild, meaningless
   * cliff. When both `domain` and `referenceBand` are given, `domain` alone
   * decides the y-scale (see `referenceBand`'s own doc comment).
   */
  domain?: { min: number; max: number };
  /**
   * A value range to render as a shaded reference band (e.g. the 1–2k-token
   * subagent-return benchmark zone, docs/concept.md §4.6) — the band is
   * always drawn (see `SparklineGeometry.referenceBandY`) against whatever
   * y-scale is in effect. When no `domain` override is given, this ALSO
   * extends (never shrinks) the auto data-derived y-domain so the band stays
   * at least partly visible even when every actual data point falls outside
   * it; when `domain` IS given, the domain is authoritative and the band
   * merely draws at its position within that fixed scale, no longer able to
   * widen it.
   */
  referenceBand?: { min: number; max: number };
}

/**
 * Builds sparkline geometry for a `(number | null)[]` series over a
 * `width`×`height` viewBox — x is evenly spaced by index over the FULL
 * series length (including nulls), so a gap's horizontal position stays
 * meaningful relative to its neighbors; y is normalized over the domain
 * `opts.domain` selects (see its doc comment for the auto/fixed/reference-
 * band-extended cases) — a flat/empty series centers on the vertical
 * mid-line rather than dividing by zero.
 */
export function sparklineGeometry(
  values: readonly (number | null)[],
  width: number,
  height: number,
  opts: SparklineGeometryOptions = {},
): SparklineGeometry {
  const defined = values.filter((v): v is number => v !== null);
  const dataMin = defined.length > 0 ? Math.min(...defined) : 0;
  const dataMax = defined.length > 0 ? Math.max(...defined) : 1;
  const { min, max } =
    opts.domain !== undefined
      ? opts.domain
      : opts.referenceBand !== undefined
        ? {
            min: Math.min(dataMin, opts.referenceBand.min),
            max: Math.max(dataMax, opts.referenceBand.max),
          }
        : { min: dataMin, max: dataMax };
  const span = max - min;
  const n = values.length;
  const xFor = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const yFor = (v: number) => (span <= 0 ? height / 2 : height - ((v - min) / span) * height);

  const segments: SparklinePoint[][] = [];
  let current: SparklinePoint[] = [];
  values.forEach((v, index) => {
    if (v === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: xFor(index), y: yFor(v), index, value: v });
  });
  if (current.length > 0) segments.push(current);

  return {
    segments,
    min,
    max,
    ...(opts.referenceBand !== undefined &&
      span > 0 && {
        referenceBandY: { top: yFor(opts.referenceBand.max), bottom: yFor(opts.referenceBand.min) },
      }),
  };
}

/** SVG polyline `points` attribute for one sparkline segment. */
export function sparklinePointsAttr(segment: readonly SparklinePoint[]): string {
  return segment.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}
