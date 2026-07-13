import { useEffect, useState } from "react";
import type { RepoOverview } from "./api.js";
import { fetchRepoOverview } from "./api.js";
import { formatDelegatedShare, formatUsd } from "./format.js";
import { dayBars, formatUtcDayLabel, topModelShare } from "./repoOverviewHelpers.js";

interface Props {
  /** Repo filter key (see `repoFilterKey`) — the caller only renders this band when one specific repo is selected, never for `ALL_REPOS`. */
  repo: string;
}

/**
 * Repo-level aggregate band for the session list (L0), shown between the
 * filter bar and the table once a specific repo is selected. Dogfooding
 * showed this was the top capability gap: reading a repo's total cost,
 * fable-vs-sonnet split, and per-day trend all required client-side jq, with
 * no in-app equivalent (see `@junrei/server`'s `overview.ts`, which this
 * fetches via `fetchRepoOverview`).
 *
 * Loading is silent (renders nothing until data arrives) and a fetch failure
 * is logged and swallowed (the band just doesn't render) — this is a
 * supplementary aggregate above the session table, not a primary view, so it
 * fails quiet rather than showing a spinner or error banner.
 */
export function RepoOverviewBand({ repo }: Props) {
  const [overview, setOverview] = useState<RepoOverview | null>(null);

  useEffect(() => {
    setOverview(null);
    let stale = false;
    fetchRepoOverview(repo)
      .then((data) => {
        if (!stale) setOverview(data);
      })
      .catch((e: unknown) => {
        console.error("Failed to load repo overview:", e);
      });
    return () => {
      stale = true;
    };
  }, [repo]);

  if (overview === null) return null;

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
              · est.
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
