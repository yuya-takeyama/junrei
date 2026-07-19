import { Link } from "react-router";
import { LENS_LABEL, type Lens, SESSION_LENSES, type SessionRef, sessionPath } from "../router.js";

interface LensTabsProps {
  /** Session to link the tabs to — ignored when `buildPath` is given (the agent detail shell). */
  sessionRef?: SessionRef;
  active: Lens;
  /**
   * Overrides the href each tab links to — used by the agent detail shell
   * (L3) to scope the tabs to `agentPath(...)` instead of the session-level
   * `sessionPath(...)`. Defaults to the session-level path so every existing
   * caller (SessionShell) is unaffected.
   */
  buildPath?: (lens: Lens) => string;
  /**
   * Which lenses to render as tabs, in order — defaults to `SESSION_LENSES`
   * (Story / Orchestration / Evidence). The agent shell passes its own
   * (source-dependent) `agentLensesFor(source)` lineup, which omits the lenses
   * not built at the subagent level (PR4 removed the placeholder tabs).
   */
  lenses?: readonly Lens[];
}

/** Persistent lens tab bar — see design-spec/01-shell.md (.b-tabs/.b-tab). */
export function LensTabs({
  sessionRef,
  active,
  buildPath,
  lenses = SESSION_LENSES,
}: LensTabsProps) {
  const toPath =
    buildPath ??
    ((lens: Lens) => {
      if (sessionRef === undefined) {
        throw new Error("LensTabs: one of sessionRef/buildPath is required");
      }
      return sessionPath(sessionRef, lens);
    });
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
