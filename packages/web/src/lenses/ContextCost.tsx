import type { ReactNode } from "react";
import type { SessionJson } from "../api.js";
import { cacheHitRate, formatTokens, formatUsd } from "../format.js";
import { ContextGrowthChart } from "./ContextGrowthChart.js";
import { ApiErrorsPanel } from "./contextCost/ApiErrorsPanel.js";
import { CostByModelTable } from "./contextCost/CostByModelTable.js";
import { TurnCompositionChart } from "./contextCost/TurnCompositionChart.js";

interface Props {
  session: SessionJson;
  /**
   * Overrides the embedded `ContextGrowthChart`'s "→ context & cost" link
   * target. Since this lens IS the context & cost lens, that link is
   * necessarily a self-link back to the current page — harmless for the
   * session shell (its default resolution already points here), but the
   * agent detail shell must pass its own `agentPath(..., "context")`
   * explicitly: an agent's own sidecar analysis carries a `sessionId` /
   * `projectDirName` that don't correspond to real route params, so the
   * chart's built-in default resolution would build a broken href.
   */
  contextHref?: string;
}

function StatTile({ label, big, sub }: { label: string; big: ReactNode; sub: ReactNode }) {
  return (
    <div className="pan tile" style={{ flex: "none" }}>
      <div className="lbl">{label}</div>
      <div className="big mt8">{big}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

/**
 * Context & cost lens (L2) — see design-spec/14-context-cost.md. Scoped
 * entirely to the MAIN transcript: row 1's tiles read `session.usage.total`
 * (not `session.totalUsage`, which folds in subagents) so they line up with
 * the per-turn breakdown below, which — like `turnUsage` itself — can only
 * ever describe the main transcript's own user turns. This intentionally
 * diverges from `StatStrip`'s aggregate "Cache hit" cell one screen up; only
 * row 3's cost-by-model table uses the merged `totalUsageByModel`, matching
 * the Overview lens's existing `CostByModelChart`.
 *
 * Reused as-is by the agent detail shell (L3) — every field here comes from
 * whichever `SessionAnalysis` JSON is passed in, main session or a
 * subagent's own sidecar analysis.
 */
export function ContextCost({ session, contextHref }: Props) {
  const total = session.usage.total;
  const hitRate = cacheHitRate(total);
  const effectiveInput = total.inputTokens + total.cacheReadTokens + total.cacheCreationTokens;

  return (
    <>
      <div className="hpad fx gap16 mt16">
        <ContextGrowthChart
          session={session}
          {...(contextHref !== undefined && { contextHref })}
          bare
        />
        <div className="col gap12" style={{ width: "300px", flex: "none" }}>
          <StatTile
            label="Cache hit"
            big={`${(hitRate * 100).toFixed(0)}%`}
            sub={`${formatTokens(total.cacheReadTokens)} cache-read / ${formatTokens(effectiveInput)} input`}
          />
          <StatTile
            label="Cache writes"
            big={formatTokens(total.cacheCreationTokens)}
            sub={
              <span className="num">
                {total.cacheWriteCostUsd !== undefined
                  ? `${formatUsd(total.cacheWriteCostUsd)} `
                  : ""}
                at 1.25× rate
              </span>
            }
          />
          <StatTile
            label="Fresh input / output"
            big={
              <>
                {formatTokens(total.inputTokens)}
                <span className="mut" style={{ fontSize: "15px" }}>
                  {" "}
                  / {formatTokens(total.outputTokens)}
                </span>
              </>
            }
            sub="uncached in / generated out"
          />
        </div>
      </div>

      <TurnCompositionChart session={session} />

      <div className="hpad fx gap16 mt16">
        <CostByModelTable session={session} />
        <ApiErrorsPanel session={session} />
      </div>
    </>
  );
}
