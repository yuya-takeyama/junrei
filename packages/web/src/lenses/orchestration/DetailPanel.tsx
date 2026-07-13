import { Link } from "react-router";
import type { AnySessionJson, ModelUsageSummary, SubagentNodeJson } from "../../api.js";
import { formatDuration, formatTime, formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import { agentPath, sessionRefOf } from "../../router.js";
import {
  activeModels,
  costShare,
  displayName,
  findSubagent,
  MAIN_ID,
  nodeDurationMs,
  nodeStatus,
  type SelectedId,
  spawnedByLabel,
  totalTokensOf,
} from "./agentTree.js";
import { formatPctShare } from "./format.js";
import { ModelBadges } from "./ModelBadges.js";
import { StatusCell } from "./StatusCell.js";

interface Props {
  session: AnySessionJson;
  selected: SelectedId;
  /** See `TreeView`'s doc comment — computed once per render there, threaded down so the Status row and Cost share here read off the same snapshot as the tree cells. */
  sessionLive: boolean;
}

/**
 * Per-model cost/token split — only rendered when a node actually used more
 * than one active model (the SendMessage model-override case: a subagent
 * billed under both its assigned cheap model and the session's expensive
 * one). Single-model nodes skip straight past this, same as before.
 */
function ModelBreakdown({ models }: { models: readonly ModelUsageSummary[] }) {
  if (models.length <= 1) return null;
  return (
    <div className="mt16">
      <div className="lbl">Per-model</div>
      <div className="mbk hdr">
        <span className="lbl">Model</span>
        <span className="lbl cellr">Msgs</span>
        <span className="lbl cellr">Output</span>
        <span className="lbl cellr">Cost</span>
      </div>
      {models.map((m) => (
        <div className="mbk" key={m.model}>
          <span className="fx ac gap6">
            <span className={`mdot c-${classifyModel(m.model)}`} />
            <span className="mono fs11">{modelShortLabel(m.model)}</span>
          </span>
          <span className="num fs11 cellr">{m.messageCount}</span>
          <span className="num fs11 cellr">{formatTokens(m.outputTokens)}</span>
          <span className="num fs11 cellr">{formatUsd(m.costUsd ?? 0)}</span>
        </div>
      ))}
    </div>
  );
}

function MainDetail({ session, sessionLive }: { session: AnySessionJson; sessionLive: boolean }) {
  const models = activeModels(session.usage.byModel);
  // Claude: per-tool-call stats (toolStats). Codex has no such breakdown —
  // codex.toolCallCount/toolErrorCount already covers the whole main turn.
  const toolCallCount =
    session.source === "claude-code"
      ? session.toolStats.reduce((sum, s) => sum + s.callCount, 0)
      : session.codex.toolCallCount;
  const toolErrorCount =
    session.source === "claude-code"
      ? session.toolStats.reduce((sum, s) => sum + s.errorCount, 0)
      : session.codex.toolErrorCount;
  const mainShare = costShare(session.usage.total.costUsd, session.totalUsage.costUsd);

  return (
    <>
      <div className="fx ac gap10">
        <span className="fw6" style={{ fontSize: "15px" }}>
          {session.title ?? "main"}
        </span>
        <ModelBadges models={models} />
      </div>
      <div className="mono fs10 mut mt8">
        session root · every subagent below is delegated from here
      </div>
      <div className="kv mt16">
        <span className="lbl">Tokens</span>
        <span className="num fs12">{totalTokensOf(session.usage.total).toLocaleString()}</span>
        <span className="lbl">Cost</span>
        <span className="num fs12">
          {formatUsd(session.usage.total.costUsd)}
          {mainShare !== undefined && (
            <span className="mut"> · {formatPctShare(mainShare)} of session</span>
          )}
        </span>
        <span className="lbl">Duration</span>
        <span className="num fs12">
          {session.durationMs !== undefined ? formatDuration(session.durationMs) : "—"}
        </span>
        <span className="lbl">Status</span>
        <span className="num fs12">
          {/* Same rule as the tree's main row: the root has no launch-side
              completion evidence, so liveness alone decides run vs done. */}
          <StatusCell status={sessionLive ? "run" : "done"} />
        </span>
        <span className="lbl">Tool calls</span>
        <span className="num fs12">
          {toolCallCount}
          {toolErrorCount > 0 ? (
            <span className="errtx"> · {toolErrorCount} errors</span>
          ) : (
            <span className="mut"> · 0 errors</span>
          )}
        </span>
      </div>
      <ModelBreakdown models={models} />
    </>
  );
}

function AgentDetail({
  node,
  session,
  sessionLive,
}: {
  node: SubagentNodeJson;
  session: AnySessionJson;
  sessionLive: boolean;
}) {
  const durationMs = nodeDurationMs(node);
  const models = activeModels(node.usage.byModel);
  const nodeShare = costShare(node.usage.total.costUsd, session.totalUsage.costUsd);
  const spawnedAt = node.launchedAt ?? node.startedAt;
  const spawnMeta = [
    `spawned by ${spawnedByLabel(node, session.subagents)}`,
    spawnedAt !== undefined ? `at ${formatTime(spawnedAt)}` : undefined,
    node.launchLine !== undefined ? `L${node.launchLine}` : undefined,
  ]
    .filter((p): p is string => p !== undefined)
    .join(" · ");
  // Both sources get the same nested agent shell (agent/:agentId under the
  // session being viewed) — breadcrumb and URL keep the node's place in this
  // tree, instead of a Codex sub-agent escaping to its own top-level session
  // page and losing the parent chain (see AgentShell.tsx).
  const detailHref = agentPath(sessionRefOf(session), node.agentId);

  return (
    <>
      <div className="fx ac gap10">
        <span className="fw6" style={{ fontSize: "15px" }}>
          {displayName(node)}
        </span>
        <ModelBadges models={models} />
      </div>
      <div className="mono fs10 mut mt8">{spawnMeta}</div>
      {node.promptPreview !== undefined && (
        <div className="btxt mut mt12" style={{ fontSize: "12.5px" }}>
          &quot;{node.promptPreview}&quot;
        </div>
      )}
      <div className="kv mt16">
        <span className="lbl">Tokens</span>
        <span className="num fs12">{totalTokensOf(node.usage.total).toLocaleString()}</span>
        <span className="lbl">Cost</span>
        <span className="num fs12">
          {formatUsd(node.usage.total.costUsd)}
          {nodeShare !== undefined && (
            <span className="mut"> · {formatPctShare(nodeShare)} of session</span>
          )}
        </span>
        <span className="lbl">Duration</span>
        <span className="num fs12">
          {durationMs !== undefined ? formatDuration(durationMs) : "—"}
        </span>
        <span className="lbl">Status</span>
        <span className="num fs12">
          <StatusCell status={nodeStatus(node, sessionLive)} />
        </span>
        <span className="lbl">Returned</span>
        <span className="num fs12">
          {node.returnedChars !== undefined ? (
            `${node.returnedChars.toLocaleString()} chars`
          ) : node.asyncLaunch === true ? (
            // Async launch: the parent-side tool_result is only the launch
            // ack — the real return isn't captured in the log.
            <span className="mono fs10 mut">async · return not in log</span>
          ) : (
            "—"
          )}
        </span>
        <span className="lbl">Tool calls</span>
        <span className="num fs12">
          {node.toolCallCount}
          {node.toolErrorCount > 0 ? (
            <span className="errtx"> · {node.toolErrorCount} errors</span>
          ) : (
            <span className="mut"> · 0 errors</span>
          )}
        </span>
      </div>
      <ModelBreakdown models={models} />
      <div className="ann mt12" style={{ borderTop: "1px dotted var(--bd)", paddingTop: "10px" }}>
        ref · typical subagent summary: 1–2k tokens
      </div>
      <Link className="linkc mono fs11 mt12" style={{ display: "block" }} to={detailHref}>
        open full detail →
      </Link>
    </>
  );
}

/**
 * Right-hand 400px panel in Tree view — main session summary or the
 * selected subagent's launch/usage detail. See
 * design-spec/13-orchestration.md's selected-agent panel.
 */
export function DetailPanel({ session, selected, sessionLive }: Props) {
  const node = selected === MAIN_ID ? undefined : findSubagent(session.subagents, selected);
  return (
    <div
      className="pan"
      style={{ width: "400px", flex: "none", padding: "18px 20px", boxSizing: "border-box" }}
    >
      {node === undefined ? (
        <MainDetail session={session} sessionLive={sessionLive} />
      ) : (
        <AgentDetail node={node} session={session} sessionLive={sessionLive} />
      )}
    </div>
  );
}
