import type { ReactNode } from "react";
import { Link } from "react-router";
import { NAV_ITEMS, type NavKey } from "../router.js";
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
 * The rail carries the JUNREI wordmark, the three destinations (amber active
 * marker), the `local · ~/.claude · ~/.codex` provenance footer, and the theme
 * toggle. On a narrow viewport the rail collapses to a horizontal top bar
 * (`.rail-layout` flips to a column) so the content keeps the full width.
 */
export function RailLayout({ active, children }: { active: NavKey | null; children: ReactNode }) {
  return (
    <div className="rail-layout">
      <nav className="rail" aria-label="Primary">
        <Link to="/" className="wm mono rail-wm">
          JUNREI
        </Link>
        <div className="rail-nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              to={item.path}
              className={item.key === active ? "rail-item on" : "rail-item"}
              aria-current={item.key === active ? "page" : undefined}
            >
              {item.label}
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
