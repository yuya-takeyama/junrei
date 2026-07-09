import type { RepoOverview } from "./api.js";
import { modelShortLabel } from "./modelClass.js";

/** Top-by-cost model in a repo overview's merged `byModel` list, plus its share of the overview's total cost. */
export interface TopModelShare {
  model: string;
  shortLabel: string;
  costUsd: number;
  pct: number;
}

/**
 * Picks the costliest priced model out of `overview.byModel` (already
 * cost-descending server-side, but this doesn't rely on that ordering) and
 * its share of `overview.totalCostUsd` — undefined when there's no priced
 * usage at all (every model unpriced, or no usage whatsoever), so the caller
 * can fall back to an em dash instead of showing a bogus 0%.
 */
export function topModelShare(
  overview: Pick<RepoOverview, "byModel" | "totalCostUsd">,
): TopModelShare | undefined {
  const top = overview.byModel.reduce<RepoOverview["byModel"][number] | undefined>((best, m) => {
    if (m.costUsd === undefined) return best;
    return best === undefined || m.costUsd > (best.costUsd ?? 0) ? m : best;
  }, undefined);
  if (top?.costUsd === undefined) return undefined;
  const pct =
    overview.totalCostUsd > 0 ? Math.round((top.costUsd / overview.totalCostUsd) * 100) : 0;
  return { model: top.model, shortLabel: modelShortLabel(top.model), costUsd: top.costUsd, pct };
}

/** One day's bar height (relative to the costliest day in the window) for the repo-overview band's per-day strip. */
export interface DayBar {
  date: string;
  costUsd: number;
  sessionCount: number;
  /** 0–100, this day's cost as a percentage of the window's costliest day (0 when every day is $0). */
  heightPct: number;
}

/**
 * Shapes `overview.perDay` into render-ready bars — pure so the height
 * calculation (relative to the window max, not an absolute scale) is
 * testable without mounting anything.
 */
export function dayBars(perDay: readonly RepoOverview["perDay"][number][]): DayBar[] {
  const maxCost = Math.max(0, ...perDay.map((d) => d.costUsd));
  return perDay.map((d) => ({
    date: d.date,
    costUsd: d.costUsd,
    sessionCount: d.sessionCount,
    heightPct: maxCost > 0 ? (d.costUsd / maxCost) * 100 : 0,
  }));
}

/** Short "Jul 9" label for a `YYYY-MM-DD` UTC date key — used instead of `formatDateTime` (format.ts) since that formats a full ISO timestamp in the viewer's local zone, and this band is explicitly UTC-labeled (see `RepoOverview.perDay`'s doc comment). */
export function formatUtcDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y + m + d)) {
    return dateKey;
  }
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
