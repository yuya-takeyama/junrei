/**
 * Delta/rate formatting for the Trends screen's KPI tiles (`TrendsKpiRow.tsx`)
 * — split out from the component so the null-safety rules are independently
 * testable, same reasoning as `format.ts`'s plain formatters.
 *
 * Deliberately NO good/bad tone here (an earlier version had a `deltaTone`
 * helper that colored, say, a cost increase "bad" and a cache-hit-rate
 * increase "good") — docs/concept.md §4.6 is explicit: "Numbers, never
 * grades. No scores, no red/green judgment." Every delta below renders as
 * plain signed text in the tile's default muted color, full stop; see
 * `TrendsKpiRow.tsx`.
 */

/** "+12.3%" / "-4.0%" / "—" (no previous window to compare against). */
export function formatDeltaPct(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** "+3.2pts" / "-1.0pts" / "—" — for the already-percentage-point delta fields (`cacheHitRatePts`/`subagentCostSharePts`). */
export function formatDeltaPts(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}pts`;
}

/** "62%" / "—" — a 0..1 rate that may be entirely absent (no effective-input volume / no cost at all that window), distinct from a real 0%. */
export function formatRatePct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}
