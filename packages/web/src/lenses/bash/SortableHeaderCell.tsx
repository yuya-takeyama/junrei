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
 * One clickable, sortable header cell — shared by `CommandRankingTable`,
 * `HeavyHittersTable`, and `WasteDetectionPanel`'s flat waste grids so the
 * "button + aria-sort + ▲/▼ indicator" markup exists in exactly one place
 * (a v2 redesign of these tables inherits it as-is; see `tableSort.ts`'s
 * doc comment for the fuller "why a primitive" rationale).
 *
 * Stays a plain function component — no state of its own. The click just
 * hands the table's owner (`sortSpec`/`onSortChange` come from a `useState`
 * one level up, in `Bash.tsx`) the next `SortSpec`, computed by
 * `nextSortSpec` from `tableSort.ts`: same column toggles direction, a
 * different column jumps to `defaultDir`.
 *
 * `aria-sort` lives on the cell, not the `<button>` inside it — and the
 * cell is a real `<th scope="col">`, not a styled `<span>`: this app's
 * tables are otherwise CSS grids of `<div>`/`<span>` (no `<table>`), but
 * `aria-sort` is only valid on `columnheader`/`rowheader`/`cell`/`row`
 * roles, and Biome's a11y rules (`useAriaPropsSupportedByRole`,
 * `useSemanticElements`, `useFocusableInteractive`) push toward the native
 * element over faking the role on a `<span>`. `<th>` blockifies fine as a
 * CSS Grid item (see `styles.css`'s `.bcmd th, .bhh th, .bflat th` reset for
 * the table header chrome — bold/centered/padded — it doesn't want here), so
 * it slots into the existing `.bcmd`/`.bhh`/`.bflat` grid rows unchanged.
 * Those three grids (plus their header/data row `<div>`s) also carry
 * `role="table"`/`role="row"` at their call sites — `<th>`'s implicit
 * columnheader role, and thus `aria-sort`, is only guaranteed to reach
 * assistive tech with that ancestry in place, since these grids have no real
 * `<table>` ancestor.
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
    <th className={align === "right" ? "cellr" : undefined} scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        className={`sortbtn lbl${isActive ? " on" : ""}`}
        onClick={() => onSortChange(nextSortSpec(sortSpec, columnKey, defaultDir))}
      >
        {label}
        {isActive && <span className="sortind">{sortSpec.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}
