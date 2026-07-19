import { Link } from "react-router";
import type { EvidenceSub } from "../../router.js";

const SUB_LABEL: Record<EvidenceSub, string> = {
  context: "Context & cost",
  files: "Files & skills",
  tools: "Tools",
};

interface Props {
  /** Which sub-tabs to show, in order — session shell passes context/files/tools; agent shell passes context/files. */
  subs: readonly EvidenceSub[];
  active: EvidenceSub;
  /** Href for each sub-tab — session vs. agent scope is decided by the caller. */
  buildHref: (sub: EvidenceSub) => string;
}

/**
 * Evidence lens (PR4) second-level sub-nav — the "Evidence ▸ Context & cost |
 * Files & skills | Tools" breadcrumb. Real anchor `href`s (via the caller's
 * `buildHref`), the same keyboard/link-navigable convention as `LensTabs` and
 * the Tools lens's own All|Bash sub-nav, so every sub-tab is a bookmarkable URL.
 * The Evidence lens is where internal ids (line numbers, tool_use_id) surface,
 * so keeping each detail lens one click apart here (rather than stacked on the
 * Story tab) is the point of the restructure.
 */
export function EvidenceSubNav({ subs, active, buildHref }: Props) {
  return (
    <div className="subnav">
      <span className="subnav-crumb">
        <span className="amb">Evidence</span> ▸
      </span>
      {subs.map((sub) => (
        <Link key={sub} className={sub === active ? "subtab on" : "subtab"} to={buildHref(sub)}>
          {SUB_LABEL[sub]}
        </Link>
      ))}
    </div>
  );
}
