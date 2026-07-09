import type { SessionJson } from "../../api.js";
import { formatTokens } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import {
  flattenSubagents,
  MAIN_ID,
  nodeDurationMs,
  primaryModel,
  type SelectedId,
  subtreeCost,
  totalTokensOf,
} from "./agentTree.js";
import { DetailPanel } from "./DetailPanel.js";
import { formatCostPair, formatDurationCompact } from "./format.js";

interface Props {
  session: SessionJson;
  selected: SelectedId;
  onSelect: (id: SelectedId) => void;
}

/**
 * Master-detail Tree view — left `.tn` grid (main + subagents, depth-first,
 * box-drawn) plus the right 400px selected-agent detail panel. See
 * design-spec/13-orchestration.md.
 */
export function TreeView({ session, selected, onSelect }: Props) {
  const rows = flattenSubagents(session.subagents);
  const mainModel = primaryModel(session.usage.byModel);

  return (
    <div className="hpad fx gap16 mt16">
      <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }}>
        <div className="tn hdr">
          <span className="lbl">Agent</span>
          <span className="lbl">Model</span>
          <span className="lbl cellr">Tokens · ↩ return</span>
          <span className="lbl cellr">Cost s/t</span>
          <span className="lbl cellr">Dur</span>
        </div>
        <button
          type="button"
          className={selected === MAIN_ID ? "tn on" : "tn"}
          onClick={() => onSelect(MAIN_ID)}
        >
          <span className="fw6">main</span>
          {mainModel !== undefined ? (
            <span className="mbdg">
              <span className={`mdot c-${classifyModel(mainModel)}`} />
              {modelShortLabel(mainModel)}
            </span>
          ) : (
            <span className="mut fs11">—</span>
          )}
          <span className="num fs11 cellr">{formatTokens(totalTokensOf(session.usage.total))}</span>
          <span className="num fs11 cellr">
            {formatCostPair(session.usage.total.costUsd, session.totalUsage.costUsd)}
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
          return (
            <button
              type="button"
              key={row.id}
              className={selected === row.id ? "tn on" : "tn"}
              onClick={() => onSelect(row.id)}
            >
              <span style={{ paddingLeft: `${row.depth * 18}px` }} className="nowrap">
                {row.prefix}
                {row.node.description ?? row.node.agentType ?? row.node.agentId}
              </span>
              {row.node.model !== undefined ? (
                <span className="mbdg">
                  <span className={`mdot c-${classifyModel(row.node.model)}`} />
                  {modelShortLabel(row.node.model)}
                </span>
              ) : (
                <span className="mut fs11">—</span>
              )}
              <span className="num fs11 cellr">
                {tokens}
                {returned}
              </span>
              <span className="num fs11 cellr">
                {formatCostPair(row.node.usage.total.costUsd, subtreeCost(row.node))}
              </span>
              <span className="num fs11 cellr">
                {durationMs !== undefined ? formatDurationCompact(durationMs) : "—"}
              </span>
            </button>
          );
        })}
      </div>
      <DetailPanel session={session} selected={selected} />
    </div>
  );
}
