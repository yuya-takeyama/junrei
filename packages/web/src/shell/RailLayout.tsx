import type { ReactNode } from "react";
import { Link } from "react-router";
import { NAV_ITEMS, type NavKey } from "../router.js";
import { ThemeToggle } from "./ThemeToggle.js";

/**
 * Left nav rail + main content shell for the three top-level L0 screens —
 * Briefing (`/`), Sessions (`/sessions`), Learnings (`/learnings`) — per the
 * PR3 IA (Pattern A/B's nav rail). Session/agent detail keep the top `Band`
 * (PR4 restructures those), so this deliberately isn't hoisted into the root
 * `App` layout; each L0 page wraps its own content in `<RailLayout active=…>`.
 *
 * The rail carries the JUNREI wordmark, the three destinations (amber active
 * marker), the `local · ~/.claude · ~/.codex` provenance footer, and the theme
 * toggle. On a narrow viewport the rail collapses to a horizontal top bar
 * (`.rail-layout` flips to a column) so the content keeps the full width.
 */
export function RailLayout({ active, children }: { active: NavKey; children: ReactNode }) {
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
