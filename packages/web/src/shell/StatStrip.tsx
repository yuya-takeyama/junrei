import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AnySessionJson } from "../api.js";
import { cacheHitRate, formatTokens, formatUsd } from "../format.js";
import { sessionPath } from "../router.js";
import { EstBadge } from "./EstBadge.js";

interface Props {
  session: AnySessionJson;
}

/**
 * Session-level KPI row — see design-spec/01-shell.md (`.b-strip`/`.b-cell`).
 * Persists across every lens (L1 overview and L3 subagent detail per the
 * spec); each cell links to the lens that explains its number.
 *
 * Cells are built as a list rather than hardcoded JSX so the last one's
 * right border can be dropped correctly regardless of which cells a given
 * source renders — Codex sessions render five cells (no Subagents: Codex has
 * no subagent tree), Claude Code sessions render six.
 */
export function StatStrip({ session }: Props) {
  const contextHref = sessionPath(
    session.source === "claude-code" ? session.projectDirName : "codex",
    session.sessionId,
    "context",
  );

  const cells: ReactNode[] = [
    <Cell key="cost" label="Total cost" href={contextHref}>
      <div className="big mt8 amb">
        {formatUsd(session.totalUsage.costUsd)}
        {session.totalUsage.costIsComplete ? "" : "*"}
        {session.source === "codex" && <EstBadge />}
      </div>
      {session.source === "claude-code" ? (
        <div className="sub num">
          {formatUsd(Math.max(0, session.totalUsage.costUsd - session.usage.total.costUsd))}{" "}
          delegated
        </div>
      ) : (
        <div className="sub">this session</div>
      )}
    </Cell>,
  ];

  if (session.source === "claude-code") {
    cells.push(
      <Cell
        key="turns"
        label="Turns / msgs"
        href={sessionPath(session.projectDirName, session.sessionId, "timeline")}
      >
        <div className="big mt8">
          {session.userTurnCount}
          <span className="mut" style={{ fontSize: "15px" }}>
            {" "}
            / {session.apiMessageCount}
          </span>
        </div>
        <div className="sub">user / API</div>
      </Cell>,
    );
  } else {
    cells.push(
      <Cell key="turns" label="Turns" href={sessionPath("codex", session.sessionId, "turns")}>
        <div className="big mt8">{session.userTurnCount}</div>
        <div className="sub">user turns</div>
      </Cell>,
    );
  }

  cells.push(
    <Cell key="cache" label="Cache hit" href={contextHref}>
      <div className="big mt8">{(cacheHitRate(session.totalUsage) * 100).toFixed(0)}%</div>
      <div className="sub">of input tokens</div>
    </Cell>,
    <Cell key="output" label="Output tok" href={contextHref}>
      <div className="big mt8">{formatTokens(session.totalUsage.outputTokens)}</div>
      <div className="sub">all agents</div>
    </Cell>,
  );

  if (session.source === "claude-code") {
    cells.push(
      <Cell key="compact" label="Compact / err" href={contextHref}>
        <div className="big mt8">
          {session.compactions.length}
          <span className="mut" style={{ fontSize: "15px" }}>
            {" "}
            / {session.apiErrorCount}
          </span>
        </div>
        <div className="sub">boundaries / API</div>
      </Cell>,
    );
    const nestedSubagents = Math.max(0, session.subagentCount - session.subagents.length);
    cells.push(
      <Cell
        key="subagents"
        label="Subagents"
        href={sessionPath(session.projectDirName, session.sessionId, "orchestration")}
        last
      >
        <div className={session.subagentCount === 0 ? "big mt8 mut" : "big mt8"}>
          {session.subagentCount}
        </div>
        <div className="sub">{nestedSubagents} nested</div>
      </Cell>,
    );
  } else {
    cells.push(
      <Cell key="compact" label="Compact / tool err" href={contextHref} last>
        <div className="big mt8">
          {session.compactions.length}
          <span className="mut" style={{ fontSize: "15px" }}>
            {" "}
            / {session.codex.toolErrorCount}
          </span>
        </div>
        <div className="sub">boundaries / tool</div>
      </Cell>,
    );
  }

  return <div className="b-strip mt16">{cells}</div>;
}

function Cell({
  label,
  href,
  last = false,
  children,
}: {
  label: string;
  href: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <Link className="b-cell" to={href} style={last ? { borderRight: 0 } : undefined}>
      <div className="lbl">{label}</div>
      {children}
    </Link>
  );
}
