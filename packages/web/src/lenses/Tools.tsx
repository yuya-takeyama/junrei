import { Link } from "react-router";
import type { AnySessionJson, SessionRef } from "../api.js";
import { sessionPath, type ToolsSubTab } from "../router.js";
import { Bash } from "./Bash.js";
import { AllView } from "./tools/AllView.js";
import { bashSubTabCostHint } from "./tools/toolsLensFormat.js";

interface Props {
  session: AnySessionJson;
  sessionRef: SessionRef;
  sub: ToolsSubTab;
  /** Opens the record slide-over (L3) for a source line — threaded to the Bash sub-tab and the All heavy hitters. `agentId` scopes the fetch to a subagent's own transcript. */
  onOpenRecord?: (line: number, agentId?: string) => void;
}

/**
 * Second-level sub-nav for the Tools lens — the "TOOLS ▸ ALL | BASH"
 * breadcrumb + the two sub-tab anchors, an amber-underlined active state, a
 * `~$` cost hint next to the Bash tab, and a right-aligned scope hint. Real
 * anchor `href`s (via `sessionPath`), not `onClick`-only — same
 * keyboard/link-navigable convention as `LensTabs`, so every sub-tab is a
 * bookmarkable URL (`/session/.../tools` and `/session/.../tools/bash`).
 */
function ToolsSubNav({
  sessionRef,
  sub,
  bashCost,
  subagentCount,
}: {
  sessionRef: SessionRef;
  sub: ToolsSubTab;
  bashCost: string | undefined;
  subagentCount: number;
}) {
  const scopeHint =
    sub === "bash"
      ? "cross-thread · command-level detail"
      : subagentCount > 0
        ? `cross-thread · main + ${subagentCount} subagent${subagentCount === 1 ? "" : "s"}`
        : "cross-thread · single thread";

  return (
    <div className="subnav">
      <span className="subnav-crumb">
        <span className="amb">Tools</span> ▸
      </span>
      <Link
        className={sub === "all" ? "subtab on" : "subtab"}
        to={sessionPath(sessionRef, "tools", "all")}
      >
        All
      </Link>
      <Link
        className={sub === "bash" ? "subtab on" : "subtab"}
        to={sessionPath(sessionRef, "tools", "bash")}
      >
        Bash
      </Link>
      {bashCost !== undefined && <span className="subcost">{bashCost}</span>}
      <span className="subnav-hint">{scopeHint}</span>
    </div>
  );
}

/**
 * Tools lens (L2) — a two-sub-tab shell over the session's cross-tool
 * analytics. "All" (`AllView`) ranks every tool the session called by est $;
 * "Bash" re-homes the former standalone Bash lens's command-level detail
 * (`Bash`, mounted UNCHANGED — only its location moved). The sub-tab is chosen
 * by the `sub` prop, resolved from the URL's `:sub?` segment (SessionShell);
 * `/bash` legacy bookmarks land on the Bash sub-tab (see router.ts).
 *
 * Stays a pure function component (no hooks) so the repo's call-it-directly
 * component tests can walk its dispatch tree — the per-sub-tab UI state lives
 * inside `AllView`/`Bash`, not here.
 */
export function Tools({ session, sessionRef, sub, onOpenRecord }: Props) {
  const subagentCount = session.toolUsageStats.byThread.filter((t) => t.thread !== "main").length;

  return (
    <>
      <div className="hpad">
        <ToolsSubNav
          sessionRef={sessionRef}
          sub={sub}
          bashCost={bashSubTabCostHint(session.bashStats.totals)}
          subagentCount={subagentCount}
        />
      </div>
      {sub === "bash" ? (
        <Bash session={session} {...(onOpenRecord !== undefined && { onOpenRecord })} />
      ) : (
        <AllView
          session={session}
          sessionRef={sessionRef}
          {...(onOpenRecord !== undefined && { onOpenRecord })}
        />
      )}
    </>
  );
}
