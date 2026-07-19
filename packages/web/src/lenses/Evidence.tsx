import type { AnySessionJson, SessionRef } from "../api.js";
import {
  EVIDENCE_SUBS_SESSION,
  type EvidenceSub,
  sessionPath,
  type ToolsSubTab,
} from "../router.js";
import { ContextCost } from "./ContextCost.js";
import { EvidenceSubNav } from "./evidence/EvidenceSubNav.js";
import { FilesSkills } from "./FilesSkills.js";
import { Tools } from "./Tools.js";

interface Props {
  session: AnySessionJson;
  sessionRef: SessionRef;
  /** Active Evidence sub-tab (from the URL's `:sub?` segment). */
  sub: EvidenceSub;
  /** Active Tools All|Bash sub (from the `:sub2?` segment) — only meaningful when `sub === "tools"`. */
  toolsSub: ToolsSubTab;
  /** Opens the record slide-over (L3). `agentId` scopes the fetch to a subagent's own transcript (Tools heavy hitters). */
  onOpenRecord: (line: number, agentId?: string) => void;
}

/**
 * Evidence lens (L2, PR4) for the SESSION shell — hosts the three raw-detail
 * sub-tabs the old top-level lenses became: Context & cost (`ContextCost`),
 * Files & skills (`FilesSkills`), Tools (`Tools`, itself keeping its All|Bash
 * split). Every child renders exactly as before; only their home moved. This is
 * the one place internal ids (line numbers, tool_use_id) are exposed — the
 * Story tab stays conclusion-only.
 */
export function Evidence({ session, sessionRef, sub, toolsSub, onOpenRecord }: Props) {
  return (
    <>
      <div className="hpad mt16">
        <EvidenceSubNav
          subs={EVIDENCE_SUBS_SESSION}
          active={sub}
          buildHref={(s) => sessionPath(sessionRef, "evidence", s)}
        />
      </div>
      {sub === "context" && (
        <ContextCost
          session={session}
          contextHref={sessionPath(sessionRef, "evidence", "context")}
        />
      )}
      {sub === "files" && (
        <FilesSkills session={session} onOpenRecord={(line) => onOpenRecord(line)} />
      )}
      {sub === "tools" && (
        <Tools
          session={session}
          sessionRef={sessionRef}
          sub={toolsSub}
          onOpenRecord={onOpenRecord}
        />
      )}
    </>
  );
}
