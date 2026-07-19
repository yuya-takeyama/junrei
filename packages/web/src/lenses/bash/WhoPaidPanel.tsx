import type { BashStatsJson } from "../../api.js";
import { buildThreadMoneyRows, threadMoneyModelDotClass } from "./bashLensFormat.js";

interface Props {
  byThread: BashStatsJson["byThread"];
}

/** `amber` for the $ bar (this app's "pay attention here" accent) vs. muted grey for the chars bar — reinforces the "chars share and $ share often disagree" story through color, not just the two numbers. */
function ShareBar({
  label,
  pct,
  text,
  amber,
}: {
  label: string;
  pct: number;
  text: string;
  amber?: boolean;
}) {
  return (
    <div className="brow">
      <span className="bn">{label}</span>
      <div className="btrk">
        <div
          className={amber ? "bfill" : "bfill c-mut"}
          style={amber ? { width: `${pct}%`, background: "var(--amb)" } : { width: `${pct}%` }}
        />
      </div>
      <span className="bv">{text}</span>
    </div>
  );
}

/**
 * WHO PAID panel (Bash lens — money attribution) — the "98% of chars, cheap
 * — 1.6% of chars but most of the $" contrast: one row per `buildThreadMoneyRows`
 * result (the orchestrator, then up to 3 subagent MODEL groups, then a
 * trailing "+N more" rollup — see that builder's doc comment for the
 * aggregation rule), each showing its own share of session chars vs. session
 * $ as two side-by-side bars. The orchestrator row's label renders `.amb`
 * (this app's "pay attention here" accent, same as `.b-tab.on`/`.rere`) —
 * it's usually the row where a LOW chars-share and a HIGH $-share collide,
 * which is exactly the insight this panel exists to surface.
 */
export function WhoPaidPanel({ byThread }: Props) {
  const rows = buildThreadMoneyRows(byThread);

  return (
    <div className="pan" style={{ padding: "14px 16px" }}>
      <div className="lbl mb8">Who paid</div>
      {rows.length === 0 ? (
        <div className="mono fs11 mut mt8">no Bash calls recorded</div>
      ) : (
        <div className="col gap12 mt8">
          {rows.map((row) => (
            <div className="fx gap12" key={row.key} style={{ alignItems: "center" }}>
              <span
                className="fx ac gap6"
                style={{ width: "160px", flex: "none" }}
                title={row.model}
              >
                {!row.isAggregate && (
                  <span className={`mdot ${threadMoneyModelDotClass(row.model)}`} />
                )}
                <span
                  className={`mono fs11 nowrap${row.isOrchestrator ? " amb" : row.isAggregate ? " mut" : ""}`}
                >
                  {row.label}
                </span>
              </span>
              <div className="col gap4" style={{ flex: 1, minWidth: 0 }}>
                <ShareBar
                  label="chars"
                  pct={row.charsSharePct}
                  text={`${row.charsSharePct.toFixed(1)}%`}
                />
                <ShareBar
                  label="$"
                  pct={row.usdSharePct ?? 0}
                  text={row.usdSharePct !== undefined ? `${row.usdSharePct.toFixed(1)}%` : "—"}
                  amber
                />
              </div>
              <span className="bv" style={{ width: "72px" }}>
                {row.estUsdText}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
