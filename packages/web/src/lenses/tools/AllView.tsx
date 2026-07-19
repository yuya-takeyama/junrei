import { useState } from "react";
import type { AnySessionJson, SessionRef } from "../../api.js";
import { sessionPath } from "../../router.js";
import { WhoPaidPanel } from "../bash/WhoPaidPanel.js";
import { ToolHeavyHittersTable } from "./ToolHeavyHittersTable.js";
import { ToolRankingTable } from "./ToolRankingTable.js";
import {
  buildDecisionStrip,
  buildErrorMatrix,
  buildSourceSplit,
  type DecisionCard,
  type ErrorMatrixModel,
  hasToolActivity,
  type SourceSplitModel,
} from "./toolsLensFormat.js";

interface Props {
  session: AnySessionJson;
  sessionRef: SessionRef;
  onOpenRecord?: (line: number, agentId?: string) => void;
}

/** How many heavy-hitter rows show before the "show N more" expander. */
const HEAVY_HITTER_PREVIEW = 8;

function DecisionCardView({ card }: { card: DecisionCard }) {
  return (
    <div className="pan dcard">
      <div className="lbl">{card.label}</div>
      <div className="dcard-v">
        <span className={card.valueAccent !== undefined ? "big amb" : "big"}>{card.value}</span>
        {card.valueSub !== undefined && <span className="mut fs12">{card.valueSub}</span>}
      </div>
      {card.meterPct !== undefined && (
        <div className="meter">
          <span
            className={card.meterMuted ? "mut" : undefined}
            style={{ width: `${Math.min(100, Math.max(0, card.meterPct))}%` }}
          />
        </div>
      )}
      {card.subLines.map((line) => (
        <div className="dcard-sub" key={line}>
          {line}
        </div>
      ))}
    </div>
  );
}

