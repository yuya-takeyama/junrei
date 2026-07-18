/**
 * Client-side table sorting primitive — pure functions only, no React, so it
 * unit-tests without a component tree and reuses cleanly across any lens's
 * table (colocated at the src root next to `format.ts`/`modelClass.ts`,
 * this app's existing convention for logic shared across lens folders,
 * rather than living inside one lens's subfolder).
 *
 * First consumer is the Bash lens's three tables (`lenses/bash/`), whose row
 * components stay pure function components — no `useState` inside a table
 * itself, since this repo's tests call components directly as functions and
 * walk the returned element tree (no jsdom/testing-library, so a stateful
 * click has nothing to dispatch through). Sort state lives one level up, in
 * whichever component owns the table (see `Bash.tsx`), and flows down as a
 * `SortSpec` + `onSortChange` pair; the table itself just calls `sortRows`
 * with the spec it's given and renders a clickable header per column.
 */

/** Sort direction — matches the `aria-sort` vocabulary loosely (`"ascending"`/`"descending"`), kept short since it's threaded through every column def and click handler. */
export type SortDir = "asc" | "desc";

/** Which column is active and which way — the entire piece of state a sortable table needs, one instance per table. `K` is each table's own column-key union (e.g. `"calls" | "errors" | ...`), so a click handler can't be wired to a key that doesn't exist on that table. */
export interface SortSpec<K extends string = string> {
  key: K;
  dir: SortDir;
}

/** Whether a column compares numerically or as a (locale-aware) string — drives both the comparator `sortRows` uses and the natural first-click direction `defaultDirFor` returns. */
export type SortColumnType = "numeric" | "string";

/**
 * One column's sort behavior: how to pull its raw comparison value out of a
 * row. Deliberately separate from display formatting — a row model's
 * `*Text` fields (e.g. `CommandRankingRow.totalCharsText`, already rounded/
 * suffixed for display) are never what gets compared here; each column
 * reads the row's raw numeric/string field instead (see `bashLensFormat.ts`'s
 * row builders, extended to carry those raw fields alongside the formatted
 * ones). Returning `undefined` marks the row as having no value for this
 * column — `sortRows` always places it last, in both directions.
 */
export interface SortColumnDef<Row, K extends string = string> {
  key: K;
  type: SortColumnType;
  value: (row: Row) => number | string | undefined;
}

/** A column's natural first-click direction: numeric columns start high-to-low (e.g. "most calls first" reads better than "least calls first"), string columns start A-to-Z. */
export function defaultDirFor(type: SortColumnType): SortDir {
  return type === "numeric" ? "desc" : "asc";
}

/**
 * Computes the next `SortSpec` for a header click. Clicking the already-active
 * column toggles its direction; clicking a different column switches to it
 * and starts at `defaultDir` (pass `defaultDirFor(column.type)`) rather than
 * carrying over the previous column's direction.
 */
export function nextSortSpec<K extends string>(
  current: SortSpec<K> | undefined,
  clickedKey: K,
  defaultDir: SortDir,
): SortSpec<K> {
  if (current !== undefined && current.key === clickedKey) {
    return { key: clickedKey, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key: clickedKey, dir: defaultDir };
}

/**
 * Sorts `rows` by `spec` against `columns`' matching definition. Stable
 * regardless of JS engine (ties broken by original index explicitly, rather
 * than relying on `Array.prototype.sort`'s spec-guaranteed-since-ES2019
 * stability) so re-sorting an already-sorted table doesn't visibly shuffle
 * tied rows. A row whose column value is `undefined` always sorts to the
 * bottom, in both `"asc"` and `"desc"` — "no data" isn't a comparable value
 * in either direction, so it never jumps to the top just because the
 * direction flipped. Returns a new array (or a shallow copy, if `spec.key`
 * doesn't match any column def — e.g. a caller-added column not opted into
 * sorting); never mutates `rows`.
 */
export function sortRows<Row, K extends string>(
  rows: readonly Row[],
  spec: SortSpec<K>,
  columns: readonly SortColumnDef<Row, K>[],
): Row[] {
  const column = columns.find((c) => c.key === spec.key);
  if (column === undefined) return [...rows];

  const sign = spec.dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .sort((a, b) => {
      if (a.value === undefined && b.value === undefined) return a.index - b.index;
      if (a.value === undefined) return 1;
      if (b.value === undefined) return -1;
      const cmp =
        column.type === "numeric"
          ? (a.value as number) - (b.value as number)
          : String(a.value).localeCompare(String(b.value));
      return cmp !== 0 ? cmp * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}
