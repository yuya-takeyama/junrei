import type { TrendDelta, TrendWindowTotals } from "@junrei/core";
import { formatUsd } from "../format.js";
import { formatDeltaPct, formatDeltaPts, formatRatePct } from "./trendsFormat.js";

interface Props {
  current: TrendWindowTotals;
  /** null when the equal-length window before this one had zero matching sessions — every delta below renders "—" in that case. */
  delta: TrendDelta | null;
  windowDays: number;
}

/** One KPI tile — reuses `OverviewBand`'s `.rob-cell` shape (an aggregate, non-navigable stat, unlike `StatStrip`'s clickable `.b-cell`). Only the cost tile carries `.amb` (matching `OverviewBand`'s own "Total cost" tile) — the others render in the tile's plain `.big` weight. The delta always renders in the tile's plain `.sub` (muted) color — no good/bad tone, per docs/concept.md §4.6 ("numbers, never grades"). */
function KpiCell({
  label,
  big,
  amber = false,
  deltaText,
  sub,
}: {
  label: string;
  big: string;
  amber?: boolean;
  deltaText: string;
  sub: string;
}) {
  return (
    <div className="rob-cell">
      <div className="lbl">{label}</div>
      <div className={amber ? "big mt8 amb" : "big mt8"}>{big}</div>
      <div className="sub num">
        {deltaText} <span className="mut">{sub}</span>
      </div>
    </div>
  );
}

/**
 * Window-totals + delta-vs-previous-window KPI row (Trends screen spec item
 * 3) — total cost, sessions, cache hit rate, subagent cost share. Every
 * value and delta is null-safe (see each field's producing formula in
 * `@junrei/core`'s `trends.ts`). No directional (good/bad) coloring on any
 * delta — an earlier version colored e.g. a cost increase "bad", but
 * docs/concept.md §4.6 rules that out explicitly ("Numbers, never grades. No
 * scores, no red/green judgment."); every delta is plain signed text.
 */
export function TrendsKpiRow({ current, delta, windowDays }: Props) {
  const priorLabel = `vs prior ${String(windowDays)}d`;
  const tiles: Array<{
    label: string;
    big: string;
    amber: boolean;
    deltaValue: number | null;
    format: (v: number | null) => string;
  }> = [
    {
      label: "Total cost",
      big: formatUsd(current.totalCostUsd),
      amber: true,
      deltaValue: delta?.totalCostUsdPct ?? null,
      format: formatDeltaPct,
    },
    {
      label: "Sessions",
      big: String(current.sessionCount),
      amber: false,
      deltaValue: delta?.sessionCountPct ?? null,
      format: formatDeltaPct,
    },
    {
      label: "Cache hit rate",
      big: formatRatePct(current.cacheHitRate),
      amber: false,
      deltaValue: delta?.cacheHitRatePts ?? null,
      format: formatDeltaPts,
    },
    {
      label: "Subagent cost share",
      big: formatRatePct(current.subagentCostShare),
      amber: false,
      deltaValue: delta?.subagentCostSharePts ?? null,
      format: formatDeltaPts,
    },
  ];

  return (
    <div className="rob-strip">
      {tiles.map((t) => (
        <KpiCell
          key={t.label}
          label={t.label}
          big={t.big}
          amber={t.amber}
          deltaText={t.format(t.deltaValue)}
          sub={priorLabel}
        />
      ))}
    </div>
  );
}
