import { useState } from "react";
import { fetchRecordDetail, type RecordDetail, type SessionRef } from "../../api.js";

/** The three timeline entry kinds truncated server-side (700 chars — see `truncate()` in
 *  `@junrei/core`'s shared/timeline.ts) and therefore eligible for this inline toggle. */
type ExpandableKind = "user" | "assistant-text" | "thinking";

interface Props {
  sessionRef: SessionRef;
  /** Scopes the record fetch to one subagent's sidecar transcript — mirrors `Timeline`'s own `agent` prop. */
  agent: string | undefined;
  line: number;
  kind: ExpandableKind;
  /** The (possibly truncated) preview text already on the timeline entry — shown until expanded. */
  text: string;
  truncated: boolean;
}

/**
 * Narrows a fetched `RecordDetail` to the matching kind's full text. Compares against literal
 * kind strings (rather than the generic `detail.kind === kind`) so each branch actually narrows
 * `detail` for TypeScript — an equality check against a union-typed variable doesn't. Returns
 * `undefined` if the detail turned out to be some other kind, which shouldn't happen for a
 * stable line but the record API is keyed by line number alone, so stay defensive.
 */
function extractFullText(detail: RecordDetail, kind: ExpandableKind): string | undefined {
  switch (kind) {
    case "user":
      return detail.kind === "user" ? detail.text : undefined;
    case "assistant-text":
      return detail.kind === "assistant-text" ? detail.text : undefined;
    case "thinking":
      return detail.kind === "thinking" ? detail.text : undefined;
  }
}

/**
 * Renders one truncated timeline block's text plus, when `truncated`, the inline "show full
 * text" toggle that lazily fetches the untruncated text (via the L3 record API) and swaps it in
 * — shared by UserBlock/AssistantBlock/ThinkingBlock (TimelineRow.tsx) so the fetch/cache/toggle
 * state lives in one place instead of three. The fetched text is cached in state, so collapsing
 * and re-expanding never refetches; a 404 or thrown error permanently swaps the toggle for a
 * muted "unavailable" note instead of leaving a dead retry button.
 */
export function ExpandableText({ sessionRef, agent, line, kind, text, truncated }: Props) {
  const [cache, setCache] = useState<string | "unavailable" | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  // Narrowed inline (rather than via a separate `showFull` boolean derived from `cache`) so
  // TypeScript actually treats this as `string | undefined` below.
  const fullText = expanded && cache !== undefined && cache !== "unavailable" ? cache : undefined;
  const showFull = fullText !== undefined;

  const handleToggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (cache !== undefined && cache !== "unavailable") {
      setExpanded(true);
      return;
    }
    if (loading) return;
    setLoading(true);
    fetchRecordDetail(sessionRef, line, agent)
      .then((result) => {
        setLoading(false);
        if ("notFound" in result) {
          setCache("unavailable");
          return;
        }
        const fetched = extractFullText(result.detail, kind);
        if (fetched === undefined) {
          setCache("unavailable");
          return;
        }
        setCache(fetched);
        setExpanded(true);
      })
      .catch(() => {
        setLoading(false);
        setCache("unavailable");
      });
  };

  return (
    <>
      <div className={showFull ? "btxt full" : "btxt"}>{fullText ?? text}</div>
      {truncated &&
        (cache === "unavailable" ? (
          <div className="mono fs10 mut mt8">full text unavailable</div>
        ) : (
          <button
            type="button"
            className="mono fs10 mut mt8 exp-toggle"
            onClick={handleToggle}
            disabled={loading}
            aria-expanded={showFull}
          >
            {loading ? "loading…" : showFull ? "▾ show less" : "▸ show full text"}
          </button>
        ))}
    </>
  );
}
