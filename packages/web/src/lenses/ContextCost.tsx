import type { ReactNode } from "react";
import type { AnySessionJson } from "../api.js";
import { cacheHitRate, formatTokens, formatUsd } from "../format.js";
import { ContextGrowthChart } from "./ContextGrowthChart.js";
import { ApiErrorsPanel } from "./contextCost/ApiErrorsPanel.js";
import { CostByModelTable } from "./contextCost/CostByModelTable.js";
import { TurnCompositionChart } from "./contextCost/TurnCompositionChart.js";

interface Props {
  session: AnySessionJson;
  /**
   * Overrides the embedded `ContextGrowthChart`'s "→ context & cost" link
   * target. Since this lens IS the context & cost lens, that link is
   * necessarily a self-link back to the current page — harmless for the
   * session shell (its default resolution already points here), but the
   * agent detail shell must pass its own `agentPath(..., "context")`
   * explicitly: an agent's own sidecar analysis carries a `sessionId` that
   * doesn't correspond to a real route param (it's the sidecar's own
   * filename stem, not the session's), so the chart's built-in default
   * resolution would build a broken href.
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
 * Context & cost lens (L2, the Evidence lens's Context sub-tab in PR4) — see
 * design-spec/14-context-cost.md. Row 1's cache-writes / fresh-input tiles read
 * `session.usage.total` (the MAIN transcript) so they line up with the per-turn
 * breakdown below, which — like `turnUsage` itself — only ever describes the
 * main transcript's own user turns. The Cache-hit tile is the deliberate
 * exception: it reads `session.totalUsage` (ALL threads) and is labeled
 * accordingly, so its number matches the session stat strip's "Cache hit" cell
 * exactly (PR4 consistency sweep — these two used to diverge by a couple of
 * points). Row 3's cost-by-model table uses the merged `totalUsageByModel`.
 *
 * Reused as-is by the agent detail shell (L3) — every field here comes from
 * whichever `ClaudeSessionAnalysis` JSON is passed in, main session or a
 * subagent's own sidecar analysis. Also reused for Codex sessions: row 1
 * (context growth + the three cache/token tiles) and row 3's cost-by-model
 * table read only `SessionAnalysisCore` fields, so they render unchanged.
 * The per-turn cache-write chart and API-errors panel are Claude-only
 * concepts (Codex has no cache-write cost and no "API error" log — see
 * `SourceCaps`'s `hasTurnCompositionChart`/`hasApiErrors` in `sourceCaps.ts`)
 * and are skipped for Codex; its own per-turn detail lives in the unified
 * Timeline lens's turn-grouped spine instead (`buildCodexTurnGroups` in
 * `turnGroups.ts`). Narrowed once here (rather than at each panel) since
 * `TurnCompositionChart`/`ApiErrorsPanel` take a Claude-only `SessionJson`
 * prop, not the `AnySessionJson` union.
 */
export function ContextCost({ session, contextHref }: Props) {
  const total = session.usage.total;
  const claude = session.source === "claude-code" ? session : undefined;
  // Cache hit is the ONE tile here scoped to ALL threads (`totalUsage`), not the
  // main transcript (`usage.total`) the cache-writes / fresh-input tiles below
  // read — so this figure matches the session stat strip's "Cache hit" cell
  // exactly (PR4 consistency sweep resolved the old ~2pt strip-vs-tile split).
  // Its sub-label says "all threads" to make that wider scope explicit.
  const allThreads = session.totalUsage;
  const hitRate = cacheHitRate(allThreads);
  const cacheReadAllThreads = allThreads.cacheReadTokens;
  const effectiveInputAllThreads =
    allThreads.inputTokens + allThreads.cacheReadTokens + allThreads.cacheCreationTokens;

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
            label="Cache hit · all threads"
            big={`${(hitRate * 100).toFixed(0)}%`}
            sub={`${formatTokens(cacheReadAllThreads)} cache-read / ${formatTokens(effectiveInputAllThreads)} input`}
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

      {claude !== undefined && <TurnCompositionChart session={claude} />}

      <div className="hpad fx gap16 mt16">
        <CostByModelTable session={session} />
        {claude !== undefined && <ApiErrorsPanel session={claude} />}
      </div>
    </>
  );
}
