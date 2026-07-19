import type { ReactNode } from "react";
import { Link } from "react-router";
import type { BriefingWaste, Learning } from "../api.js";
import { ProvenanceBadge } from "../briefing/ProvenanceBadge.js";
import { formatUsd } from "../format.js";
import { sessionPath } from "../router.js";
import { assignColumns, loopHealth } from "./boardColumns.js";

interface Props {
  learnings: Learning[];
  /** The briefing's dollar-ranked waste feed — the MEASURE column's raw material. */
  waste: BriefingWaste[];
  /** Context-token estimates for the two provenance badges (learnings list has none; briefing does). */
  briefingApproxTokens?: number | undefined;
  onAccept?: (learning: Learning) => void;
  onDismiss?: (learning: Learning) => void;
  onLogWaste?: (waste: BriefingWaste) => void;
  /** Id (learning id or waste session id) currently being written — its buttons show a pending state. `| undefined` explicit for the forwarded state value. */
  pendingKey?: string | undefined;
}

/**
 * Learnings loop board (Pattern B Frame 1) — a loop-health strip over the
 * MEASURE / LEARN / CHANGE / VERIFY pipeline. MEASURE is the briefing's waste
 * feed; the other three columns are the repo-local ledger routed by status
 * (`assignColumns`). Accept/Dismiss (LEARN) and Log learning (MEASURE) all
 * POST the same upsert `log_learning` runs. Presentational: column routing and
 * the health figures are pure (`learningsBoard.ts`); fabricated aggregates are
 * withheld (cycle time / verified savings render only when the ledger actually
 * carries the data).
 */
