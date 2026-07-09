import { Link } from "react-router";
import { type Lens, sessionPath } from "../router.js";

const TABS: ReadonlyArray<{ lens: Lens; label: string }> = [
  { lens: "overview", label: "Overview" },
  { lens: "timeline", label: "Timeline" },
  { lens: "orchestration", label: "Orchestration" },
  { lens: "context", label: "Context & cost" },
  { lens: "files", label: "Files & skills" },
];

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
}

/** Persistent lens tab bar — see design-spec/01-shell.md (.b-tabs/.b-tab). */
export function LensTabs({ project, id, active, buildPath }: LensTabsProps) {
  const toPath = buildPath ?? ((lens: Lens) => sessionPath(project, id, lens));
  return (
    <div className="b-tabs">
      {TABS.map((tab) => (
        <Link
          key={tab.lens}
          to={toPath(tab.lens)}
          className={tab.lens === active ? "b-tab on" : "b-tab"}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
