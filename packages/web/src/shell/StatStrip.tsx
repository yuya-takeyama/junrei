import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AnySessionJson } from "../api.js";
import { cacheHitRate, formatDelegatedShare, formatTokens, formatUsd } from "../format.js";
import { sessionPath, sessionRefOf } from "../router.js";

interface Props {
  session: AnySessionJson;
}

/**
 * Session-level KPI row — see design-spec/01-shell.md (`.b-strip`/`.b-cell`).
 * Persists across every lens (L1 overview and L3 subagent detail per the
 * spec); each cell links to the lens that explains its number.
 *
 * Renders one unbranched code path for both sources: source asymmetries are
 * expressed by the entity interface, not by `session.source` checks here.
 * `apiMessageCount`/`apiErrorCount` are PRESENT only where the harness has
 * the concept (see `SessionAnalysisCore` — absence means "no such concept",
 * never zero), so the Turns and Compact cells render presence-driven;
 * `toolCallCount`/`toolErrorCount` are core fields both sources populate.
 * The Total-cost subline is source-uniform: `totalUsage` folds in
 * descendant threads for both sources, so the delegated split from
 * `session.delegation` is the honest caption either way.
 */
export function StatStrip({ session }: Props) {
  const ref = sessionRefOf(session);
  const contextHref = sessionPath(ref, "context");
  // Both sources carry `delegation` (all-zero `subagents` when there's no
  // sub-agent forest) — see `@junrei/core`'s `delegation.ts`.
  const delegatedShare = formatDelegatedShare(session.delegation);
  const nestedSubagents = Math.max(0, session.subagentCount - session.subagents.length);

  return (
    <div className="b-strip mt16">
      <Cell label="Total cost" href={contextHref}>
        <div className="big mt8 amb">
          {formatUsd(session.totalUsage.costUsd)}
          {session.totalUsage.costIsComplete ? "" : "*"}
        </div>
        <div className="sub num">
          {formatUsd(session.delegation.subagents.costUsd ?? 0)} delegated
          {delegatedShare !== undefined && ` — ${delegatedShare}`}
        </div>
      </Cell>
      {session.apiMessageCount !== undefined ? (
        <Cell label="Turns / msgs" href={sessionPath(ref, "timeline")}>
          <div className="big mt8">
            {session.userTurnCount}
            <span className="mut" style={{ fontSize: "15px" }}>
              {" "}
              / {session.apiMessageCount}
            </span>
          </div>
          <div className="sub">user / API</div>
        </Cell>
      ) : (
        // No standalone Turns lens exists anymore (folded into Timeline's
        // turn-grouped spine — docs/roadmap.md's "Unified Timeline" Phase 2),
        // so this cell now opens the same place its Claude sibling above does.
        <Cell label="Turns" href={sessionPath(ref, "timeline")}>
          <div className="big mt8">{session.userTurnCount}</div>
          <div className="sub">user turns</div>
        </Cell>
      )}
      <Cell label="Cache hit" href={contextHref}>
        <div className="big mt8">{(cacheHitRate(session.totalUsage) * 100).toFixed(0)}%</div>
        <div className="sub">of input tokens</div>
      </Cell>
      <Cell label="Output tok" href={contextHref}>
        <div className="big mt8">{formatTokens(session.totalUsage.outputTokens)}</div>
        <div className="sub">all agents</div>
      </Cell>
      {session.apiErrorCount !== undefined ? (
        <Cell label="Compact / API err" href={contextHref}>
          <div className="big mt8">
            {session.compactions.length}
            <span className="mut" style={{ fontSize: "15px" }}>
              {" "}
              / {session.apiErrorCount}
            </span>
          </div>
          <div className="sub">boundaries / API</div>
        </Cell>
      ) : (
        <Cell label="Compact / tool err" href={contextHref}>
          <div className="big mt8">
            {session.compactions.length}
            <span className="mut" style={{ fontSize: "15px" }}>
              {" "}
              / {session.toolErrorCount}
            </span>
          </div>
          <div className="sub">boundaries / tool</div>
        </Cell>
      )}
      <Cell label="Subagents" href={sessionPath(ref, "orchestration")} last>
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
