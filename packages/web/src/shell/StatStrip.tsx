import type { ReactNode } from "react";
import { Link } from "react-router";
import type { SessionJson } from "../api.js";
import { cacheHitRate, formatTokens, formatUsd } from "../format.js";
import { sessionPath } from "../router.js";

interface Props {
  session: SessionJson;
}

/**
 * Session-level KPI row — see design-spec/01-shell.md (`.b-strip`/`.b-cell`).
 * Persists across every lens (L1 overview and L3 subagent detail per the
 * spec); each cell links to the lens that explains its number.
 */
export function StatStrip({ session }: Props) {
  const delegatedCost = Math.max(0, session.totalUsage.costUsd - session.usage.total.costUsd);
  const nestedSubagents = Math.max(0, session.subagentCount - session.subagents.length);
  const contextHref = sessionPath(session.projectDirName, session.sessionId, "context");

  return (
    <div className="b-strip mt16">
      <Cell label="Total cost" href={contextHref}>
        <div className="big mt8 amb">
          {formatUsd(session.totalUsage.costUsd)}
          {session.totalUsage.costIsComplete ? "" : "*"}
        </div>
        <div className="sub num">{formatUsd(delegatedCost)} delegated</div>
      </Cell>
      <Cell
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
      </Cell>
      <Cell label="Cache hit" href={contextHref}>
        <div className="big mt8">{(cacheHitRate(session.totalUsage) * 100).toFixed(0)}%</div>
        <div className="sub">of input tokens</div>
      </Cell>
      <Cell label="Output tok" href={contextHref}>
        <div className="big mt8">{formatTokens(session.totalUsage.outputTokens)}</div>
        <div className="sub">all agents</div>
      </Cell>
      <Cell label="Compact / err" href={contextHref}>
        <div className="big mt8">
          {session.compactions.length}
          <span className="mut" style={{ fontSize: "15px" }}>
            {" "}
            / {session.apiErrorCount}
          </span>
        </div>
        <div className="sub">boundaries / API</div>
      </Cell>
      <Cell
        label="Subagents"
        href={sessionPath(session.projectDirName, session.sessionId, "orchestration")}
        last
      >
        <div className={session.subagentCount === 0 ? "big mt8 mut" : "big mt8"}>
          {session.subagentCount}
        </div>
        <div className="sub">{nestedSubagents} nested</div>
      </Cell>
    </div>
  );
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
