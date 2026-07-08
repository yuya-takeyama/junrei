import { useEffect, useState } from "react";
import { client, type SessionJson, type SubagentNodeJson } from "./api.js";
import { ContextChart } from "./ContextChart.js";
import {
  formatDateTime,
  formatDuration,
  formatProject,
  formatTokens,
  formatUsd,
} from "./format.js";

interface Props {
  project: string;
  id: string;
}

export function SessionDetail({ project, id }: Props) {
  const [session, setSession] = useState<SessionJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(null);
    setError(null);
    client.api.sessions[":project"][":id"]
      .$get({ param: { project, id } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        setSession((await res.json()) as SessionJson);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [project, id]);

  if (error !== null) return <div className="error-box">Failed to load session: {error}</div>;
  if (session === null) return <div className="loading">Analyzing session…</div>;

  const cacheHitDenominator =
    session.totalUsage.inputTokens +
    session.totalUsage.cacheReadTokens +
    session.totalUsage.cacheCreationTokens;
  const cacheHitRate =
    cacheHitDenominator > 0 ? session.totalUsage.cacheReadTokens / cacheHitDenominator : 0;
  const subagentCost = session.totalUsage.costUsd - session.usage.total.costUsd;

  return (
    <div>
      <p className="back-link">
        <a href="#/">← Sessions</a>
      </p>
      <div className="detail-header">
        <h1>{session.title ?? session.sessionId}</h1>
        <div className="meta-row">
          <span>{formatProject(session.projectDirName, session.cwd)}</span>
          {session.gitBranch !== undefined && <span>⎇ {session.gitBranch}</span>}
          {session.startedAt !== undefined && <span>{formatDateTime(session.startedAt)}</span>}
          {session.durationMs !== undefined && <span>{formatDuration(session.durationMs)}</span>}
          {session.version !== undefined && <span>CC {session.version}</span>}
          <span>
            <code>{session.sessionId}</code>
          </span>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="label">Total cost (est.)</div>
          <div className="value">
            {formatUsd(session.totalUsage.costUsd)}
            {session.totalUsage.costIsComplete ? "" : "*"}
          </div>
          <div className="sub">
            {subagentCost > 0.005 ? `${formatUsd(subagentCost)} in subagents` : "main session only"}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Turns / API messages</div>
          <div className="value">
            {session.userTurnCount} / {session.apiMessageCount}
          </div>
          <div className="sub">{session.models.join(", ")}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Cache hit rate</div>
          <div className="value">{(cacheHitRate * 100).toFixed(1)}%</div>
          <div className="sub">
            {formatTokens(session.totalUsage.cacheReadTokens)} cache-read tokens
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Output tokens</div>
          <div className="value">{formatTokens(session.totalUsage.outputTokens)}</div>
          <div className="sub">
            in {formatTokens(session.totalUsage.inputTokens)} · cacheW{" "}
            {formatTokens(session.totalUsage.cacheCreationTokens)}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Compactions / API errors</div>
          <div className="value">
            {session.compactions.length} / {session.apiErrorCount}
          </div>
          <div className="sub">{session.parseWarningCount} parse warnings</div>
        </div>
      </div>

      <div className="card">
        <h2>Context growth</h2>
        <ContextChart points={session.contextTimeline} compactions={session.compactions} />
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Tool calls</h2>
          <ToolStatsTable session={session} />
        </div>
        <div className="card">
          <h2>Exploration profile</h2>
          <ExplorationTable session={session} />
          <h2 style={{ marginTop: "1rem" }}>Cost by model</h2>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Msgs</th>
                <th className="num">Output</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {session.usage.byModel.map((m) => (
                <tr key={m.model}>
                  <td>
                    <code>{m.model}</code>
                  </td>
                  <td className="num">{m.messageCount}</td>
                  <td className="num">{formatTokens(m.outputTokens)}</td>
                  <td className="num">{m.costUsd !== undefined ? formatUsd(m.costUsd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {session.repetitions.length > 0 && (
        <div className="card">
          <h2>Repetition findings ({session.repetitions.length})</h2>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Tool</th>
                <th className="num">Count</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {session.repetitions.map((r, i) => (
                <tr key={`${r.kind}-${String(i)}`}>
                  <td>
                    <span className="badge">{r.kind}</span>
                  </td>
                  <td>{r.tool}</td>
                  <td className="num">{r.count}</td>
                  <td>
                    <code>{r.subject}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {session.backgroundTasks.length > 0 && (
        <div className="card">
          <h2>Background tasks ({session.backgroundTasks.length})</h2>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Name</th>
                <th>Started</th>
                <th className="num">Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {session.backgroundTasks.map((t) => (
                <tr key={`${t.taskId}-${String(t.startLine)}`}>
                  <td>
                    <span className="badge">{t.kind}</span>
                  </td>
                  <td>{t.name}</td>
                  <td className="muted">
                    {t.startedAt !== undefined ? formatDateTime(t.startedAt) : "—"}
                  </td>
                  <td className="num muted">
                    {t.durationMs !== undefined ? formatDuration(t.durationMs) : "—"}
                  </td>
                  <td>
                    {t.status === "failed" ? (
                      <span className="error-count">failed</span>
                    ) : (
                      <span className={t.status === "unresolved" ? "muted" : ""}>{t.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: "0.75rem", marginBottom: 0 }}>
            "unresolved" means no completion notice exists in the log (e.g. the task outlived the
            session).
          </p>
        </div>
      )}

      {session.subagents.length > 0 && (
        <div className="card">
          <h2>Subagent tree ({session.subagentCount})</h2>
          {session.subagents.map((node) => (
            <SubagentTreeNode key={node.agentId} node={node} />
          ))}
        </div>
      )}

      {session.firstUserPrompt !== undefined && (
        <div className="card">
          <h2>First user prompt</h2>
          <p className="first-prompt">{session.firstUserPrompt}</p>
        </div>
      )}
    </div>
  );
}

function ToolStatsTable({ session }: { session: SessionJson }) {
  if (session.toolStats.length === 0) return <p className="muted">No tool calls.</p>;
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>Tool</th>
          <th className="num">Calls</th>
          <th className="num">Errors</th>
          <th>Error categories</th>
        </tr>
      </thead>
      <tbody>
        {session.toolStats.map((t) => (
          <tr key={t.name}>
            <td>
              <code>{t.name}</code>
            </td>
            <td className="num">{t.callCount}</td>
            <td className="num">
              {t.errorCount > 0 ? <span className="error-count">{t.errorCount}</span> : "0"}
            </td>
            <td>
              {Object.entries(t.errorCategories).map(([category, count]) => (
                <span key={category} className="badge" style={{ marginRight: "0.25rem" }}>
                  {category}: {count}
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExplorationTable({ session }: { session: SessionJson }) {
  const e = session.exploration;
  const rows: Array<[string, string]> = [
    ["Read-type calls", String(e.readToolCalls)],
    ["Edit-type calls", String(e.editToolCalls)],
    ["Read:Edit ratio", e.readEditRatio !== undefined ? e.readEditRatio.toFixed(2) : "—"],
    ["Distinct files read", String(e.distinctFilesRead)],
    ["Distinct files edited", String(e.distinctFilesEdited)],
    [
      "First edit at user turn",
      e.firstEditUserTurn !== undefined ? `#${e.firstEditUserTurn}` : "—",
    ],
    [
      "Time to first edit",
      e.timeToFirstEditMs !== undefined ? formatDuration(e.timeToFirstEditMs) : "—",
    ],
  ];
  return (
    <table className="mini-table">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td className="muted">{label}</td>
            <td className="num">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SubagentTreeNode({ node }: { node: SubagentNodeJson }) {
  return (
    <div className="subagent-node">
      <div className="subagent-head">
        <span className="subagent-type">{node.agentType ?? "agent"}</span>
        {node.description !== undefined && <span>{node.description}</span>}
        {node.model !== undefined && (
          <span className="badge">
            <code>{node.model}</code>
          </span>
        )}
        <span className="badge">{node.toolCallCount} tool calls</span>
        {node.toolErrorCount > 0 && (
          <span className="badge error-count">{node.toolErrorCount} errors</span>
        )}
        <span className="cost">{formatUsd(node.usage.total.costUsd)}</span>
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          out {formatTokens(node.usage.total.outputTokens)}
        </span>
      </div>
      {node.promptPreview !== undefined && (
        <details className="prompt-details">
          <summary>prompt</summary>
          <p className="subagent-prompt">{node.promptPreview}</p>
        </details>
      )}
      {node.children.map((child) => (
        <SubagentTreeNode key={child.agentId} node={child} />
      ))}
    </div>
  );
}
