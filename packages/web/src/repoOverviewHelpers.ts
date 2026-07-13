import type { RepoOverview, SessionListItem } from "./api.js";
import { modelShortLabel } from "./modelClass.js";

/**
 * The subset of `RepoOverview` the session-list band actually renders —
 * reusing the server response's field shapes (`byModel`/`perDay`/
 * `delegation`) so `topModelShare`/`dayBars`/`formatDelegatedShare` accept
 * either origin. `topSessions`/token totals are omitted: the band never
 * showed them.
 */
export interface FilteredOverview {
  sessionCount: number;
  sourceCounts: Record<SessionListItem["source"], number>;
  totalCostUsd: number;
  /** AND of every item's own `costIsComplete` — false if ANY has unpriced usage. */
  costIsComplete: boolean;
  /** Merged across every item, cost-descending. */
  byModel: RepoOverview["byModel"];
  /** Bucketed by `startedAt`'s UTC calendar day; items with no `startedAt` count in the totals but have no day to bucket under. */
  perDay: RepoOverview["perDay"];
  delegation: RepoOverview["delegation"];
}

/** UTC calendar day (`YYYY-MM-DD`) for an ISO timestamp, or undefined for an unparseable one. */
function utcDateKey(iso: string): string | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

/** Add `delta` to an optional running total, propagating undefined once any input is undefined (unpriced) — mirrors how `costIsComplete` propagates through a sum. */
function sumOptional(running: number | undefined, delta: number | undefined): number | undefined {
  return running === undefined || delta === undefined ? undefined : running + delta;
}

/**
 * Aggregates the session-list rows the active filters left visible into the
 * band's rollup — computed CLIENT-side over the already-fetched list items
 * so the band reflects exactly what the table below it shows (repo ∩ date ∩
 * title search), unlike `GET /api/overview`, which is a repo-scoped all-time
 * rollup with no notion of the UI's filters (it remains the MCP/API
 * surface — see `getRepoOverview` in `@junrei/server`'s overview.ts). Keep
 * the aggregation semantics (unpriced-cost propagation, UTC day bucketing,
 * per-model merge) in lockstep with `computeRepoOverview` there.
 */
export function computeFilteredOverview(items: readonly SessionListItem[]): FilteredOverview {
  const sourceCounts: Record<SessionListItem["source"], number> = { "claude-code": 0, codex: 0 };
  let totalCostUsd = 0;
  let costIsComplete = true;
  const perDay = new Map<string, { costUsd: number; sessionCount: number }>();
  const byModel = new Map<string, FilteredOverview["byModel"][number]>();
  let mainTokens = 0;
  let subagentTokens = 0;
  let mainCost: number | undefined = 0;
  let subagentCost: number | undefined = 0;

  for (const item of items) {
    sourceCounts[item.source] += 1;
    totalCostUsd += item.totalCostUsd;
    if (!item.costIsComplete) costIsComplete = false;

    if (item.startedAt !== undefined) {
      const day = utcDateKey(item.startedAt);
      if (day !== undefined) {
        const bucket = perDay.get(day) ?? { costUsd: 0, sessionCount: 0 };
        bucket.costUsd += item.totalCostUsd;
        bucket.sessionCount += 1;
        perDay.set(day, bucket);
      }
    }

    for (const model of item.usageByModel) {
      const entry = byModel.get(model.model) ?? {
        model: model.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      entry.inputTokens += model.inputTokens;
      entry.outputTokens += model.outputTokens;
      entry.cacheReadTokens += model.cacheReadTokens;
      entry.cacheCreationTokens += model.cacheCreationTokens;
      if (model.costUsd !== undefined) entry.costUsd = (entry.costUsd ?? 0) + model.costUsd;
      byModel.set(model.model, entry);
    }

    mainTokens += item.delegation.main.tokens;
    subagentTokens += item.delegation.subagents.tokens;
    mainCost = sumOptional(mainCost, item.delegation.main.costUsd);
    subagentCost = sumOptional(subagentCost, item.delegation.subagents.costUsd);
  }

  return {
    sessionCount: items.length,
    sourceCounts,
    totalCostUsd,
    costIsComplete,
    byModel: [...byModel.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    perDay: [...perDay.entries()]
      .map(([date, bucket]) => ({
        date,
        costUsd: bucket.costUsd,
        sessionCount: bucket.sessionCount,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    delegation: {
      main: { tokens: mainTokens, ...(mainCost !== undefined && { costUsd: mainCost }) },
      subagents: {
        tokens: subagentTokens,
        ...(subagentCost !== undefined && { costUsd: subagentCost }),
      },
    },
  };
}

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
