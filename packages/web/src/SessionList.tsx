import { useEffect, useState } from "react";
import { client, type SessionListItem } from "./api.js";
import {
  formatDateTime,
  formatDuration,
  formatProject,
  formatTokens,
  formatUsd,
} from "./format.js";

export function SessionList() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.api.sessions
      .$get({ query: {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = await res.json();
        setSessions(body.sessions);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error !== null) return <div className="error-box">Failed to load sessions: {error}</div>;
  if (sessions === null) return <div className="loading">Analyzing sessions…</div>;

  return (
    <div className="card">
      <h2>Recent sessions ({sessions.length})</h2>
      <table className="session-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Started</th>
            <th className="num">Duration</th>
            <th className="num">Turns</th>
            <th className="num">Tools</th>
            <th className="num">Errors</th>
            <th className="num">Agents</th>
            <th className="num">Compact</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={`${s.projectDirName}/${s.sessionId}`}>
              <td>
                <a
                  className="session-title"
                  href={`#/session/${encodeURIComponent(s.projectDirName)}/${encodeURIComponent(s.sessionId)}`}
                  title={s.firstUserPrompt ?? s.sessionId}
                >
                  {s.title ?? s.firstUserPrompt?.slice(0, 60) ?? s.sessionId}
                </a>
                <span className="session-project">{formatProject(s.projectDirName, s.cwd)}</span>
              </td>
              <td className="muted">
                {s.startedAt !== undefined ? formatDateTime(s.startedAt) : "—"}
              </td>
              <td className="num muted">
                {s.durationMs !== undefined ? formatDuration(s.durationMs) : "—"}
              </td>
              <td className="num">{s.userTurnCount}</td>
              <td className="num">{s.toolCallCount}</td>
              <td className="num">
                {s.toolErrorCount > 0 ? (
                  <span className="error-count">{s.toolErrorCount}</span>
                ) : (
                  <span className="muted">0</span>
                )}
              </td>
              <td className="num">
                {s.subagentCount > 0 ? s.subagentCount : <span className="muted">0</span>}
              </td>
              <td className="num">
                {s.compactionCount > 0 ? s.compactionCount : <span className="muted">0</span>}
              </td>
              <td className="num muted" title={`cache read ${formatTokens(s.cacheReadTokens)}`}>
                {formatTokens(s.totalTokens)}
              </td>
              <td className="num cost">
                {formatUsd(s.totalCostUsd)}
                {s.costIsComplete ? "" : "*"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: "0.75rem", marginBottom: 0 }}>
        Costs are estimates computed from token usage and public pricing. * = some models had no
        known pricing.
      </p>
    </div>
  );
}
