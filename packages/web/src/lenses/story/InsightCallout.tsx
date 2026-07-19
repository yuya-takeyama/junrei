import { Link } from "react-router";
import type { SessionInsight, SessionInsightRecommendation, SessionRef } from "../../api.js";
import { formatRate } from "../../briefing/briefingFormat.js";
import { LoggedLink } from "../../briefing/LoggedLink.js";
import { ProvenanceBadge } from "../../briefing/ProvenanceBadge.js";
import { formatUsd } from "../../format.js";
import { sessionPath } from "../../router.js";

interface Props {
  insight: SessionInsight;
  /** The session this callout belongs to — Log-learning writes carry its provenance. */
  sessionRef: SessionRef;
  /** Log a recommendation as a new open learning. Omitted in read-only renders. */
  onLog?: (rec: SessionInsightRecommendation) => void;
  /** Recommendation key currently being written (its button shows a pending state). */
  loggingKey?: string | undefined;
  /** Recommendation keys already logged this session view (button shows a done state). */
  loggedKeys?: ReadonlySet<string>;
}

/**
 * A recommendation's stable identity within one insight — its finding text is
 * the natural key (recommendations are 1:1 with the top waste findings, whose
 * titles are distinct), used to track per-row logging/logged state.
 */
export function recommendationKey(rec: SessionInsightRecommendation): string {
  return rec.finding;
}

/**
 * The FROM-THIS-SESSION insight callout (PR4 Story tab) — the conclusion-first
 * read that sits ABOVE the embedded Timeline. Presentational: it renders only
 * values already on the `SessionInsight` payload (`GET
 * /api/sessions/<source>/:id/insight`), the same server-side
 * `buildSessionInsightFor` the `analyze_session` MCP tool calls, so the callout
 * and the tool can't drift. Each recommendation carries a "Log learning" button
 * that POSTs the recommendation's `logLearningCall` as a new open learning
 * (with this session as its `sourceSessions` provenance).
 *
 * A `delegationShare`/waste summary line gives the money read at a glance; the
 * `analyze_session()` provenance badge (Pattern C) traces every number to one
 * server call and shows its `_meta.approxTokens` context cost.
 */
/** Archetype → chip class + tooltip (study §1 cost-share axis). */
const ARCHETYPE_CHIP: Record<
  SessionInsight["summary"]["archetype"],
  { cls: string; title: string }
> = {
  marathon: {
    cls: "abadge marathon",
    title: "main ≥85% of cost — orchestrator-context-dominated (levers R1/R2)",
  },
  "fan-out": {
    cls: "abadge fanout",
    title: "main ≤55% of cost — subagent-tier/turn-dominated (levers R3/R4)",
  },
  mixed: { cls: "abadge mixed", title: "in between — both levers apply" },
};

export function InsightCallout({ insight, sessionRef, onLog, loggingKey, loggedKeys }: Props) {
  const { summary, recommendations, waste, delegation, contextLifetime } = insight;
  const badge = (
    <ProvenanceBadge call="analyze_session()" approxTokens={insight._meta.approxTokens} />
  );
  const archetype = ARCHETYPE_CHIP[summary.archetype];

  return (
    <div className="hpad mt16">
      <section className="pan insight-callout">
        <div className="sec-head">
          <span className="sec-title">From this session</span>
          <span className={archetype.cls} title={archetype.title}>
            {summary.archetype}
          </span>
          <span className="sec-rule" />
          {badge}
        </div>

        <p className="insight-headline fs13">{summary.headline}</p>

        {contextLifetime.warning && (
          <p className="insight-ctxwarn mono fs11 t-rd">
            ⚠ context ran to {contextLifetime.ctxMaxTokens.toLocaleString()} tokens with 0
            compactions — cap the orchestrator's context lifetime (R1).
          </p>
        )}

        <div className="insight-metaline mono fs11 mut">
          <span>
            {delegation.subagentCount} subagent{delegation.subagentCount === 1 ? "" : "s"}
          </span>
          <span className="amb">·</span>
          <span>
            {summary.delegationShare === null
              ? "delegation unpriced"
              : `${formatRate(summary.delegationShare)} of cost delegated`}
          </span>
          {delegation.oversizedReturnCount > 0 && (
            <>
              <span className="amb">·</span>
              <span className="t-rd">
                {delegation.oversizedReturnCount} oversized return
                {delegation.oversizedReturnCount === 1 ? "" : "s"}
              </span>
            </>
          )}
          {insight.notAvailable !== undefined && insight.notAvailable.length > 0 && (
            <>
              <span className="amb">·</span>
              <span title={`Not available for this source: ${insight.notAvailable.join(", ")}`}>
                {insight.notAvailable.length} metric
                {insight.notAvailable.length === 1 ? "" : "s"} n/a
              </span>
            </>
          )}
        </div>

        {recommendations.length === 0 ? (
          <p className="mut fs12 mt12">
            {waste.length === 0
              ? "No ranked waste in this session — the delegation and shell-usage shape looks clean."
              : "No actionable recommendation surfaced for this session's waste."}
          </p>
        ) : (
          <ol className="insight-recs">
            {recommendations.map((rec, i) => {
              const key = recommendationKey(rec);
              const logging = loggingKey === key;
              const logged = loggedKeys?.has(key) === true;
              return (
                <li key={key} className="insight-rec">
                  <span className="wrank mono">{String(i + 1).padStart(2, "0")}</span>
                  <div className="insight-rec-main">
                    <div className="insight-rec-finding fs13">{rec.finding}</div>
                    <div className="insight-rec-change mono fs11">fix ▸ {rec.change}</div>
                    {rec.expectedEffect !== undefined && (
                      <div className="insight-rec-effect mono fs11 t-gr">{rec.expectedEffect}</div>
                    )}
                  </div>
                  <div className="insight-rec-end">
                    <span className="west mono">
                      {rec.impactUsd === undefined ? "unpriced" : formatUsd(rec.impactUsd)}
                    </span>
                    {onLog !== undefined &&
                      (logged ? (
                        <LoggedLink />
                      ) : (
                        <button
                          type="button"
                          className="ghost"
                          disabled={logging}
                          onClick={() => {
                            onLog(rec);
                          }}
                        >
                          {logging ? "logging…" : "Log learning"}
                        </button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <div className="insight-foot mono fs11 mut">
          <Link className="linkc" to={sessionPath(sessionRef, "evidence")}>
            Full detail in Evidence →
          </Link>
        </div>
      </section>
    </div>
  );
}
