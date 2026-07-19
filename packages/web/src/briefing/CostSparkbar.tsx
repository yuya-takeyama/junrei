import type { Briefing } from "../api.js";
import { formatUsd } from "../format.js";
import { costBars } from "./briefingFormat.js";

/**
 * Footer sparkbar — the briefing window's per-day cost series
 * (`briefing.dailyCosts`, added to `@junrei/core`'s `buildBriefing` in PR3),
 * salvaging the OverviewBand/DailyCostChart relative-height bar vocabulary
 * (`.spark`/`.bar`). The latest day is tinted amber ("today"); the caption
 * reads "last N days" from the series length rather than hardcoding a span the
 * window never covered. Bars floor to a visible sliver so a $0 day still reads
 * as a column.
 */
export function CostSparkbar({ briefing }: { briefing: Briefing }) {
  const bars = costBars(briefing.dailyCosts);
  if (bars.length === 0) return null;
  const today = bars.at(-1);

  return (
    <div className="sparkwrap">
      <div className="spark-cap">
        <span className="lbl">last {bars.length}-day cost</span>
        <span className="mono fs12">
          today <span className="amb">{today !== undefined ? formatUsd(today.costUsd) : "—"}</span>{" "}
          · window {formatUsd(briefing.summary.costUsd)}
        </span>
      </div>
      <div className="spark" aria-hidden="true">
        {bars.map((bar) => (
          <div
            key={bar.date}
            className={bar.isLast ? "spark-bar today" : "spark-bar"}
            style={{ height: `${String(Math.max(bar.heightPct, bar.costUsd > 0 ? 6 : 2))}%` }}
            title={`${bar.date} · ${formatUsd(bar.costUsd)}`}
          />
        ))}
      </div>
    </div>
  );
}
