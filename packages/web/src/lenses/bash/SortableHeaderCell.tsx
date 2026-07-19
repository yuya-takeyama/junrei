import { nextSortSpec, type SortDir, type SortSpec } from "../../tableSort.js";

interface Props<K extends string> {
  label: string;
  columnKey: K;
  /** This column's natural first-click direction — pass `defaultDirFor(column.type)` from the same `SortColumnDef` the table's `sortRows` call uses, so the header and the sort behavior can't drift apart. */
  defaultDir: SortDir;
  sortSpec: SortSpec<K>;
  onSortChange: (spec: SortSpec<K>) => void;
  /** Right-aligns the cell (numeric columns) — mirrors the `.cellr` convention every Bash table header already uses for its non-label columns. Omit for the left-aligned label column. */
  align?: "right";
}

/**
 * One clickable, sortable header cell — shared by `CommandRankingTable` and
 * `HeavyHittersTable` so the "button + aria-sort + ▲/▼ indicator" markup
 * exists in exactly one place (see `tableSort.ts`'s doc comment for the
 * fuller "why a primitive" rationale).
 *
 * Stays a plain function component — no state of its own. The click just
 * hands the table's owner (`sortSpec`/`onSortChange` come from a `useState`
 * one level up, in `Bash.tsx`) the next `SortSpec`, computed by
 * `nextSortSpec` from `tableSort.ts`: same column toggles direction, a
 * different column jumps to `defaultDir`.
 *
 * `aria-sort` lives on the cell, not the `<button>` inside it — and the
 * cell is a `<div role="columnheader">`, not a real `<th>`: this app's
 * tables are CSS grids of `<div>`/`<span>` (no `<table>`), and HTML only
 * allows `<th>` inside `<tr>` — rendered under the `.bcmd`/`.bhh` row
 * `<div>`s, React warns "<th> cannot be a child of <div>" on every mount.
 * So the cell follows the same ARIA-table convention its call sites
 * already use (`role="table"`/`role="row"` on those grid `<div>`s):
 * `columnheader` is exactly the role a `<th scope="col">` would have
 * carried implicitly, and one of the few roles `aria-sort` is valid on
 * (`useAriaPropsSupportedByRole` accepts it). Biome's `useSemanticElements`
 * preference for the native element is suppressed inline below for the
 * same reason as at those call sites — the native element is precisely
 * what's invalid in this markup.
 */
export function SortableHeaderCell<K extends string>({
  label,
  columnKey,
  defaultDir,
  sortSpec,
  onSortChange,
  align,
}: Props<K>) {
  const isActive = sortSpec.key === columnKey;
  const ariaSort = isActive ? (sortSpec.dir === "asc" ? "ascending" : "descending") : "none";

  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <th> is invalid DOM inside this CSS-grid-of-divs row (see the doc comment above); role="columnheader" is the closest available semantics
    // biome-ignore lint/a11y/useFocusableInteractive: the keyboard-operable control is the inner sort <button>; the cell itself must stay out of the tab sequence (same as the role="row" divs at the call sites)
    <div
      className={align === "right" ? "cellr" : undefined}
      role="columnheader"
      aria-sort={ariaSort}
    >
      <button
        type="button"
        className={`sortbtn lbl${isActive ? " on" : ""}`}
        onClick={() => onSortChange(nextSortSpec(sortSpec, columnKey, defaultDir))}
      >
        {label}
        {isActive && <span className="sortind">{sortSpec.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </div>
  );
}
