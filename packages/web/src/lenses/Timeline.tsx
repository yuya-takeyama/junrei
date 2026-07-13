import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTimeline, type SessionRef, type TimelineEntry } from "../api.js";
import { MiniMap } from "./timeline/MiniMap.js";
import { TimelineRow } from "./timeline/TimelineRow.js";
import {
  type ChipState,
  computeChipCounts,
  DEFAULT_CHIPS,
  type DetailDial,
  DIAL_STOPS,
  isEntryVisible,
  toggleChip,
} from "./timeline/timelineFilters.js";

interface Props {
  sessionRef: SessionRef;
  /** Scopes the timeline to one subagent's own transcript, when set (see AgentShell.tsx). Claude-only. */
  agent?: string;
  /** Opens the record slide-over (L3, screen 8) for a given source line. */
  onOpenRecord: (line: number) => void;
}

/** Entries are rendered in chunks so a 2000+-entry session doesn't force one giant paint. */
const CHUNK_SIZE = 500;

const DIAL_LABEL: Record<DetailDial, string> = {
  "user-only": "user-only",
  minimal: "minimal",
  full: "full",
};

const CHIP_ORDER: ReadonlyArray<{ key: keyof ChipState; label: string; tone?: "err" | "amb" }> = [
  { key: "user", label: "user" },
  { key: "assistant", label: "assistant" },
  { key: "tool", label: "tool" },
  { key: "subagent", label: "subagent" },
  { key: "error", label: "error", tone: "err" },
  { key: "compaction", label: "compaction", tone: "amb" },
];

/**
 * Timeline lens (L2) — the full-transcript view. See design-spec/12-timeline.md.
 *
 * Perf: no virtualization — collapsed-by-default blocks plus chunked
 * rendering (500 entries at a time, "show more" to extend) keep the DOM
 * light even for 2000+-entry sessions; hover reveals the source line via
 * pure CSS (`.blk:hover .ln`) so it never touches React state, and each row
 * is wrapped in `memo` so toggling one tool-call's expansion doesn't
 * re-render its siblings.
 */
export function Timeline({ sessionRef, agent, onOpenRecord }: Props) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dial, setDial] = useState<DetailDial>("full");
  const [chips, setChips] = useState<ChipState>(DEFAULT_CHIPS);
  const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(new Set());
  const [visibleCount, setVisibleCount] = useState(CHUNK_SIZE);
  const [pendingScrollLine, setPendingScrollLine] = useState<number | null>(null);

  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  // `sessionRef` is rebuilt fresh (a new object) on every caller render —
  // depend on its primitive parts instead so this effect doesn't re-fire
  // every render just because the caller re-rendered for an unrelated reason.
  const refSource = sessionRef.source;
  const refProject = refSource === "claude-code" ? sessionRef.project : undefined;
  const refId = sessionRef.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on sessionRef's primitive parts (see comment above), not the object itself.
  useEffect(() => {
    setEntries(null);
    setError(null);
    fetchTimeline(sessionRef, agent)
      .then(setEntries)
      .catch((e: unknown) => setError(String(e)));
  }, [refSource, refProject, refId, agent]);

  const counts = useMemo(() => computeChipCounts(entries ?? []), [entries]);

  const filteredEntries = useMemo(() => {
    if (entries === null) return [];
    return entries.filter((e) => isEntryVisible(e, dial, chips));
  }, [entries, dial, chips]);

  // Dial/chip changes reshape the visible set — restart chunking from the top. dial/chips
  // only need to *trigger* this; their values aren't read in the effect body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    setVisibleCount(CHUNK_SIZE);
  }, [dial, chips]);

  const onToggleExpand = useCallback((line: number) => {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }, []);

  const registerRef = useCallback((line: number, el: HTMLDivElement | null) => {
    if (el === null) rowRefs.current.delete(line);
    else rowRefs.current.set(line, el);
  }, []);

  const handleMiniMapSelect = useCallback(
    (index: number) => {
      const target = filteredEntries[index];
      if (target === undefined) return;
      if (index >= visibleCount) {
        // Not rendered yet — pull it (plus a little headroom) into the chunk, then
        // scroll once its row mounts (see the effect below).
        setVisibleCount(Math.min(filteredEntries.length, index + 20));
        setPendingScrollLine(target.line);
      } else {
        rowRefs.current.get(target.line)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [filteredEntries, visibleCount],
  );

  useEffect(() => {
    if (pendingScrollLine === null) return;
    const el = rowRefs.current.get(pendingScrollLine);
    if (el !== undefined) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setPendingScrollLine(null);
    }
  }, [pendingScrollLine]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && /^(input|textarea)$/i.test(target.tagName)) return;
      if (e.key === "1") setDial("user-only");
      else if (e.key === "2") setDial("minimal");
      else if (e.key === "3") setDial("full");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (error !== null) {
    return <div className="hpad mt16 mut">Failed to load timeline: {error}</div>;
  }
  if (entries === null) {
    return <div className="hpad mt16 mut">Loading timeline…</div>;
  }

  const displayedEntries = filteredEntries.slice(0, visibleCount);
  const remaining = filteredEntries.length - displayedEntries.length;

  return (
    <div>
      <div className="hpad fx ac jb mt12" style={{ flexWrap: "wrap", gap: "10px" }}>
        <div className="fx ac gap12">
          <span className="lbl">Detail</span>
          <div className="dial">
            {DIAL_STOPS.map((stop) => (
              <button
                key={stop}
                type="button"
                className={stop === dial ? "dseg on" : "dseg"}
                onClick={() => setDial(stop)}
              >
                {DIAL_LABEL[stop]}
              </button>
            ))}
          </div>
        </div>
        <div className="fx ac gap8" style={{ flexWrap: "wrap" }}>
          {CHIP_ORDER.map(({ key, label, tone }) => (
            <button
              key={key}
              type="button"
              className={chips[key] ? "chip on" : "chip"}
              onClick={() => setChips((prev) => toggleChip(prev, key))}
            >
              {tone === undefined ? (
                <span>
                  {label} {counts[key]}
                </span>
              ) : (
                <span className={tone === "err" ? "errtx" : "amb"}>
                  {label} {counts[key]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="hpad fx gap16 mt16">
        <div className="col f1" style={{ gap: "10px", minWidth: 0 }}>
          {filteredEntries.length === 0 ? (
            <div className="mut">No entries match the current filters.</div>
          ) : (
            <>
              {displayedEntries.map((entry, i) => (
                <TimelineRow
                  // kind+line alone can collide: two subagent launches from one
                  // assistant message share a source line.
                  key={`${entry.kind}-${entry.line}-${String(i)}`}
                  entry={entry}
                  sessionRef={sessionRef}
                  agent={agent}
                  expanded={expandedLines.has(entry.line)}
                  onToggleExpand={onToggleExpand}
                  registerRef={registerRef}
                  onOpenRecord={onOpenRecord}
                />
              ))}
              {remaining > 0 && (
                <button
                  type="button"
                  className="chip"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    setVisibleCount((v) => Math.min(filteredEntries.length, v + CHUNK_SIZE))
                  }
                >
                  Show {Math.min(remaining, CHUNK_SIZE)} more ({remaining} remaining)
                </button>
              )}
            </>
          )}
        </div>
        <MiniMap entries={filteredEntries} onSelect={handleMiniMapSelect} />
      </div>
    </div>
  );
}
