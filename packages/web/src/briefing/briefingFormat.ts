import type { BriefingDailyCost } from "@junrei/core";

/**
 * Pure display helpers for the Briefing home. Every value they format arrives
 * pre-computed on `GET /api/briefing` (see `@junrei/core`'s `buildBriefing`) —
 * these ONLY format for display (percent rounding, delta arrows, relative bar
 * heights); they never re-derive a KPI from raw session data (concept G5: the
 * KPI strip shows server numbers only). Kept pure/separate so the formatting
 * and the sparkbar layout are testable without mounting React.
 */

/** A 0-1 fraction as an integer percent (`96%`), or an em dash when the server had no denominator (`null`). */
export function formatRate(fraction: number | null): string {
  return fraction === null ? "—" : `${String(Math.round(fraction * 100))}%`;
}

/**
 * A previous-window PERCENT delta (already a percent number server-side, e.g.
 * `-25` = down 25%) as a signed, arrow-prefixed string — `↓25%` / `↑12%` /
 * `→0%`. `null` (no comparable previous window) formats as an em dash. No
 * good/bad tone is implied: this is a magnitude and a direction, never a grade
 * (concept §4.6 "numbers, never grades") — the caller renders it muted.
 */
export function formatDeltaPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${arrowFor(pct)}${String(Math.abs(Math.round(pct * 10) / 10))}%`;
}

/** Same as `formatDeltaPct` but for a POINTS delta (cache hit / delegation share) — `↑10pts`. */
export function formatDeltaPts(pts: number | null): string {
  if (pts === null) return "—";
  return `${arrowFor(pts)}${String(Math.abs(Math.round(pts * 10) / 10))}pts`;
}

function arrowFor(n: number): string {
  if (n > 0) return "↑";
  if (n < 0) return "↓";
  return "→";
}

/** One render-ready sparkbar column — its height relative to the window's costliest day, and whether it's the latest (today) bar. */
export interface CostBar {
  date: string;
  costUsd: number;
  /** 0-100, this day's cost as a percentage of the window's costliest day (0 when every day is $0). */
  heightPct: number;
  /** True for the last (most recent) bar — the footer sparkbar tints it amber as "today". */
  isLast: boolean;
}

/**
 * Shape a briefing's `dailyCosts` series into relative-height bars for the
 * footer sparkbar — pure so the max-relative scaling is testable without a
 * DOM. Heights are a fraction of the window's costliest day (matching the old
 * OverviewBand/DailyCostChart convention); an all-zero window yields all-zero
 * heights (the caller floors them to a visible sliver).
 */
export function costBars(dailyCosts: readonly BriefingDailyCost[]): CostBar[] {
  const maxCost = Math.max(0, ...dailyCosts.map((d) => d.costUsd));
  const lastIndex = dailyCosts.length - 1;
  return dailyCosts.map((d, i) => ({
    date: d.date,
    costUsd: d.costUsd,
    heightPct: maxCost > 0 ? (d.costUsd / maxCost) * 100 : 0,
    isLast: i === lastIndex,
  }));
}
