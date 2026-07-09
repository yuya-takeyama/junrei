import type { SessionJson, SubagentNodeJson } from "../../api.js";
import { formatDuration, formatTime, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import {
  displayName,
  findSubagent,
  MAIN_ID,
  nodeDurationMs,
  primaryModel,
  type SelectedId,
  spawnedByLabel,
  totalTokensOf,
} from "./agentTree.js";

interface Props {
  session: SessionJson;
  selected: SelectedId;
}

function ModelBadge({ model }: { model: string | undefined }) {
  if (model === undefined) return null;
  return (
    <span className="mbdg">
      <span className={`mdot c-${classifyModel(model)}`} />
      {modelShortLabel(model)}
    </span>
  );
}

function MainDetail({ session }: { session: SessionJson }) {
  const model = primaryModel(session.usage.byModel);
  const toolCallCount = session.toolStats.reduce((sum, s) => sum + s.callCount, 0);
  const toolErrorCount = session.toolStats.reduce((sum, s) => sum + s.errorCount, 0);

  return (
    <>
      <div className="fx ac gap10">
        <span className="fw6" style={{ fontSize: "15px" }}>
          {session.title ?? "main"}
        </span>
        <ModelBadge model={model} />
      </div>
      <div className="mono fs10 mut mt8">
        session root · every subagent below is delegated from here
      </div>
      <div className="kv mt16">
        <span className="lbl">Tokens</span>
        <span className="num fs12">{totalTokensOf(session.usage.total).toLocaleString()}</span>
        <span className="lbl">Cost</span>
        <span className="num fs12">{formatUsd(session.usage.total.costUsd)}</span>
        <span className="lbl">Duration</span>
        <span className="num fs12">
          {session.durationMs !== undefined ? formatDuration(session.durationMs) : "—"}
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
    </>
  );
}

function AgentDetail({ node, session }: { node: SubagentNodeJson; session: SessionJson }) {
  const durationMs = nodeDurationMs(node);
  const spawnedAt = node.launchedAt ?? node.startedAt;
  const spawnMeta = [
    `spawned by ${spawnedByLabel(node, session.subagents)}`,
    spawnedAt !== undefined ? `at ${formatTime(spawnedAt)}` : undefined,
    node.launchLine !== undefined ? `L${node.launchLine}` : undefined,
  ]
    .filter((p): p is string => p !== undefined)
    .join(" · ");
  const detailHref = `#/session/${encodeURIComponent(session.projectDirName)}/${encodeURIComponent(session.sessionId)}/agent/${encodeURIComponent(node.agentId)}`;

  return (
    <>
      <div className="fx ac gap10">
        <span className="fw6" style={{ fontSize: "15px" }}>
          {displayName(node)}
        </span>
        <ModelBadge model={node.model} />
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
        <span className="num fs12">{formatUsd(node.usage.total.costUsd)}</span>
        <span className="lbl">Duration</span>
        <span className="num fs12">
          {durationMs !== undefined ? formatDuration(durationMs) : "—"}
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
      <div className="ann mt12" style={{ borderTop: "1px dotted var(--bd)", paddingTop: "10px" }}>
        ref · typical subagent summary: 1–2k tokens
      </div>
      <a className="linkc mono fs11 mt12" style={{ display: "block" }} href={detailHref}>
        open full detail →
      </a>
    </>
  );
}

/**
 * Right-hand 400px panel in Tree view — main session summary or the
 * selected subagent's launch/usage detail. See
 * design-spec/13-orchestration.md's selected-agent panel.
 */
export function DetailPanel({ session, selected }: Props) {
  const node = selected === MAIN_ID ? undefined : findSubagent(session.subagents, selected);
  return (
    <div
      className="pan"
      style={{ width: "400px", flex: "none", padding: "18px 20px", boxSizing: "border-box" }}
    >
      {node === undefined ? (
        <MainDetail session={session} />
      ) : (
        <AgentDetail node={node} session={session} />
      )}
    </div>
  );
}
