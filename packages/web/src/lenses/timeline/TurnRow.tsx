import { classifyModel, modelShortLabel } from "../../modelClass.js";
import { joinClasses, type TurnColumn } from "./turnColumns.js";
import type { TurnGroup } from "./turnGroups.js";

const EM_DASH = "—";

interface HeaderProps {
  columns: readonly TurnColumn[];
  gridTemplate: string;
}

/** Column-label row above the turn list — same `.trg` grid as `TurnRow` itself, sharing its inline `gridTemplate` so the two never drift apart. */
export function TurnGroupHeaderRow({ columns, gridTemplate }: HeaderProps) {
  return (
    <div className="trow trg hdr" style={{ gridTemplateColumns: gridTemplate }}>
      <span className="lbl">#</span>
      <span className="lbl">Model · Prompt</span>
      {columns.map((col) => (
        <span key={col.key} className="lbl cellr">
          {col.label}
        </span>
      ))}
    </div>
  );
}

/** Overlapping dot cluster + short label — "mixed" when a turn's API calls spanned more than one model. */
function ModelCluster({ models }: { models: readonly string[] }) {
  if (models.length === 0) {
    return <span className="mono fs11 mut noshrink">{EM_DASH}</span>;
  }
  const label = models.length === 1 ? modelShortLabel(models[0] as string) : "mixed";
  return (
    <>
      <span className="dcl">
        {models.map((model) => (
          <span key={model} className={`mdot c-${classifyModel(model)}`} />
        ))}
      </span>
      <span className="mono fs11 mut noshrink">{label}</span>
    </>
  );
}

interface Props {
  group: TurnGroup;
  columns: readonly TurnColumn[];
  gridTemplate: string;
  expanded: boolean;
  isOutlier: boolean;
  /** `altKey` is passed straight through from the click event — Timeline.tsx decides what it means (⌥-click expands turn + steps in one gesture, mock 2i); TurnRow itself carries no expansion logic. */
  onToggle: (line: number, altKey: boolean) => void;
  /** Registers this row's header button by `anchorLine` — the turn-aware
   * minimap (`TurnMiniMap.tsx`) scrolls to it directly, which is what makes
   * clicking into a *collapsed* turn actually work (the header button is
   * always mounted, unlike its entries). */
  registerRef: (line: number, el: HTMLButtonElement | null) => void;
}

/**
 * One row of the turn-grouped spine's dense table (`.trg`) — collapsed by
 * default, the whole row toggles this turn's expansion (see Timeline.tsx's
 * `toggleTurn`). Rendered as a real `<button>` (matching the `.tn`/
 * Orchestration-tree row idiom already used elsewhere) so Enter/Space
 * activation and the button accessibility role come for free instead of
 * hand-rolling `div role="button"` + a keydown handler.
 *
 * The numeric cells are driven entirely by `columns` (`turnColumns.ts`) —
 * `#` and `Model · Prompt` stay hand-written since their caret/aria/dot-
 * cluster markup doesn't fit a generic column descriptor.
 */
export function TurnRow({
  group,
  columns,
  gridTemplate,
  expanded,
  isOutlier,
  onToggle,
  registerRef,
}: Props) {
  const promptPreview = group.userEntry?.text.split("\n")[0];
  const rowClass = joinClasses("trow", "trg", isOutlier && "tint", expanded && "exh");

  return (
    <button
      type="button"
      className={rowClass}
      aria-expanded={expanded}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={(e) => onToggle(group.anchorLine, e.altKey)}
      ref={(el) => registerRef(group.anchorLine, el)}
    >
      <span className="tnum">
        <span className="car" style={expanded ? { color: "var(--amb)" } : undefined}>
          {expanded ? "▾" : "▸"}
        </span>
        {group.index}
      </span>
      <span className="mrow">
        <ModelCluster models={group.models} />
        <span className={promptPreview !== undefined ? "pv pvq" : "pv mut"}>
          {promptPreview ?? EM_DASH}
        </span>
      </span>
      {columns.map((col) => (
        <span key={col.key} className={col.className(group, isOutlier)}>
          {col.render(group)}
        </span>
      ))}
    </button>
  );
}
