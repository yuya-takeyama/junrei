import { useState } from "react";
import type { SessionJson } from "../api.js";

interface Props {
  session: SessionJson;
}

/**
 * First-user-prompt strip — see design-spec/11-session-overview.md. Collapsed
 * by default (single-line, ellipsis-truncated preview); clicking expands the
 * `.ph` text in place.
 */
export function FirstPromptPanel({ session }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (session.firstUserPrompt === undefined) return null;

  return (
    <div className="hpad mt16">
      <button
        type="button"
        className="pan fx gap12"
        style={{
          padding: "12px 20px",
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          alignItems: expanded ? "flex-start" : "center",
        }}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="amb mono fs11" style={{ paddingTop: expanded ? "1px" : 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="lbl noshrink" style={{ paddingTop: expanded ? "2px" : 0 }}>
          First prompt
        </span>
        <span className={expanded ? "ph f1 expanded" : "ph f1"}>{session.firstUserPrompt}</span>
        {session.firstUserPromptLine !== undefined && (
          <span className="ln">L{session.firstUserPromptLine}</span>
        )}
      </button>
    </div>
  );
}
