import type { TrendsReport } from "@junrei/core";
import type { RepoOption } from "../sessionListHelpers.js";
import { AnomaliesPanel } from "./AnomaliesPanel.js";
import { CadencePanel } from "./CadencePanel.js";
import { DailyCostChart } from "./DailyCostChart.js";
import { DelegationSplitChart } from "./DelegationSplitChart.js";
import { EfficiencyMultiples } from "./EfficiencyMultiples.js";
import { TrendsKpiRow } from "./TrendsKpiRow.js";

interface Props {
  report: TrendsReport;
  windowDays: number;
  /** Repo dropdown options, keyed by `repoFilterKey` — see `AnomaliesPanel`'s doc comment. */
  repoOptionByKey: ReadonlyMap<string, RepoOption>;
  /** The Trends screen's own active `?repo=` filter (the `ALL_REPOS` sentinel or a real key) — carried through to `DailyCostChart`/`AnomaliesPanel`'s drill-down links so a spike-day/column click into the session list preserves it (see `router.ts`'s `sessionListDayFilterPath`). */
  repoFilter: string;
}

/**
 * Presentational Trends body — every chart/panel for spec items 3–8, split
 * out from `Trends.tsx` (the URL/fetch wrapper) so it's directly renderable
 * from a fixture `TrendsReport` with no `fetch`/`useEffect` involved (see
 * `Trends.test.tsx`). `report.summary.current.sessionCount === 0` (the empty
 * window state, spec item 9) gets an explicit muted note up top; every
 * individual chart/panel below ALSO degrades gracefully on its own (each has
 * its own "no data" message, matching `CostByModelChart`/`ContextGrowthChart`
 * precedent), so this isn't the only place emptiness is handled — just the
 * one spot that names it for a window with sessions in a wider sense (e.g. a
 * repo filter that matches zero of the fetched sessions).
 */
export function TrendsView({ report, windowDays, repoOptionByKey, repoFilter }: Props) {
  const { buckets, summary, anomalies } = report;
  const isEmpty = summary.current.sessionCount === 0;

  return (
    <>
      <TrendsKpiRow current={summary.current} delta={summary.delta} windowDays={windowDays} />
      {isEmpty && (
        <div className="hpad mt16">
          <div className="pan tile mut">No sessions in this window.</div>
        </div>
      )}
      <DailyCostChart buckets={buckets} spikeDays={anomalies.spikeDays} repoFilter={repoFilter} />
      <DelegationSplitChart buckets={buckets} />
      <EfficiencyMultiples buckets={buckets} />
      <CadencePanel buckets={buckets} />
      <AnomaliesPanel
        topSessions={anomalies.topSessions}
        spikeDays={anomalies.spikeDays}
        repoOptionByKey={repoOptionByKey}
        repoFilter={repoFilter}
      />
    </>
  );
}
