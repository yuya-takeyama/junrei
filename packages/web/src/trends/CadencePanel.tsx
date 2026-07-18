import type { TrendBucket } from "@junrei/core";
import { formatDuration } from "../format.js";
import { cadenceBars, formatDayLabel } from "./trendsLayout.js";

interface Props {
  buckets: readonly TrendBucket[];
}

/**
 * Sessions/day cadence panel (Trends screen spec item 7) — reuses
 * `OverviewBand`'s `.rob-days`/`.rob-bar` bar strip verbatim (a single-value
 * bar per day, height relative to the window's busiest day), with turns and
 * average session duration folded into each bar's tooltip rather than drawn
 * as their own columns — "compactly", per the option's spec wording.
 */
export function CadencePanel({ buckets }: Props) {
  const bars = cadenceBars(buckets);
  const hasSessions = bars.some((b) => b.sessionCount > 0);

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "18px 20px" }}>
        <div className="chartcap">
          <span className="lbl">Cadence · sessions per day</span>
        </div>
        {!hasSessions ? (
          <p className="mut fs12">No sessions in this window.</p>
        ) : (
          <>
            <div className="rob-days">
              {bars.map((bar) => (
                <div
                  key={bar.date}
                  className="rob-bar"
                  style={{
                    height: `${String(Math.max(bar.heightPct, bar.sessionCount > 0 ? 4 : 1))}%`,
                  }}
                  title={
                    `${formatDayLabel(bar.date)} · ${String(bar.sessionCount)} session${bar.sessionCount === 1 ? "" : "s"}` +
                    ` · ${String(bar.userTurnCount)} turn${bar.userTurnCount === 1 ? "" : "s"}` +
                    (bar.avgDurationMs !== null
                      ? ` · avg ${formatDuration(bar.avgDurationMs)}`
                      : "")
                  }
                />
              ))}
            </div>
            <div className="fx" style={{ gap: "5px", marginTop: "4px" }}>
              {bars.map((bar) => (
                <span
                  key={bar.date}
                  className="mono fs10 mut"
                  style={{ flex: 1, textAlign: "center", maxWidth: "22px" }}
                >
                  {formatDayLabel(bar.date)}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
