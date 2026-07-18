import type { TrendBucket, TrendSpikeDay } from "@junrei/core";
import { Link } from "react-router";
import { formatUsd } from "../format.js";
import { classifyModel, modelShortLabel } from "../modelClass.js";
import { sessionListDayFilterPath } from "../router.js";
import {
  dailyModelSegments,
  formatDayLabel,
  modelStackOrder,
  sparseAxisIndices,
  spikeDayLookup,
  windowMaxCost,
} from "./trendsLayout.js";

interface Props {
  buckets: readonly TrendBucket[];
  spikeDays: readonly TrendSpikeDay[];
  /** Active `?repo=` filter (the `ALL_REPOS` sentinel or a real key) — carried into each column's session-list drill-down link, see `router.ts`'s `sessionListDayFilterPath`. */
  repoFilter: string;
}

/**
 * Daily cost stacked by model (Trends screen spec item 4) — reuses the same
 * `.stk`/`.scol`/`.sseg` stacked-column shell as `TurnCompositionChart`
 * (Context & cost lens), just keyed by day instead of by turn, and colored
 * by `classifyModel`'s `.c-<class>` accents (same palette `ModelMixBar`/
 * `CostByModelChart` already use) instead of the fixed cache-composition
 * legend. Native `title` tooltips per column — matching every other BAR
 * chart's tooltip convention in this app (`OverviewBand`'s `.rob-bar`,
 * `TurnCompositionChart`'s own `.scol`); the fancier mouse-tracked overlay
 * tooltip is reserved for the one LINE chart (`ContextGrowthChart`).
 *
 * Each column is a `<Link>` into the session list filtered to exactly that
 * local calendar day (`sessionListDayFilterPath`, carrying `repoFilter`
 * along) — the drill-down a raw column of numbers can't answer on its own
 * ("which sessions actually made up this day's cost?").
 */
export function DailyCostChart({ buckets, spikeDays, repoFilter }: Props) {
  const hasCost = buckets.some((b) => b.totalCostUsd > 0);
  const order = modelStackOrder(buckets);
  const maxCost = windowMaxCost(buckets);
  const spikeByDate = spikeDayLookup(spikeDays);
  const labelIndices = new Set(sparseAxisIndices(buckets.length));

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "18px 20px" }}>
        <div className="chartcap">
          <span className="lbl">Daily cost by model</span>
          <span className="fx ac gap12" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
            {hasCost && (
              <span className="mono fs10 mut" title="Costliest single day in this window">
                peak {formatUsd(maxCost)}
              </span>
            )}
            {order.map((model) => (
              <span key={model} className="lg" title={model}>
                <span className={`lgs c-${classifyModel(model)}`} />
                {modelShortLabel(model)}
              </span>
            ))}
          </span>
        </div>
        {!hasCost ? (
          <p className="mut fs12">No priced sessions in this window.</p>
        ) : (
          <>
            <div className="stk">
              {buckets.map((b) => {
                const segments = dailyModelSegments(b, order, maxCost);
                const spike = spikeByDate.get(b.date);
                const title =
                  spike === undefined
                    ? `${b.date} · ${formatUsd(b.totalCostUsd)}`
                    : `${b.date} · ${formatUsd(b.totalCostUsd)} · ⚠ spike vs mean ${formatUsd(spike.mean)} (σ ${formatUsd(spike.stddev)})`;
                return (
                  <Link
                    key={b.date}
                    className={spike === undefined ? "scol" : "scol scol-spike"}
                    title={title}
                    to={sessionListDayFilterPath(b.date, repoFilter)}
                  >
                    {segments.map((s) => (
                      <span
                        key={s.model}
                        className={`sseg c-${classifyModel(s.model)}`}
                        style={{ height: `${String(s.heightPx)}px` }}
                      />
                    ))}
                  </Link>
                );
              })}
            </div>
            <div className="fx" style={{ gap: "2px", marginTop: "4px" }}>
              {buckets.map((b, i) => (
                <span
                  key={b.date}
                  className="mono fs10 mut"
                  style={{ flex: 1, textAlign: "center", maxWidth: "16px" }}
                >
                  {labelIndices.has(i) ? formatDayLabel(b.date) : ""}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
