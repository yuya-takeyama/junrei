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
}

/** Persistent lens tab bar — see design-spec/01-shell.md (.b-tabs/.b-tab). */
export function LensTabs({ project, id, active }: LensTabsProps) {
  return (
    <div className="b-tabs">
      {TABS.map((tab) => (
        <Link
          key={tab.lens}
          to={sessionPath(project, id, tab.lens)}
          className={tab.lens === active ? "b-tab on" : "b-tab"}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