function SourceSplit({ model }: { model: SourceSplitModel }) {
  const { builtIn, mcp } = model;
  return (
    <div className="pan" style={{ padding: "14px 16px" }}>
      <div className="chartcap">
        <span className="lbl">Source split · built-in vs MCP</span>
        <span className="mono fs10 mut">by ~est $</span>
      </div>
      <div className="splitbar">
        {builtIn !== undefined && (
          <div
            className="splitseg"
            style={{ width: `${builtIn.widthPct}%`, background: "var(--amb)" }}
          />
        )}
        {mcp !== undefined && (
          <div className="splitseg" style={{ width: `${mcp.widthPct}%`, background: "var(--s)" }} />
        )}
      </div>
      <div className="split-legend">
        {builtIn !== undefined && (
          <span className="lg">
            <span className="lgs" style={{ background: "var(--amb)" }} />
            {builtIn.legend}
          </span>
        )}
        {mcp !== undefined && (
          <span className="lg">
            <span className="lgs" style={{ background: "var(--s)" }} />
            {mcp.legend}
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorMatrix({ model }: { model: ErrorMatrixModel }) {
  const gridTemplateColumns = `minmax(0,1fr) repeat(${model.columns.length}, 84px) 52px`;
  return (
    <div className="pan" style={{ padding: "4px 0" }}>
      <div className="emx hdr" style={{ gridTemplateColumns }}>
        <span className="lbl">Tool</span>
        {model.columns.map((col) => (
          <span className="emxh" key={col.key}>
            {col.lines[0]}
            <br />
            {col.lines[1]}
          </span>
        ))}
        <span className="emxh">total</span>
      </div>
      {model.rows.map((row) => (
        <div className="emx" style={{ gridTemplateColumns }} key={row.name}>
          <span className="mono fs12 nowrap">
            <span className={row.name === "Bash" ? "amb" : undefined}>{row.name}</span>
          </span>
          {row.counts.map((count, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional (aligned to a fixed column order), never reordered
              key={i}
              className={count === 0 ? "num fs12 cellr z" : "num fs12 cellr"}
            >
              {count}
            </span>
          ))}
          <span className="num fs12 cellr">{row.total}</span>
        </div>
      ))}
      <div className="emx tot" style={{ gridTemplateColumns }}>
        <span className="lbl">Total</span>
        {model.columnTotals.map((count, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional (aligned to a fixed column order), never reordered
            key={i}
            className={count === 0 ? "num fs12 cellr z" : "num fs12 cellr"}
          >
            {count}
          </span>
        ))}
        <span className="num fs12 cellr amb">{model.grandTotal}</span>
      </div>
    </div>
  );
}

/**
 * Tools lens → "All" sub-tab (`AllView`) — the cross-tool analysis per the
 * approved mockup, top to bottom: a 4-card decision strip (pure data
 * statements), the tool usage ranking table (with the Bash row's drill-down to
 * the Bash sub-tab), the built-in-vs-MCP source split, the errors-by-tool ×
 * category matrix, the reused "Who paid" money-attribution panel, the heavy
 * hitters (with a "show N more" expander), and the estimation footnotes.
 *
 * Every value comes from `session.toolUsageStats` via the pure builders in
 * `toolsLensFormat.ts` — this component only lays them out and owns the one
 * bit of local UI state (heavy-hitter expansion). `WhoPaidPanel` is reused
 * unchanged from the Bash lens: `toolUsageStats.byThread` is type-identical to
 * `bashStats.byThread`.
 */
export function AllView({ session, sessionRef, onOpenRecord }: Props) {
  const stats = session.toolUsageStats;
  const [heavyOpen, setHeavyOpen] = useState(false);

  if (!hasToolActivity(stats.totals)) {
    return (
      <div className="hpad mt16">
        <div className="pan tile mut">No tool calls recorded in this session.</div>
      </div>
    );
  }

  const decision = buildDecisionStrip(stats);
  const sourceSplit = buildSourceSplit(stats);
  const errorMatrix = buildErrorMatrix(stats);
  const bashHref = sessionPath(sessionRef, "evidence", "tools", "bash");
  const heavyTotal = stats.heavyHitters.length;
  const visibleCount = heavyOpen ? heavyTotal : Math.min(HEAVY_HITTER_PREVIEW, heavyTotal);
  const hiddenCount = heavyTotal - Math.min(HEAVY_HITTER_PREVIEW, heavyTotal);

  return (
    <>
      <div className="hpad mt16">
        <div className="dstrip">
          <DecisionCardView card={decision.costConcentration} />
          <DecisionCardView card={decision.errorConcentration} />
          <DecisionCardView card={decision.largestResult} />
          <DecisionCardView card={decision.orchestratorShare} />
        </div>
      </div>

      <div className="hpad mt16">
        <div className="chartcap">
          <span className="lbl">Tool usage · cross-thread</span>
          <span className="mono fs10 mut">ranked by ~est $ · bars show $ share</span>
        </div>
        <ToolRankingTable stats={stats} bashHref={bashHref} />
      </div>

      <div className="hpad mt16">
        <SourceSplit model={sourceSplit} />
      </div>

      {errorMatrix !== undefined && (
        <div className="hpad mt16">
          <div className="chartcap">
            <span className="lbl">Errors by tool × category</span>
            <span className="mono fs10 mut">
              {errorMatrix.grandTotal} tool errors · cross-thread
            </span>
          </div>
          <ErrorMatrix model={errorMatrix} />
        </div>
      )}

      <div className="hpad mt16">
        <WhoPaidPanel byThread={stats.byThread} />
      </div>

      <div className="hpad mt16">
        <div className="chartcap">
          <span className="lbl">Heavy hitters · top single results ({heavyTotal})</span>
          <span className="mono fs10 mut">by result size · across all tools</span>
        </div>
        <ToolHeavyHittersTable
          heavyHitters={stats.heavyHitters}
          visibleCount={visibleCount}
          {...(onOpenRecord !== undefined && { onOpenRecord })}
        />
        {hiddenCount > 0 && (
          <button
            type="button"
            className="exp-toggle mono fs11 mut mt12"
            style={{ display: "block", width: "100%", textAlign: "center" }}
            onClick={() => setHeavyOpen((v) => !v)}
            aria-expanded={heavyOpen}
          >
            {heavyOpen ? "▴ show fewer" : `▸ show ${hiddenCount} more`}
          </button>
        )}
      </div>

      <div className="hpad mt16" style={{ paddingBottom: "28px" }}>
        <div className="mono fs10 mut" style={{ lineHeight: 1.6 }}>
          ~ token/$ figures are chars/4 × model input price estimates; per-tool $ splits inherit the
          session&apos;s model attribution; MCP tool result sizes vary by server. Only Bash has a
          per-command drill-down today; no repo percentile baseline exists for all-tools yet
          (Bash-scoped only).
        </div>
      </div>
    </>
  );
}
