import { Link } from "react-router";
import { CLAUDE_LENSES, LENS_LABEL, type Lens, sessionPath } from "../router.js";

interface LensTabsProps {
  project: string;
  id: string;
  active: Lens;
  /**
   * Overrides the href each tab links to — used by the agent detail shell
   * (L3) to scope the tabs to `agentPath(...)` instead of the session-level
   * `sessionPath(...)`. Defaults to the session-level path so every existing
   * caller (SessionShell) is unaffected.
   */
  buildPath?: (lens: Lens) => string;
  /**
   * Which lenses to render as tabs, in order — defaults to `CLAUDE_LENSES`
   * (the historical five-tab lineup). The Codex session shell passes
   * `CODEX_LENSES` instead, since Codex sessions have no subagent
   * tree/timeline/files data to back Orchestration/Timeline/Files & skills.
   */
  lenses?: readonly Lens[];
}

/** Persistent lens tab bar — see design-spec/01-shell.md (.b-tabs/.b-tab). */
export function LensTabs({
  project,
  id,
  active,
  buildPath,
  lenses = CLAUDE_LENSES,
}: LensTabsProps) {
  const toPath = buildPath ?? ((lens: Lens) => sessionPath(project, id, lens));
  return (
    <div className="b-tabs">
      {lenses.map((lens) => (
        <Link key={lens} to={toPath(lens)} className={lens === active ? "b-tab on" : "b-tab"}>
          {LENS_LABEL[lens]}
        </Link>
      ))}
    </div>
  );
}
