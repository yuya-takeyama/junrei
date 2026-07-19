import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Briefing, BriefingWaste } from "../api.js";
import { formatUsd } from "../format.js";
import { LEARNINGS_ROUTE_PATH, sessionPath } from "../router.js";
import { formatDeltaPct, formatDeltaPts, formatRate } from "./briefingFormat.js";
import { CostSparkbar } from "./CostSparkbar.js";
import { ProvenanceBadge } from "./ProvenanceBadge.js";

/** Status → chip class + label for a learning reference card (amber=open, blue=applied, green=verified, muted=rejected). */
const LEARNING_CHIP: Record<
  Briefing["learnings"]["recent"][number]["status"],
  { cls: string; label: string }
> = {
  open: { cls: "lchip open", label: "Open" },
  applied: { cls: "lchip applied", label: "Applied" },
  verified: { cls: "lchip verified", label: "Verified" },
  rejected: { cls: "lchip rejected", label: "Rejected" },
};

interface Props {
  briefing: Briefing;
  /** Approximate context-token cost of the briefing call, for the provenance badges. */
  approxTokens: number;
  /** Log a waste finding as a new open learning (the WASTE rows' "Log learning" button). Omitted in read-only/SSR renders. */
  onLogWaste?: (waste: BriefingWaste) => void;
  /** Session id currently being logged (its button shows a pending state). `| undefined` explicit for the forwarded state value under exactOptionalPropertyTypes. */
  loggingKey?: string | undefined;
}

/**
 * Briefing home body (Pattern A Frame 1) — a KPI delta strip over LEARNINGS /
 * WASTE / WINS sections and a footer cost sparkbar. Presentational: it renders
 * ONLY values already on the `Briefing` payload (`GET /api/briefing`) — the
 * KPI numbers, the waste rollup, the section metas all trace to one server
 * call, never a client re-aggregation (concept G5). Each panel carries a
 * `briefing()` provenance badge (Pattern C). An empty window renders the
 * briefing's own `nextSteps` instead of blank sections.
 */
