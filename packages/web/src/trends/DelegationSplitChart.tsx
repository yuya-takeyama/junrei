import type { TrendBucket } from "@junrei/core";
import { formatUsd } from "../format.js";
import {
  delegationSplitHeights,
  formatDayLabel,
  sparseAxisIndices,
  windowMaxCost,
} from "./trendsLayout.js";

interface Props {
  buckets: readonly TrendBucket[];
}

/** One column's tooltip — "unpriced" is called out explicitly (spec item 5: "handle undefined costUsd as unpriced gracefully") rather than letting a missing scope silently read as $0. */
function columnTitle(
  bucket: TrendBucket,
  heights: ReturnType<typeof delegationSplitHeights>,
): string {
  const main = heights.mainCostUsd !== undefined ? formatUsd(heights.mainCostUsd) : "unpriced";
  const sub = heights.subCostUsd !== undefined ? formatUsd(heights.subCostUsd) : "unpriced";
  const note = heights.unpriced ? " · some usage this day has no known pricing" : "";
  return `${bucket.date} · main ${main} · subagents ${sub}${note}`;
}

/**
 * Main-vs-subagents daily cost split (Trends screen spec item 5) — same
 * `.stk`/`.scol`/`.sseg` stacked-column shell as `DailyCostChart`, two fixed
 * segments per day instead of a per-model set. Main uses `.k-main` (muted —
 * the "baseline" scope), subagents `.k-sub` — a plain identity color (`--s`,
 * the same accent `modelClass.ts` uses for the Sonnet model family, reused
 * here as a generic "this is the other scope" tone), deliberately NOT amber:
 * the mission WANTS work delegated to subagents, so painting that scope in
 * the app's "cost worth noticing"/warning color (`.amb`, `--amb`) would read
 * as a judgment docs/concept.md §4.6 explicitly rules out ("numbers, never
 * grades").
 */
export function DelegationSplitChart({ buckets }: Props) {
  const hasCost = buckets.some((b) => b.totalCostUsd > 0);
  const maxCost = windowMaxCost(buckets);
  const labelIndices = new Set(sparseAxisIndices(buckets.length));

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "18px 20px" }}>
        <div className="chartcap">
          <span className="lbl">Delegation split · main vs subagents</span>
          <span className="fx ac gap12">
            {hasCost && (
              <span className="mono fs10 mut" title="Costliest single day in this window">
                peak {formatUsd(maxCost)}
              </span>
            )}
            <span className="lg">
              <span className="lgs k-main" />
              main
            </span>
            <span className="lg">
              <span className="lgs k-sub" />
              subagents
            </span>
          </span>
        </div>
        {!hasCost ? (
          <p className="mut fs12">No priced sessions in this window.</p>
        ) : (
          <>
            <div className="stk">
              {buckets.map((b) => {
                const heights = delegationSplitHeights(b, maxCost);
                return (
                  <div key={b.date} className="scol" title={columnTitle(b, heights)}>
                    {/* `.scol` is `flex-direction: column-reverse` (see styles.css) — the
                        FIRST child renders at the bottom of the stack, so main (the
                        baseline scope) is listed before subagents (stacked on top). */}
                    <span
                      className="sseg k-main"
                      style={{ height: `${String(heights.mainHeightPx)}px` }}
                    />
                    <span
                      className="sseg k-sub"
                      style={{ height: `${String(heights.subHeightPx)}px` }}
                    />
                  </div>
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
