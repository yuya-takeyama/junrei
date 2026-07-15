import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AnySessionJson, fetchTimeline, type SessionRef, type TimelineEntry } from "../api.js";
import { MiniMap } from "./timeline/MiniMap.js";
import { StepsRow } from "./timeline/StepsRow.js";
import { TimelineRow } from "./timeline/TimelineRow.js";
import { TurnMiniMap } from "./timeline/TurnMiniMap.js";
import { TurnGroupHeaderRow, TurnRow } from "./timeline/TurnRow.js";
import {
  type ChipState,
  computeChipCounts,
  DEFAULT_CHIPS,
  type DetailDial,
  DIAL_STOPS,
  isEntryVisible,
  toggleChip,
} from "./timeline/timelineFilters.js";
import { turnGridTemplate, visibleTurnColumns } from "./timeline/turnColumns.js";
import {
  buildClaudeTurnGroups,
  buildCodexTurnGroups,
  isOutlierTurn,
  sumTurnCosts,
  type TurnGroup,
  turnsUpToBudget,
} from "./timeline/turnGroups.js";

interface Props {
  sessionRef: SessionRef;
  /** Scopes the timeline to one subagent's own transcript, when set (see AgentShell.tsx). Claude-only. */
  agent?: string;
  /**
   * The full session analysis, either source — passed by SessionShell for the
   * main-transcript view only (AgentShell never passes it, so subagent views
   * always keep the flat rendering below). Enables the turn-grouped spine
   * (see `turnGroups.ts` and docs/roadmap.md's "Unified Timeline") whenever
   * the session's own per-turn data is non-empty: Claude's `turnUsage` or
   * Codex's `codex.turns`, picked by presence, not by `source ===` (see
   * `turnGroupable`/`turnGroups` below).
   */
  session?: AnySessionJson;
  /** Opens the record slide-over (L3, screen 8) for a given source line. */
  onOpenRecord: (line: number) => void;
}

/** Entries are rendered in chunks so a 2000+-entry session doesn't force one giant paint. */
const CHUNK_SIZE = 500;

const DIAL_LABEL: Record<DetailDial, string> = {
  turns: "turns",
  "user-only": "user-only",
  minimal: "minimal",
  full: "full",
};

const CHIP_ORDER: ReadonlyArray<{ key: keyof ChipState; label: string; tone?: "err" | "amb" }> = [
  { key: "user", label: "user" },
  { key: "assistant", label: "assistant" },
  { key: "thinking", label: "thinking" },
  { key: "tool", label: "tool" },
  { key: "subagent", label: "subagent" },
  { key: "error", label: "error", tone: "err" },
  { key: "compaction", label: "compaction", tone: "amb" },
];

/**
 * Timeline lens (L2) — the full-transcript view. See design-spec/12-timeline.md.
 *
 * The main transcript (not a `?agent=` subagent view) renders as a
 * turn-grouped spine whenever the session carries per-turn data for its own
 * source — Claude's `turnUsage` or Codex's `codex.turns` — see
 * `turnGroups.ts`/`TurnRow.tsx` and docs/roadmap.md's "Unified Timeline".
 * `turnGroupable` is presence-driven, not a `source ===` branch: it narrows
 * the discriminated `session` union to pick whichever field its own source
 * actually populates. Subagent views render the original flat list unchanged
 * for the same reason (no per-turn data is ever passed in — see `Props`),
 * reusing `TimelineRow` either way so tool expansion / the time gutter /
 * record-detail links never diverge between the two paths.
 *
 * Perf: no virtualization — collapsed-by-default blocks plus chunked
 * rendering (500 entries at a time, "show more" to extend, landing on a
 * whole-turn boundary in the grouped path — see `turnsUpToBudget`) keep the
 * DOM light even for 2000+-entry sessions; hover reveals the source line via
 * pure CSS (`.blk:hover .ln`) so it never touches React state, and each row
 * is wrapped in `memo` so toggling one tool-call's expansion doesn't
 * re-render its siblings.
 */
