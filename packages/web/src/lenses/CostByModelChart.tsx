import { Link } from "react-router";
import type { AnySessionJson } from "../api.js";
import { formatUsd } from "../format.js";
import { classifyModel, modelShortLabel } from "../modelClass.js";
import { sessionPath, sessionRefOf } from "../router.js";
import { EstBadge } from "../shell/EstBadge.js";
import { capsFor } from "../sourceCaps.js";

interface Props {
  session: AnySessionJson;
}

/** Cost-by-model chart (headline panel) — see design-spec/11-session-overview.md. */
export function CostByModelChart({ session }: Props) {
  // Drop zero-usage placeholder entries such as Claude Code's "<synthetic>" model.
  const rows = session.totalUsageByModel
    .filter((m) => (m.costUsd ?? 0) > 0 || m.outputTokens > 0 || m.inputTokens > 0)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  const maxCost = Math.max(0, ...rows.map((m) => m.costUsd ?? 0));
  const totalCost = session.totalUsage.costUsd;
  const mainCost = session.usage.total.costUsd;
  const delegatedCost = Math.max(0, totalCost - mainCost);
  // Both sources have a real sub-agent tree now (Codex: collab threads folded
  // in by `codex/orchestration.ts` in `@junrei/core`), so the main/delegated
  // split and the "→ orchestration" link apply to both; at 0 subagents the
  // Orchestration lens renders its own empty state, same as for Claude.
  const orchestrationHref = sessionPath(sessionRefOf(session), "orchestration");

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "18px 20px" }}>
        <div className="chartcap">
          <span className="lbl">Cost by model</span>
          <span className="fx ac gap12">
            <span className="mono fs11 mut">
              main {formatUsd(mainCost)} · delegated {formatUsd(delegatedCost)}
              {capsFor(session).costIsEstimated && <EstBadge />}
            </span>
            <Link className="linkc mono fs11" to={orchestrationHref}>
              → orchestration
            </Link>
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="mut fs12">No priced usage in this session.</p>
        ) : (
          <div className="col gap12 mt12">
            {rows.map((m) => {
              const cost = m.costUsd ?? 0;
              const width = maxCost > 0 ? (cost / maxCost) * 100 : 0;
              const pct = totalCost > 0 ? Math.round((cost / totalCost) * 100) : 0;
              return (
                <div className="brow" key={m.model}>
                  <span className="bn">{modelShortLabel(m.model)}</span>
                  <div className="btrk" style={{ borderRadius: 0 }}>
                    <div
                      className={`bfill c-${classifyModel(m.model)}`}
                      style={{ width: `${width}%`, borderRadius: 0 }}
                    />
                  </div>
                  <span className={cost === 0 ? "bv mut" : "bv"}>
                    {formatUsd(cost)} · {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
