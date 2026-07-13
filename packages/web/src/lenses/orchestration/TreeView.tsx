import type { AnySessionJson } from "../../api.js";
import { formatTokens } from "../../format.js";
import {
  activeModels,
  costShare,
  flattenSubagents,
  isSessionLive,
  MAIN_ID,
  nodeDurationMs,
  nodeStatus,
  type SelectedId,
  totalTokensOf,
} from "./agentTree.js";
import { DetailPanel } from "./DetailPanel.js";
import { formatCostCell, formatDurationCompact, formatPctShare } from "./format.js";
import { ModelBadges } from "./ModelBadges.js";
import { StatusCell } from "./StatusCell.js";

interface Props {
  session: AnySessionJson;
  selected: SelectedId;
  onSelect: (id: SelectedId) => void;
}

/**
 * Master-detail Tree view — left `.tn` grid (main + subagents, depth-first)
 * with CSS-drawn connectors, plus the right 400px selected-agent detail panel. See
 * design-spec/13-orchestration.md.
 */
export function TreeView({ session, selected, onSelect }: Props) {
  const rows = flattenSubagents(session.subagents);
  const mainModels = activeModels(session.usage.byModel);
  // Computed once per render (not per row) — every row's Status cell reads
  // off the SAME "is this session live right now" snapshot, so a render
  // never shows two rows disagreeing about liveness a few ms apart.
  const sessionLive = isSessionLive(session.lastActivityAt, Date.now());

  return (
    <div className="hpad fx gap16 mt16" style={{ alignItems: "flex-start" }}>
      <div className="pan f1 tree-panel" style={{ minWidth: 0, padding: "6px 0" }}>
        <div className="tn hdr">
          <span className="lbl">Agent</span>
          <span className="lbl">Model</span>
          <span className="lbl">Status</span>
          <span className="lbl cellr">Tokens · ↩ return</span>
          <span className="lbl cellr">Cost</span>
          <span className="lbl cellr">%</span>
          <span className="lbl cellr">Dur</span>
        </div>
        <button
          type="button"
          className={selected === MAIN_ID ? "tn on" : "tn"}
          onClick={() => onSelect(MAIN_ID)}
        >
          <span className="fw6">main</span>
          {mainModels.length > 0 ? (
            <ModelBadges models={mainModels} />
          ) : (
            <span className="mut fs11">—</span>
          )}
          {/* The main transcript has no `SubagentNode.status` of its own (it
              IS the session) — "run" while the session still looks live,
              "done" once activity has gone quiet. */}
          <StatusCell status={sessionLive ? "run" : "done"} />
          <span className="num fs11 cellr">{formatTokens(totalTokensOf(session.usage.total))}</span>
          <span className="num fs11 cellr">{formatCostCell(session.usage.total.costUsd)}</span>
          <span className="num fs11 cellr">
            {formatPctShare(costShare(session.usage.total.costUsd, session.totalUsage.costUsd))}
          </span>
          <span className="num fs11 cellr">
            {session.durationMs !== undefined ? formatDurationCompact(session.durationMs) : "—"}
          </span>
        </button>
        {rows.map((row) => {
          const durationMs = nodeDurationMs(row.node);
          const tokens = formatTokens(totalTokensOf(row.node.usage.total));
          const returned =
            row.node.returnedChars !== undefined
              ? ` · ↩${formatTokens(row.node.returnedChars)}`
              : "";
          const models = activeModels(row.node.usage.byModel);
          const share = costShare(row.node.usage.total.costUsd, session.totalUsage.costUsd);
          return (
            <button
              type="button"
              key={row.id}
              className={selected === row.id ? "tn on" : "tn"}
              onClick={() => onSelect(row.id)}
            >
              <span className="tree-cell">
                <span className="tree-connectors" aria-hidden="true">
                  {row.ancestorIsLast.map((ancestorIsLast, index) => {
                    const lineage = row.ancestorIsLast
                      .slice(0, index + 1)
                      .map((isLast) => (isLast ? "last" : "more"))
                      .join("-");
                    return (
                      <span
                        className={ancestorIsLast ? "tree-guide" : "tree-guide has-line"}
                        key={`${row.id}-${lineage}`}
                      />
                    );
                  })}
                  <span className={row.isLast ? "tree-branch last" : "tree-branch"} />
                </span>
                <span className="nowrap">
                  {row.node.description ?? row.node.agentType ?? row.node.agentId}
                </span>
              </span>
              {models.length > 0 ? (
                <ModelBadges models={models} />
              ) : (
                <span className="mut fs11">—</span>
              )}
              <StatusCell status={nodeStatus(row.node, sessionLive)} />
              <span className="num fs11 cellr">
                {tokens}
                {returned}
              </span>
              <span className="num fs11 cellr">{formatCostCell(row.node.usage.total.costUsd)}</span>
              <span className="num fs11 cellr">{formatPctShare(share)}</span>
              <span className="num fs11 cellr">
                {durationMs !== undefined ? formatDurationCompact(durationMs) : "—"}
              </span>
            </button>
          );
        })}
      </div>
      <DetailPanel session={session} selected={selected} sessionLive={sessionLive} />
    </div>
  );
}
