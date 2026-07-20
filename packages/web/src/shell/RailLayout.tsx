import type { ReactNode } from "react";
import { Link } from "react-router";
import { NAV_ITEMS, type NavKey } from "../router.js";
import { useRailCollapsed } from "./railState.js";
import { ThemeToggle } from "./ThemeToggle.js";

/**
 * Left nav rail + main content shell for EVERY screen in the app — the three
 * top-level L0 pages (Briefing `/`, Sessions `/sessions`, Learnings
 * `/learnings`) per the PR3 IA (Pattern A/B's nav rail), and, as of the rail
 * layout hoist, every deep route too (session/agent detail keep their own
 * `Band` breadcrumb strip nested inside this shell's content area — see
 * SessionShell/AgentShell). Rendered once by the `RailShell` layout route
 * (see shell/RailShell.tsx / main.tsx) rather than per-page, so no screen can
 * double-wrap or omit it. `active` is `null` for a route `activeNavKey`
 * doesn't recognize — no nav item lights up.
 *
 * The rail carries the JUNREI wordmark (with a collapse/expand toggle next to
 * it), the three destinations (amber active marker), the `local · ~/.claude ·
 * ~/.codex` provenance footer, and the theme toggle. On a narrow viewport the
 * rail collapses to a horizontal top bar (`.rail-layout` flips to a column)
 * so the content keeps the full width.
 *
 * Collapse state is independent of that responsive top-bar behavior: it's a
 * user choice (persisted via `useRailCollapsed`, see railState.ts) that only
 * applies to the desktop side-rail layout. Each nav link always renders both
 * its full label and a first-letter fallback (`.rail-item-full` /
 * `.rail-item-letter`); CSS picks which one shows based on `.collapsed` and
 * the `max-width: 720px` media query, so a collapsed-on-desktop choice can't
 * leak into the mobile top bar even though the class stays on the root div.
 */
export function RailLayout({ active, children }: { active: NavKey | null; children: ReactNode }) {
  const [collapsed, toggleCollapsed] = useRailCollapsed();
  return (
    <div className={collapsed ? "rail-layout collapsed" : "rail-layout"}>
      <nav className="rail" aria-label="Primary">
        <div className="rail-head">
          <Link to="/" className="wm mono rail-wm">
            JUNREI
          </Link>
          <button
            type="button"
            className="rail-toggle mono"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
        <div className="rail-nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              to={item.path}
              className={item.key === active ? "rail-item on" : "rail-item"}
              aria-current={item.key === active ? "page" : undefined}
              title={item.label}
              aria-label={item.label}
            >
              <span className="rail-item-full">{item.label}</span>
              <span className="rail-item-letter" aria-hidden="true">
                {item.label.charAt(0)}
              </span>
            </Link>
          ))}
        </div>
        <div className="rail-foot mono">
          <span>local</span>
          <span>~/.claude</span>
          <span>~/.codex</span>
          <ThemeToggle />
        </div>
      </nav>
      <div className="rail-main">{children}</div>
    </div>
  );
}
