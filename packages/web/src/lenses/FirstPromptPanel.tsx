import { useState } from "react";
import { type AnySessionJson, fetchRecordDetail } from "../api.js";
import type { SessionRef } from "../router.js";

interface Props {
  session: AnySessionJson;
  sessionRef: SessionRef;
  /** Scopes the record fetch to one subagent's sidecar transcript — set when this panel is
   *  reused for the agent-detail shell's "Launch prompt" strip (see AgentShell.tsx), same
   *  `agentId` its record slide-over already fetches with. Claude-only, like every other
   *  `agentId`-scoped fetch. */
  agentId?: string;
  /**
   * Overrides the `.lbl` text — the agent detail shell (L3) reuses this
   * component verbatim for its "Launch prompt" strip (design-spec/16), same
   * markup and behavior as the session-level "First prompt" strip.
   */
  label?: string;
}

/**
 * First-user-prompt strip — see design-spec/11-session-overview.md. Collapsed
 * by default (single-line, ellipsis-truncated preview); clicking expands the
 * `.ph` text in place.
 *
 * `session.firstUserPrompt` is truncated server-side (`PROMPT_PREVIEW_LIMIT`,
 * ~500 chars) with no accompanying truncation flag, so the preview alone
 * can't say whether it's complete. On first expand this fetches the full
 * text via the record API (keyed by `firstUserPromptLine`) and swaps it in
 * once it resolves; the fetch runs at most once (per mount) and its result
 * is cached in state, so collapsing/re-expanding never refetches. Failure
 * just leaves the truncated preview showing — this is a best-effort upgrade,
 * not a load the panel depends on.
 */
export function FirstPromptPanel({ session, sessionRef, agentId, label = "First prompt" }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [fullText, setFullText] = useState<string | undefined>(undefined);
  const [fetchStarted, setFetchStarted] = useState(false);
  if (session.firstUserPrompt === undefined) return null;

  const handleClick = () => {
    setExpanded((v) => !v);
    if (!fetchStarted && session.firstUserPromptLine !== undefined) {
      setFetchStarted(true);
      fetchRecordDetail(sessionRef, session.firstUserPromptLine, agentId)
        .then((result) => {
          if ("detail" in result && result.detail.kind === "user") {
            setFullText(result.detail.text);
          }
        })
        .catch(() => {
          // Best-effort upgrade — keep showing the truncated preview on failure.
        });
    }
  };

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
        onClick={handleClick}
        aria-expanded={expanded}
      >
        <span className="amb mono fs11" style={{ paddingTop: expanded ? "1px" : 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="lbl noshrink" style={{ paddingTop: expanded ? "2px" : 0 }}>
          {label}
        </span>
        <span className={expanded ? "ph f1 expanded" : "ph f1"}>
          {fullText ?? session.firstUserPrompt}
        </span>
        {session.firstUserPromptLine !== undefined && (
          <span className="ln">L{session.firstUserPromptLine}</span>
        )}
      </button>
    </div>
  );
}
