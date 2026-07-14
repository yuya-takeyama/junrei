import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { joinClasses } from "./turnColumns.js";
import type { TurnGroup } from "./turnGroups.js";
import {
  deriveTurnBandFlags,
  layoutTurnBandHeights,
  turnTooltipLabel,
} from "./turnMiniMapLayout.js";

interface Props {
  groups: readonly TurnGroup[];
  totalCostUsd: number;
  /** The turn-list column's own wrapper (`Timeline.tsx`'s `.col.f1` div) — its
   * rendered height is the viewport indicator's coordinate space, and it
   * grows/shrinks as turns expand, collapse, or a new chunk loads. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Scrolls the given turn's header row into view — works even for a
   * collapsed turn, since the header button is always mounted (see
   * Timeline.tsx's `handleTurnMiniMapSelect`, which also pulls the turn into
   * the rendered chunk first if it isn't there yet). */
  onSelectTurn: (anchorLine: number) => void;
}

function bandClass(flags: ReturnType<typeof deriveTurnBandFlags>): string {
  return joinClasses(
    "mmap-tband",
    flags.isOutlier && "mmap-tband-outlier",
    flags.hasError && "mmap-tband-error",
    flags.hasCompaction && "mmap-tband-compaction",
  );
}

/**
 * Turn-aware minimap rail for the grouped Timeline (see `MiniMap.tsx` for the
 * flat per-entry rail the subagent/Codex-less paths still use unchanged).
 * One band per turn — sized by entry count, not by the turn's actual
 * (expand/collapse-dependent) rendered height, so the rail stays a stable
 * overview even while individual turns open and close. The amber viewport
 * box is the part that DOES need real DOM measurements (see the scroll
 * effect below), since it's showing the reader where they really are.
 */
export const TurnMiniMap = memo(function TurnMiniMap({
  groups,
  totalCostUsd,
  containerRef,
  onSelectTurn,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollY: number } | null>(null);

  // Track height: the rail is CSS-bounded (`max-height` in styles.css), so
  // its real pixel height only changes on window resize — a ResizeObserver
  // catches that without polling.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (el === null) return;
    const update = () => setTrackHeight(el.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Viewport box: maps the window's current scroll position onto the turn
  // column's real (not entry-count-derived) height, so it tracks correctly
  // whether the column grew because a turn expanded or because "show more
  // turns" loaded another chunk. A ResizeObserver on the column catches
  // those height changes directly; the scroll listener is passive and
  // throttled to one recompute per animation frame.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let rafId = 0;
    const recompute = () => {
      rafId = 0;
      const rect = container.getBoundingClientRect();
      const docHeight = rect.height;
      if (docHeight <= 0 || trackHeight <= 0) {
        setViewport({ top: 0, height: 0 });
        return;
      }
      const docTop = rect.top + window.scrollY;
      const viewTop = window.scrollY - docTop;
      const viewBottom = viewTop + window.innerHeight;
      const clampedTop = Math.max(0, Math.min(docHeight, viewTop));
      const clampedBottom = Math.max(0, Math.min(docHeight, viewBottom));
      setViewport({
        top: (clampedTop / docHeight) * trackHeight,
        height: Math.max(2, ((clampedBottom - clampedTop) / docHeight) * trackHeight),
      });
    };
    const onScroll = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(recompute);
    };

    recompute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(container);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      observer.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [containerRef, trackHeight]);

  const counts = useMemo(() => groups.map((g) => g.entries.length), [groups]);
  const bandHeights = useMemo(
    () => layoutTurnBandHeights(counts, trackHeight),
    [counts, trackHeight],
  );

  // Dragging the viewport box scrolls the page proportionally to how far the
  // pointer moved in rail space — the inverse of the mapping `recompute`
  // above does from scroll position to rail space. `setPointerCapture` keeps
  // move/up events coming to this element even once the cursor leaves it.
  const onVpPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startScrollY: window.scrollY };
  };
  const onVpPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (drag === null || drag.pointerId !== e.pointerId || container === null || trackHeight <= 0) {
      return;
    }
    const docHeight = container.getBoundingClientRect().height;
    const scale = docHeight / trackHeight;
    window.scrollTo({ top: drag.startScrollY + (e.clientY - drag.startY) * scale });
  };
  const onVpPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="mmap">
      <div className="mmap-track" ref={trackRef}>
        {groups.map((group, i) => {
          const flags = deriveTurnBandFlags(group, totalCostUsd);
          const label = turnTooltipLabel(group.index, group.startedAt);
          return (
            <button
              key={`turn-${String(group.anchorLine)}`}
              type="button"
              className={bandClass(flags)}
              style={{ height: `${String(bandHeights[i] ?? 0)}px` }}
              title={label}
              aria-label={`Jump to turn ${label}`}
              onClick={() => onSelectTurn(group.anchorLine)}
            />
          );
        })}
      </div>
      <div
        className="mmap-vp"
        style={{ top: `${String(viewport.top)}px`, height: `${String(viewport.height)}px` }}
        onPointerDown={onVpPointerDown}
        onPointerMove={onVpPointerMove}
        onPointerUp={onVpPointerUp}
        onPointerCancel={onVpPointerUp}
      />
    </div>
  );
});
