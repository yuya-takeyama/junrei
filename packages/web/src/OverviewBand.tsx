import { useMemo } from "react";
import type { SessionListItem } from "./api.js";
import { formatDelegatedShare, formatUsd } from "./format.js";
import {
  computeFilteredOverview,
  dayBars,
  formatUtcDayLabel,
  topModelShare,
} from "./repoOverviewHelpers.js";

interface Props {
  /**
   * The rows every active filter left visible (repo ∩ date ∩ title search) —
   * the same array the table below the band renders from. The list always
   * fetches the whole listable window (bounded server-side by the date
   * filter, see `dateFilterFetchBounds`/`LIST_WINDOW_LIMIT`), so these rows
   * are the complete filtered set, not one page.
   */
  sessions: readonly SessionListItem[];
}

/**
 * Aggregate band for the session list (L0), shown between the filter bar and
 * the table for every list view now — no repo needs to be selected. With the
 * default last-7-days date filter this reads as "this week at a glance";
 * narrowing by repo/date/search narrows the band the same way it narrows the
 * table below it. Dogfooding showed this was the top capability gap: reading
 * a repo's total cost, fable-vs-sonnet split, and per-day trend all required
 * client-side jq, with no in-app equivalent.
 *
 * Computed client-side from the already-fetched filtered rows (see
 * `computeFilteredOverview`) rather than fetched from `GET /api/overview`:
 * the server rollup is repo-scoped but ALL-TIME, so it silently ignored the
 * date filter and title search — a June-only range still showed the repo's
 * full history. Deriving from the table's own rows makes disagreement with
 * the table structurally impossible, and drops a fetch (plus its
 * silent-failure path) besides.
 */
export function OverviewBand({ sessions }: Props) {
  const overview = useMemo(() => computeFilteredOverview(sessions), [sessions]);

  const delegatedShare = formatDelegatedShare(overview.delegation);
  const topModel = topModelShare(overview);
  const bars = dayBars(overview.perDay);

  return (
    <div className="rob-strip">
      <div className="rob-cell">
        <div className="lbl">Total cost</div>
        <div className="big mt8 amb">
          {formatUsd(overview.totalCostUsd)}
          {!overview.costIsComplete && "*"}
        </div>
        <div className="sub">
          {overview.sessionCount} session{overview.sessionCount === 1 ? "" : "s"}
          {!overview.costIsComplete && (
            <span className="mut" title="some usage in this repo has no known pricing">
              {" "}
              · incomplete
            </span>
          )}
        </div>
      </div>
      <div className="rob-cell">
        <div className="lbl">Sessions</div>
        <div className="big mt8">{overview.sessionCount}</div>
        <div className="sub">
          {overview.sourceCounts["claude-code"]} Claude · {overview.sourceCounts.codex} Codex
        </div>
      </div>
      <div className="rob-cell">
        <div className="lbl">Delegated</div>
        <div className="big mt8">{formatUsd(overview.delegation.subagents.costUsd ?? 0)}</div>
        <div className="sub">{delegatedShare ?? "no delegation"}</div>
      </div>
      <div className="rob-cell">
        <div className="lbl">Top model</div>
        <div className="big mt8 nowrap" title={topModel?.model}>
          {topModel?.shortLabel ?? "—"}
        </div>
        <div className="sub">
          {topModel !== undefined
            ? `${String(topModel.pct)}% of cost · ${formatUsd(topModel.costUsd)}`
            : "no priced usage"}
        </div>
      </div>
      {bars.length > 0 && (
        <div className="rob-cell" style={{ flex: "2 1 220px", borderRight: 0 }}>
          <div className="lbl">Per day (UTC)</div>
          <div className="rob-days mt8">
            {bars.map((bar) => (
              <div
                key={bar.date}
                className="rob-bar"
                style={{ height: `${String(Math.max(bar.heightPct, bar.costUsd > 0 ? 4 : 1))}%` }}
                title={`${formatUtcDayLabel(bar.date)} · ${formatUsd(bar.costUsd)} · ${String(bar.sessionCount)} session${bar.sessionCount === 1 ? "" : "s"}`}
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
                {formatUtcDayLabel(bar.date)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
