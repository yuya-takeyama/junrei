import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AnySessionJson } from "../api.js";
import { cacheHitRate, formatDelegatedShare, formatTokens, formatUsd } from "../format.js";
import { sessionPath, sessionRefOf } from "../router.js";
import { capsFor } from "../sourceCaps.js";
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
 * source renders. Both sources render the same six cells now that Codex has
 * a real sub-agent tree (see `codex/orchestration.ts` in `@junrei/core`) —
 * the Subagents cell always renders (even at 0, styled muted like Claude's
 * zero-subagent case) rather than being conditional on count, for the same
 * minimal-branch reasoning as the rest of this component. The Total-cost
 * subline is likewise source-uniform: `totalUsage` folds in descendant
 * threads for both sources, so the delegated split from `session.delegation`
 * is the honest caption for either — a static "this session" label would
 * misread a Codex parent whose total includes sub-agent threads. The est.
 * marker on the dollar figure stays a `capsFor` concern (Codex costs are
 * list-price estimates), independent of this split.
 */
export function StatStrip({ session }: Props) {
  const ref = sessionRefOf(session);
  const contextHref = sessionPath(ref, "context");
  // Both sources now carry `delegation` (Codex: all-zero `subagents` when it
  // has no sub-agent forest) — see `@junrei/core`'s `delegation.ts`.
  const delegatedShare = formatDelegatedShare(session.delegation);

  const cells: ReactNode[] = [
    <Cell key="cost" label="Total cost" href={contextHref}>
      <div className="big mt8 amb">
        {formatUsd(session.totalUsage.costUsd)}
        {session.totalUsage.costIsComplete ? "" : "*"}
        {capsFor(session).costIsEstimated && <EstBadge />}
      </div>
      <div className="sub num">
        {formatUsd(session.delegation.subagents.costUsd ?? 0)} delegated
        {delegatedShare !== undefined && ` — ${delegatedShare}`}
      </div>
    </Cell>,
  ];

  if (session.source === "claude-code") {
    cells.push(
      <Cell key="turns" label="Turns / msgs" href={sessionPath(ref, "timeline")}>
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
      <Cell key="turns" label="Turns" href={sessionPath(ref, "turns")}>
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
      <Cell key="compact" label="Compact / API err" href={contextHref}>
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
      <Cell key="subagents" label="Subagents" href={sessionPath(ref, "orchestration")} last>
        <div className={session.subagentCount === 0 ? "big mt8 mut" : "big mt8"}>
          {session.subagentCount}
        </div>
        <div className="sub">{nestedSubagents} nested</div>
      </Cell>,
    );
  } else {
    cells.push(
      <Cell key="compact" label="Compact / tool err" href={contextHref}>
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
    const nestedSubagents = Math.max(0, session.subagentCount - session.subagents.length);
    cells.push(
      <Cell key="subagents" label="Subagents" href={sessionPath(ref, "orchestration")} last>
        <div className={session.subagentCount === 0 ? "big mt8 mut" : "big mt8"}>
          {session.subagentCount}
        </div>
        <div className="sub">{nestedSubagents} nested</div>
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
