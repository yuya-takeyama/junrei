import type { TrendSpikeDay, TrendTopSession } from "@junrei/core";
import { Link } from "react-router";
import { formatDateTime, formatUsd } from "../format.js";
import { sessionListDayFilterPath, sessionPath } from "../router.js";
import type { RepoOption } from "../sessionListHelpers.js";
import { sourceBadgeLabel } from "../sessionListHelpers.js";

interface Props {
  topSessions: readonly TrendTopSession[];
  spikeDays: readonly TrendSpikeDay[];
  /** Repo dropdown options, keyed by `repoFilterKey` — reused to resolve each top session's `repoKey` (same key scheme, see `router.ts`'s `parseRepoParam` doc comment) to a short display label instead of the raw key. */
  repoOptionByKey: ReadonlyMap<string, RepoOption>;
  /** Active `?repo=` filter (the `ALL_REPOS` sentinel or a real key) — carried into each spike-day row's session-list drill-down link, see `router.ts`'s `sessionListDayFilterPath`. */
  repoFilter: string;
}

/**
 * Anomalies panel (Trends screen spec item 8) — the current window's top-5
 * costliest sessions (each linking to its own session detail route) plus any
 * statistically spiking days from `anomalies.spikeDays`. Two side-by-side
 * `.pan` cards, matching how the Context & cost lens pairs its cost-by-model
 * table with the API-errors panel (`ContextCost.tsx`'s row 3).
 */
export function AnomaliesPanel({ topSessions, spikeDays, repoOptionByKey, repoFilter }: Props) {
  return (
    <div className="hpad mt16 fx gap16" style={{ flexWrap: "wrap" }}>
      <div className="pan f1" style={{ minWidth: 340, padding: "6px 0" }}>
        <div className="trend-top hdr" style={{ padding: "6px 16px" }}>
          <span className="lbl">#</span>
          <span className="lbl">Repo</span>
          <span className="lbl">Prompt</span>
          <span className="lbl">Started</span>
          <span className="lbl">Source</span>
          <span className="lbl cellr">Cost</span>
        </div>
        {topSessions.length === 0 ? (
          <p className="mut fs12" style={{ padding: "10px 16px", margin: 0 }}>
            No sessions in this window.
          </p>
        ) : (
          topSessions.map((s, i) => (
            <Link
              key={`${s.source}/${s.sessionId}`}
              className="trend-top"
              style={{ padding: "7px 16px" }}
              to={sessionPath({ source: s.source, id: s.sessionId })}
            >
              <span className="mono fs11 mut num">{i + 1}</span>
              <span
                className="mono fs11 mut nowrap"
                title={repoOptionByKey.get(s.repoKey)?.title ?? s.repoKey}
              >
                {repoOptionByKey.get(s.repoKey)?.label ?? s.repoKey}
              </span>
              <span className="ph">{s.firstUserPrompt ?? s.sessionId}</span>
              <span className="num fs12 mut">
                {s.startedAt !== undefined ? formatDateTime(s.startedAt) : "—"}
              </span>
              <span className="mbdg" title={sourceBadgeLabel(s.source)}>
                {sourceBadgeLabel(s.source)}
              </span>
              <span className="num fs12 cellr amb">{formatUsd(s.totalCostUsd)}</span>
            </Link>
          ))
        )}
      </div>

      <div className="pan f1" style={{ minWidth: 240, padding: "18px 20px" }}>
        <div className="chartcap">
          <span className="lbl">Spike days</span>
        </div>
        {spikeDays.length === 0 ? (
          <p className="mut fs12">No cost spikes detected in this window.</p>
        ) : (
          spikeDays.map((d) => (
            <Link
              key={d.date}
              className="trend-spike-row"
              to={sessionListDayFilterPath(d.date, repoFilter)}
              title={`See sessions from ${d.date}`}
            >
              <span className="amb">⚠</span>
              <span className="mono">{d.date}</span>
              <span className="num">{formatUsd(d.costUsd)}</span>
              <span>
                vs mean {formatUsd(d.mean)} (σ {formatUsd(d.stddev)})
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