export function Timeline({ sessionRef, agent, session, onOpenRecord }: Props) {
  const turnGroupable =
    agent === undefined &&
    session !== undefined &&
    ((session.source === "claude-code" && session.turnUsage.length > 0) ||
      (session.source === "codex" && session.codex.turns.length > 0));

  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dial, setDial] = useState<DetailDial>(() => (turnGroupable ? "turns" : "full"));
  const [chips, setChips] = useState<ChipState>(DEFAULT_CHIPS);
  const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(new Set());
  // Per-turn expand/collapse overrides against the dial's own default (see
  // `isTurnExpanded` below) — keyed by turn line, cleared whenever the dial
  // changes so switching stops always starts from that stop's own default.
  const [turnOverrides, setTurnOverrides] = useState<ReadonlySet<number>>(new Set());
  // Per-turn StepsRow expansion (anchorLine keys, same as turnOverrides) —
  // collapsed by default for every turn. Cleared any time turnOverrides is
  // (dial change, session switch) and any time a SPECIFIC turn collapses
  // (see `handleTurnRowClick`/`collapseAll` below), so a turn's steps always
  // start collapsed again the next time that turn re-expands — "collapsing a
  // turn resets its steps state" (mock 2i).
  const [expandedStepsLines, setExpandedStepsLines] = useState<ReadonlySet<number>>(new Set());
  const [visibleCount, setVisibleCount] = useState(CHUNK_SIZE);
  const [pendingScrollLine, setPendingScrollLine] = useState<number | null>(null);
  // Mirrors `pendingScrollLine`, but for a turn header's `anchorLine` rather
  // than an entry's own line — see `handleTurnMiniMapSelect` below.
  const [pendingScrollTurnLine, setPendingScrollTurnLine] = useState<number | null>(null);

  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  // Turn header buttons, keyed by `anchorLine` — always mounted regardless of
  // expand state, unlike `rowRefs` above (entries only mount once their turn
  // is expanded). This is what lets the turn-aware minimap scroll into a
  // *collapsed* turn instead of silently no-op'ing (the Phase-1 gap).
  const turnRowRefs = useRef(new Map<number, HTMLButtonElement>());
  // The turn-grouped rows' own wrapper — the turn-aware minimap's viewport
  // indicator measures this element's real rendered height (see
  // TurnMiniMap.tsx), which changes as turns expand/collapse or "show more
  // turns" loads another chunk. Unused (stays null) on the flat path.
  const turnColumnRef = useRef<HTMLDivElement>(null);
  // Root wrapper (holds `--tctl-h`, read by `.exh` in styles.css) and the
  // controls bar whose real height feeds it — see the ResizeObserver effect
  // below.
  const rootRef = useRef<HTMLDivElement>(null);
  const tctlRef = useRef<HTMLDivElement>(null);

  // `sessionRef` is rebuilt fresh (a new object) on every caller render —
  // depend on its primitive parts instead so this effect doesn't re-fire
  // every render just because the caller re-rendered for an unrelated reason.
  const refSource = sessionRef.source;
  const refId = sessionRef.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on sessionRef's primitive parts (see comment above), not the object itself.
  useEffect(() => {
    setEntries(null);
    setError(null);
    setTurnOverrides(new Set());
    setExpandedStepsLines(new Set());
    fetchTimeline(sessionRef, agent)
      .then(setEntries)
      .catch((e: unknown) => setError(String(e)));
  }, [refSource, refId, agent]);

  const counts = useMemo(() => computeChipCounts(entries ?? []), [entries]);

  const filteredEntries = useMemo(() => {
    if (entries === null) return [];
    return entries.filter((e) => isEntryVisible(e, dial, chips));
  }, [entries, dial, chips]);

  const turnGroups = useMemo<TurnGroup[]>(() => {
    if (!turnGroupable || entries === null || session === undefined) return [];
    // Discriminated-union narrow, not a capability lookup: which adapter
    // runs follows directly from which field `turnGroupable` above found
    // non-empty.
    return session.source === "claude-code"
      ? buildClaudeTurnGroups(entries, session.turnUsage, {
          costIsComplete: session.totalUsage.costIsComplete,
        })
      : buildCodexTurnGroups(entries, session.codex.turns);
  }, [entries, turnGroupable, session]);

  // Presence-driven: which numeric columns actually show for this group set,
  // and the grid template derived from them — computed once here rather than
  // per row (see turnColumns.ts).
  const turnColumns = useMemo(() => visibleTurnColumns(turnGroups), [turnGroups]);
  const turnGridTemplateColumns = useMemo(() => turnGridTemplate(turnColumns), [turnColumns]);

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

  const registerTurnRef = useCallback((line: number, el: HTMLButtonElement | null) => {
    if (el === null) turnRowRefs.current.delete(line);
    else turnRowRefs.current.set(line, el);
  }, []);

  // Mirrors `handleMiniMapSelect` above for the turn-aware minimap: a turn
  // not yet in the rendered chunk gets pulled in (budgeted by
  // `turnsUpToBudget` so the boundary still lands on a whole turn, not
  // mid-turn) before scrolling, once its header mounts.
  const handleTurnMiniMapSelect = useCallback(
    (anchorLine: number) => {
      const groupIndex = turnGroups.findIndex((g) => g.anchorLine === anchorLine);
      if (groupIndex === -1) return;
      const visibleTurns = turnsUpToBudget(turnGroups, visibleCount);
      if (groupIndex >= visibleTurns) {
        const entriesThroughTarget = turnGroups
          .slice(0, groupIndex + 1)
          .reduce((sum, g) => sum + g.entries.length, 0);
        setVisibleCount((v) => Math.max(v, entriesThroughTarget));
        setPendingScrollTurnLine(anchorLine);
      } else {
        turnRowRefs.current
          .get(anchorLine)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [turnGroups, visibleCount],
  );

  useEffect(() => {
    if (pendingScrollTurnLine === null) return;
    const el = turnRowRefs.current.get(pendingScrollTurnLine);
    if (el !== undefined) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setPendingScrollTurnLine(null);
    }
  }, [pendingScrollTurnLine]);

  // "turns" is only ever offered when the turn-grouped path is active — the
  // flat (Codex / subagent) path keeps its pre-existing 3-stop dial exactly
  // as before, both in the UI and in what keys 1-3 map to.
  const dialStopsForView = useMemo(
    () => (turnGroupable ? DIAL_STOPS : DIAL_STOPS.filter((stop) => stop !== "turns")),
    [turnGroupable],
  );

  const handleDialChange = useCallback((next: DetailDial) => {
    setDial(next);
    setTurnOverrides(new Set());
    setExpandedStepsLines(new Set());
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && /^(input|textarea)$/i.test(target.tagName)) return;
      const idx = Number.parseInt(e.key, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= dialStopsForView.length) return;
      const stop = dialStopsForView[idx];
      if (stop !== undefined) handleDialChange(stop);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialStopsForView, handleDialChange]);

  // `.exh` (the expanded turn's sticky header) parks just below the controls
  // bar via `--tctl-h` — measured here rather than hardcoded, since the bar's
  // height changes when its chips wrap (narrow widths) or the "turns"-only
  // dial note appears/disappears. ResizeObserver (not a one-off measurement)
  // because both of those can happen without an unmount/remount. Also
  // retriggers on `entries`: while `entries === null` the component returns
  // the loading-state div below, so the refs are still null the first time
  // `turnGroupable` goes true — this needs a second pass once the real tree
  // (and its refs) mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries is a retrigger, not read below
  useLayoutEffect(() => {
    if (!turnGroupable) return;
    const bar = tctlRef.current;
    const root = rootRef.current;
    if (bar === null || root === null) return;
    const applyHeight = () => {
      root.style.setProperty(
        "--tctl-h",
        `${String(Math.round(bar.getBoundingClientRect().height))}px`,
      );
    };
    applyHeight();
    const observer = new ResizeObserver(applyHeight);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [turnGroupable, entries]);

  // "turns" collapses every turn to its header by default; every other stop
  // expands every turn by default. A row click/Enter toggles that one turn
  // AGAINST the current default, tracked in `turnOverrides` rather than a
  // plain "expanded" set, so a dial change can reset every turn to its new
  // default by simply clearing the override map.
  const defaultTurnExpanded = dial !== "turns";
  const isTurnExpanded = useCallback(
    (line: number) => (turnOverrides.has(line) ? !defaultTurnExpanded : defaultTurnExpanded),
    [turnOverrides, defaultTurnExpanded],
  );
  const toggleTurn = useCallback((line: number) => {
    setTurnOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }, []);

  const toggleSteps = useCallback((line: number) => {
    setExpandedStepsLines((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }, []);

  // Turn-row click dispatch: a plain click keeps today's toggle behavior; an
  // ⌥-click (mock 2i) forces the turn AND its steps open in one gesture
  // instead of merely toggling. `wasExpanded` is the row's own already-
  // computed `isTurnExpanded` result (passed in at the render call site
  // below) — cheaper than re-deriving it here, and it's what lets a plain
  // click reset a turn's steps back to collapsed the moment that turn itself
  // collapses, per the mock's interaction note.
  const handleTurnRowClick = useCallback(
    (line: number, altKey: boolean, wasExpanded: boolean) => {
      if (altKey) {
        setTurnOverrides((prev) => {
          // Force-expand: only needs an override entry when the dial's own
          // default is "collapsed" for this stop.
          const needsOverride = !defaultTurnExpanded;
          if (prev.has(line) === needsOverride) return prev;
          const next = new Set(prev);
          if (needsOverride) next.add(line);
          else next.delete(line);
          return next;
        });
        setExpandedStepsLines((prev) => (prev.has(line) ? prev : new Set(prev).add(line)));
        return;
      }
      toggleTurn(line);
      if (wasExpanded) {
        setExpandedStepsLines((prev) => {
          if (!prev.has(line)) return prev;
          const next = new Set(prev);
          next.delete(line);
          return next;
        });
      }
    },
    [defaultTurnExpanded, toggleTurn],
  );

  const anyTurnCollapsed = turnGroups.some((g) => !isTurnExpanded(g.anchorLine));
  const expandAll = useCallback(() => {
    setTurnOverrides(
      defaultTurnExpanded ? new Set() : new Set(turnGroups.map((g) => g.anchorLine)),
    );
  }, [defaultTurnExpanded, turnGroups]);
  const collapseAll = useCallback(() => {
    setTurnOverrides(
      defaultTurnExpanded ? new Set(turnGroups.map((g) => g.anchorLine)) : new Set(),
    );
    // Every turn ends up collapsed — reset every turn's steps state too.
    setExpandedStepsLines(new Set());
  }, [defaultTurnExpanded, turnGroups]);

  // Chips only act inside expanded turns (collapsed rows show nothing to
  // filter) — once every turn reads as collapsed, the chip row itself would
  // be inert, so it's replaced by a note explaining why (mock panel 2b).
  const allTurnsCollapsed = turnGroupable && dial === "turns" && turnOverrides.size === 0;

  if (error !== null) {
    return <div className="hpad mt16 mut">Failed to load timeline: {error}</div>;
  }
  if (entries === null) {
    return <div className="hpad mt16 mut">Loading timeline…</div>;
  }

  const totalTurnCostUsd = sumTurnCosts(turnGroups);
  const visibleTurnCount = turnGroupable ? turnsUpToBudget(turnGroups, visibleCount) : 0;
  const displayedTurnGroups = turnGroups.slice(0, visibleTurnCount);
  const remainingTurns = turnGroups.length - displayedTurnGroups.length;
  const totalTurnEntries = turnGroups.reduce((sum, g) => sum + g.entries.length, 0);

  const displayedEntries = filteredEntries.slice(0, visibleCount);
  const remainingFlatEntries = filteredEntries.length - displayedEntries.length;

  return (
    <div ref={rootRef}>
      <div
        ref={tctlRef}
        className={turnGroupable ? "hpad fx ac jb mt12 tctl" : "hpad fx ac jb mt12"}
        style={{ flexWrap: "wrap", gap: "10px" }}
      >
        <div className="fx ac gap12">
          <span className="lbl">Detail</span>
          <div className="dial">
            {dialStopsForView.map((stop) => (
              <button
                key={stop}
                type="button"
                className={stop === dial ? "dseg on" : "dseg"}
                onClick={() => handleDialChange(stop)}
              >
                {DIAL_LABEL[stop]}
              </button>
            ))}
          </div>
          {turnGroupable && <span className="ann">keys 1–4 · click a row · ⌥-click row+steps</span>}
        </div>
        <div className="fx ac gap8" style={{ flexWrap: "wrap" }}>
          {allTurnsCollapsed ? (
            <span className="chip mut" style={{ opacity: 0.55 }}>
              chips apply inside expanded turns
            </span>
          ) : (
            CHIP_ORDER.map(({ key, label, tone }) => (
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
            ))
          )}
          {turnGroupable && (
            <button
              type="button"
              className="chip amb"
              style={{ borderStyle: "solid", borderColor: "var(--amb)" }}
              onClick={anyTurnCollapsed ? expandAll : collapseAll}
            >
              {anyTurnCollapsed ? "expand all ▾" : "collapse all ▴"}
            </button>
          )}
        </div>
      </div>

      <div className="hpad fx gap16 mt16">
        {/* Turn-grouped rows form a dense table (flush `.trow`s, separated only
            by their own border-bottom, like `.cmg`/`.tn` elsewhere) — no inter-row
            gap, unlike the flat path's spaced-out `.tlrow` blocks. */}
        <div
          className="col f1"
          style={{ gap: turnGroupable ? 0 : "10px", minWidth: 0 }}
          ref={turnGroupable ? turnColumnRef : undefined}
        >
          {turnGroupable ? (
            <>
              <TurnGroupHeaderRow columns={turnColumns} gridTemplate={turnGridTemplateColumns} />
              {displayedTurnGroups.map((group) => {
                const expanded = isTurnExpanded(group.anchorLine);
                const isOutlier = isOutlierTurn(group.costUsd, totalTurnCostUsd);
                // Collapsed turns still surface their compactions as a
                // full-width sibling row right after the header — a
                // compaction must never silently disappear just because its
                // turn is collapsed (mock panel 2b).
                const collapsedCompactions = expanded
                  ? []
                  : group.entries.filter((e) => e.kind === "compaction");
                const visibleTurnEntries = expanded
                  ? group.entries.filter((e) => isEntryVisible(e, dial, chips))
                  : [];

                return (
                  <div key={`turn-${String(group.anchorLine)}`}>
                    <TurnRow
                      group={group}
                      columns={turnColumns}
                      gridTemplate={turnGridTemplateColumns}
                      expanded={expanded}
                      isOutlier={isOutlier}
                      onToggle={(line, altKey) => handleTurnRowClick(line, altKey, expanded)}
                      registerRef={registerTurnRef}
                    />
                    {collapsedCompactions.map((entry, i) => (
                      <TimelineRow
                        key={`${entry.kind}-${String(entry.line)}-${String(i)}`}
                        entry={entry}
                        sessionRef={sessionRef}
                        agent={agent}
                        expanded={false}
                        onToggleExpand={onToggleExpand}
                        registerRef={registerRef}
                        onOpenRecord={onOpenRecord}
                      />
                    ))}
                    {expanded && (
                      <div className="ex">
                        {group.steps !== undefined && group.steps.length > 0 && (
                          <StepsRow
                            steps={group.steps}
                            mixedModel={group.models.length > 1}
                            expanded={expandedStepsLines.has(group.anchorLine)}
                            onToggle={() => toggleSteps(group.anchorLine)}
                          />
                        )}
                        {visibleTurnEntries.length === 0 ? (
                          <div className="mut fs12" style={{ padding: "8px 0" }}>
                            No entries match the current filters.
                          </div>
                        ) : (
                          visibleTurnEntries.map((entry, i) => (
                            <TimelineRow
                              key={`${entry.kind}-${String(entry.line)}-${String(i)}`}
                              entry={entry}
                              sessionRef={sessionRef}
                              agent={agent}
                              expanded={expandedLines.has(entry.line)}
                              onToggleExpand={onToggleExpand}
                              registerRef={registerRef}
                              onOpenRecord={onOpenRecord}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {remainingTurns > 0 && (
                <button
                  type="button"
                  className="chip"
                  style={{ alignSelf: "flex-start", marginTop: "10px" }}
                  onClick={() => setVisibleCount((v) => Math.min(totalTurnEntries, v + CHUNK_SIZE))}
                >
                  Show more turns ({remainingTurns} remaining)
                </button>
              )}
            </>
          ) : filteredEntries.length === 0 ? (
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
              {remainingFlatEntries > 0 && (
                <button
                  type="button"
                  className="chip"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    setVisibleCount((v) => Math.min(filteredEntries.length, v + CHUNK_SIZE))
                  }
                >
                  Show {Math.min(remainingFlatEntries, CHUNK_SIZE)} more ({remainingFlatEntries}{" "}
                  remaining)
                </button>
              )}
            </>
          )}
        </div>
        {turnGroupable ? (
          <TurnMiniMap
            groups={turnGroups}
            totalCostUsd={totalTurnCostUsd}
            containerRef={turnColumnRef}
            onSelectTurn={handleTurnMiniMapSelect}
          />
        ) : (
          <MiniMap entries={filteredEntries} onSelect={handleMiniMapSelect} />
        )}
      </div>
    </div>
  );
}
