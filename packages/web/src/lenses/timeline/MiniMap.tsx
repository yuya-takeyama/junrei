import { memo } from "react";
import type { TimelineEntry } from "../../api.js";
import { isErrorEntry, isMarkerEntry } from "./timelineFilters.js";

interface Props {
  entries: readonly TimelineEntry[];
  onSelect: (index: number) => void;
}

function bandClass(entry: TimelineEntry): string {
  if (isErrorEntry(entry)) return "mmap-band mmap-band-err";
  if (isMarkerEntry(entry)) return "mmap-band mmap-band-amb";
  return "mmap-band mmap-band-mut";
}

/**
 * Sticky schematic mini-map rail (see design-spec/12-timeline.md). Each
 * visible entry gets an equal-height slice (proportional to entry *count*,
 * not block pixel-height, per spec) — a uniform flex column produces
 * contiguous bands automatically wherever consecutive entries share a
 * color, which is cheap enough to redraw for a couple thousand entries.
 */
export const MiniMap = memo(function MiniMap({ entries, onSelect }: Props) {
  return (
    <div className="mmap">
      <div className="mmap-track">
        {entries.map((entry, i) => (
          <button
            // kind+line alone can collide: two subagent launches from one
            // assistant message share a source line.
            key={`${entry.kind}-${entry.line}-${String(i)}`}
            type="button"
            className={bandClass(entry)}
            onClick={() => onSelect(i)}
            aria-label={`Jump to line ${entry.line}`}
          />
        ))}
      </div>
    </div>
  );
});