export function LearningsBoard({
  learnings,
  waste,
  briefingApproxTokens,
  onAccept,
  onDismiss,
  onLogWaste,
  pendingKey,
}: Props) {
  const cols = assignColumns(learnings);
  const health = loopHealth(learnings);

  return (
    <div className="board">
      <div className="loop-health">
        <div className="lh-loop mono">Loop health</div>
        {health.cycleTimeDays !== null && (
          <HealthItem label="cycle time" value={`${health.cycleTimeDays.toFixed(1)}d`} />
        )}
        <HealthItem label="open cards" value={String(health.open)} />
        <HealthItem label="applied" value={String(health.applied)} />
        <HealthItem label="verified" value={String(health.verified)} accent="gr" />
        {health.verifiedCostSavingsPerDay !== null && (
          <HealthItem
            label="verified saving"
            value={`${formatUsd(health.verifiedCostSavingsPerDay)}/day`}
            accent="gr"
          />
        )}
      </div>

      <div className="board-cols">
        <Column
          name="Measure"
          count={waste.length}
          badge={<ProvenanceBadge call="briefing()" approxTokens={briefingApproxTokens} />}
        >
          {waste.length === 0 ? (
            <EmptyCol text="No waste detected this window." />
          ) : (
            waste.map((w, i) => (
              <div
                key={`${w.provenance.sessionId}:${w.class}:${String(i)}`}
                className="lb-card tint-r"
              >
                <div className="fx ac jb">
                  <span className="lb-est mono">
                    {w.impactUsd === undefined ? "unpriced" : formatUsd(w.impactUsd)}
                  </span>
                  <span className="lb-chip r">Waste</span>
                </div>
                <div className="lb-body fs12">{w.title}</div>
                <Link
                  className="lb-prov mono fs11"
                  to={sessionPath({ source: w.provenance.source, id: w.provenance.sessionId })}
                  title={w.provenance.title ?? w.provenance.sessionId}
                >
                  from {w.provenance.title ?? w.provenance.sessionId}
                </Link>
                {onLogWaste !== undefined && (
                  <button
                    type="button"
                    className="ghost lb-act"
                    disabled={pendingKey === w.provenance.sessionId}
                    onClick={() => {
                      onLogWaste(w);
                    }}
                  >
                    {pendingKey === w.provenance.sessionId ? "logging…" : "Log learning →"}
                  </button>
                )}
              </div>
            ))
          )}
        </Column>

        <Column
          name="Learn"
          count={cols.learn.length}
          badge={<ProvenanceBadge call="learnings()" />}
        >
          {cols.learn.length === 0 ? (
            <EmptyCol text="No open learnings — log one from Measure." />
          ) : (
            cols.learn.map((l) => (
              <div key={l.id} className="lb-card tint-a">
                <div className="fx ac jb">
                  <span className="lb-id mono am">{l.id}</span>
                  <span className="lb-chip a">
                    {l.proposedBy === "agent" ? "Open · agent" : "Open"}
                  </span>
                </div>
                <div className="lb-body fs12">
                  {l.finding} <span className="mut">Change: {l.change}</span>
                </div>
                <div className="lb-btns">
                  <button
                    type="button"
                    className="btn-accept"
                    disabled={pendingKey === l.id}
                    onClick={() => onAccept?.(l)}
                  >
                    {pendingKey === l.id ? "…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    className="btn-dismiss"
                    disabled={pendingKey === l.id}
                    onClick={() => onDismiss?.(l)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))
          )}
        </Column>

        <Column
          name="Change"
          count={cols.change.length}
          badge={<ProvenanceBadge call="learnings()" />}
        >
          {cols.change.length === 0 ? (
            <EmptyCol text="Accepted learnings collect evidence here, then flow to Verify →" />
          ) : (
            cols.change.map((l) => (
              <div key={l.id} className="lb-card tint-b">
                <div className="fx ac jb">
                  <span className="lb-id mono t-bl">{l.id}</span>
                  <span className="lb-chip b">Applied</span>
                </div>
                <div className="lb-body fs12">
                  {l.finding} <span className="mut">Change: {l.change}</span>
                </div>
                <div className="lb-meta mono fs11 t-bl">applied — awaiting data</div>
              </div>
            ))
          )}
        </Column>

        <Column
          name="Verify"
          count={cols.verify.length}
          badge={<ProvenanceBadge call="learnings()" />}
        >
          {cols.verify.length === 0 ? (
            <EmptyCol text="Verified & rejected changes land here, with before/after." />
          ) : (
            cols.verify.map((l) => {
              const verified = l.status === "verified";
              return (
                <div key={l.id} className={verified ? "lb-card tint-g" : "lb-card muted"}>
                  <div className="fx ac jb">
                    <span className={verified ? "lb-id mono t-gr" : "lb-id mono mut"}>{l.id}</span>
                    <span className={verified ? "lb-chip g" : "lb-chip m"}>
                      {verified ? "Verified" : "Rejected"}
                    </span>
                  </div>
                  <div className={verified ? "lb-body fs12" : "lb-body fs12 mut"}>{l.finding}</div>
                  {l.verification !== undefined ? (
                    <div className="lb-effect mono fs11">
                      {l.verification.metric}: {formatMetric(l.verification.before)} →{" "}
                      {formatMetric(l.verification.after)}{" "}
                      <span className="mut">
                        ({String(l.verification.windowDays)}d before/after)
                      </span>
                    </div>
                  ) : (
                    <div className="lb-meta mono fs11 mut">
                      {verified ? "verified — no measured effect recorded" : "rejected · closed"}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </Column>
      </div>
    </div>
  );
}

function Column({
  name,
  count,
  badge,
  children,
}: {
  name: string;
  count: number;
  badge: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="board-col">
      <div className="phead">
        <span className="pname">{name}</span>
        <span className="pcount mono">{count}</span>
        {badge}
      </div>
      <div className="pcards">{children}</div>
    </div>
  );
}

function HealthItem({ label, value, accent }: { label: string; value: string; accent?: "gr" }) {
  return (
    <div className="lh-item">
      <span className="lh-k">{label}</span>
      <span className={accent === "gr" ? "lh-v mono t-gr" : "lh-v mono"}>{value}</span>
    </div>
  );
}

function EmptyCol({ text }: { text: string }) {
  return <p className="mut fs11 pcards-empty">{text}</p>;
}

/** Trim a metric number for display — 2 decimals, dropping trailing zeros. */
function formatMetric(n: number): string {
  return String(Math.round(n * 100) / 100);
}