export function BriefingView({ briefing, approxTokens, onLogWaste, loggingKey }: Props) {
  const { summary, learnings, waste, wins } = briefing;
  const badge = <ProvenanceBadge call="briefing()" approxTokens={approxTokens} />;

  if (summary.sessionCount === 0) {
    return (
      <div className="brief-body">
        <KpiStrip briefing={briefing} badge={badge} />
        <div className="brief-empty pan">
          <div className="lbl">Nothing in this window</div>
          <ul className="brief-next">
            {(briefing._meta.nextSteps ?? ["Widen the period, or check the repo filter."]).map(
              (step) => (
                <li key={step} className="fs13">
                  {step}
                </li>
              ),
            )}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="brief-body">
      <KpiStrip briefing={briefing} badge={badge} />

      <section>
        <div className="sec-head">
          <span className="sec-title">Learnings</span>
          <span className="sec-rule" />
          <Link className="linkc mono fs11" to={`/${LEARNINGS_ROUTE_PATH}`}>
            the ledger →
          </Link>
          {badge}
        </div>
        {learnings.recent.length === 0 ? (
          <p className="mut fs12">No learnings logged yet — log one from a waste item below.</p>
        ) : (
          <div className="lgrid">
            {learnings.recent.slice(0, 3).map((l) => {
              const chip = LEARNING_CHIP[l.status];
              return (
                <div key={l.id} className="lcard pan">
                  <div className="fx ac jb">
                    <span className="mono fs11 mut">{l.id}</span>
                    <span className={chip.cls}>{chip.label}</span>
                  </div>
                  <div className="lcard-body fs13">{l.finding}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="brief-dual">
        <section>
          <div className="sec-head">
            <span className="sec-title">Waste</span>
            <span className="sec-rule" />
            <span className="sec-meta t-rd">
              {summary.wasteUsd === null
                ? "unpriced"
                : `${formatUsd(summary.wasteUsd)} recoverable`}
              {summary.wasteShareOfCost !== null && ` · ${formatRate(summary.wasteShareOfCost)}`}
            </span>
            {badge}
          </div>
          {waste.length === 0 ? (
            <p className="mut fs12">No ranked waste this window — delegation shape looks clean.</p>
          ) : (
            <div className="wlist">
              {waste.map((w, i) => {
                const key = `${w.provenance.sessionId}:${w.class}:${String(i)}`;
                const logging = loggingKey === w.provenance.sessionId;
                return (
                  <div key={key} className="wrw">
                    <span className="wrank mono">{String(i + 1).padStart(2, "0")}</span>
                    <div className="wmain">
                      <div className="wtitle fs13">{w.title}</div>
                      <div className="wfix mono fs11">fix ▸ {w.fix}</div>
                      <Link
                        className="wprov mono fs11"
                        to={sessionPath({
                          source: w.provenance.source,
                          id: w.provenance.sessionId,
                        })}
                        title={w.provenance.title ?? w.provenance.sessionId}
                      >
                        {w.provenance.title ?? w.provenance.sessionId}
                      </Link>
                    </div>
                    <div className="wend">
                      <span className="west mono">
                        {w.impactUsd === undefined ? "unpriced" : formatUsd(w.impactUsd)}
                      </span>
                      {onLogWaste !== undefined && (
                        <button
                          type="button"
                          className="ghost"
                          disabled={logging}
                          onClick={() => {
                            onLogWaste(w);
                          }}
                        >
                          {logging ? "logging…" : "Log learning"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="sec-head">
            <span className="sec-title">Wins</span>
            <span className="sec-rule" />
            <span className="sec-meta t-gr">patterns to keep</span>
            {badge}
          </div>
          {wins.length === 0 ? (
            <p className="mut fs12">No demonstrated delegation wins in this window yet.</p>
          ) : (
            <div className="wincol">
              {wins.map((win) => (
                <div key={win.model} className="wincard pan">
                  <div className="win-metric mono t-gr">
                    {Math.round(win.successRate * 100)}%{" "}
                    <span className="win-unit">success · {win.launches} launches</span>
                  </div>
                  <div className="win-body fs13">
                    {win.model} · avg return {formatChars(win.avgReturnChars)}
                  </div>
                  <div className="win-foot mono fs11 mut">
                    {win.avgCostUsd === undefined
                      ? "unpriced"
                      : `avg ${formatUsd(win.avgCostUsd)} / launch`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <CostSparkbar briefing={briefing} />
    </div>
  );
}

/** The five KPI delta cards — every value straight off `briefing.summary`/`.learnings`, none re-derived. */
function KpiStrip({ briefing, badge }: { briefing: Briefing; badge: ReactNode }) {
  const { summary, learnings } = briefing;
  const delta = summary.delta;
  return (
    <div className="kpis pan">
      <Kpi
        label={`Cost · ${String(summary.window.days)}d`}
        value={formatUsd(summary.costUsd)}
        sub={delta === null ? "no prior window" : `${formatDeltaPct(delta.costUsdPct)} vs prev`}
      />
      <Kpi
        label="Waste detected"
        value={summary.wasteUsd === null ? "—" : formatUsd(summary.wasteUsd)}
        valueClass="t-rd"
        sub={
          summary.wasteShareOfCost === null
            ? "unpriced"
            : `${formatRate(summary.wasteShareOfCost)} of spend`
        }
      />
      <Kpi
        label="Delegation share"
        value={formatRate(summary.delegationShare)}
        valueClass="t-bl"
        sub={delta === null ? "of cost" : `of cost · ${formatDeltaPts(delta.delegationSharePts)}`}
      />
      <Kpi
        label="Cache hit"
        value={formatRate(summary.cacheHitRate)}
        sub={delta === null ? "of effective input" : formatDeltaPts(delta.cacheHitRatePts)}
      />
      <div className="kpi">
        <div className="kpi-label">Learnings</div>
        <div className="ldots mono fs12">
          <span>
            <i className="dot am" />
            {learnings.open} open
          </span>
          <span>
            <i className="dot bl" />
            {learnings.applied} applied
          </span>
          <span>
            <i className="dot gr" />
            {learnings.verified} verified
          </span>
        </div>
      </div>
      <div className="kpi-badge">{badge}</div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={valueClass === undefined ? "kpi-val mono" : `kpi-val mono ${valueClass}`}>
        {value}
      </div>
      <div className="kpi-sub mono mut">{sub}</div>
    </div>
  );
}

/** Chars → `8.2k` past a thousand — the same compact convention as `format.ts`'s token formatter. */
function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${String(n)} chars`;
}
