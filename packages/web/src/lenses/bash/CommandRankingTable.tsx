import type { BashStatsJson } from "../../api.js";
import { defaultDirFor, type SortColumnDef, type SortSpec, sortRows } from "../../tableSort.js";
import { buildCommandRankingRows, type CommandRankingRow } from "./bashLensFormat.js";
import { SortableHeaderCell } from "./SortableHeaderCell.js";

export type CommandRankingSortKey =
  | "label"
  | "calls"
  | "errors"
  | "totalChars"
  | "avgChars"
  | "estTokens"
  | "share";

/** Column defs for `sortRows` — one source of truth shared with the header buttons' `defaultDir` (see `COLUMNS` usages below), so sort behavior and the header's first-click direction can't drift apart. */
const COLUMNS: readonly SortColumnDef<CommandRankingRow, CommandRankingSortKey>[] = [
  { key: "label", type: "string", value: (r) => r.label },
  { key: "calls", type: "numeric", value: (r) => r.calls },
  { key: "errors", type: "numeric", value: (r) => r.errors },
  { key: "totalChars", type: "numeric", value: (r) => r.totalChars },
  { key: "avgChars", type: "numeric", value: (r) => r.avgChars },
  { key: "estTokens", type: "numeric", value: (r) => r.estTokens },
  { key: "share", type: "numeric", value: (r) => r.share },
];

function columnType(key: CommandRankingSortKey): "numeric" | "string" {
  return COLUMNS.find((c) => c.key === key)?.type ?? "numeric";
}

/** `computeByCommand`'s own order (`@junrei/core`'s `bash-stats.ts`) — total result chars desc — made explicit as this table's default `sortSpec` rather than an implicit "whatever order the engine handed us" the component just happened to render as-is. */
export const DEFAULT_COMMAND_RANKING_SORT: SortSpec<CommandRankingSortKey> = {
  key: "totalChars",
  dir: "desc",
};

interface Props {
  byCommand: BashStatsJson["byCommand"];
  sortSpec: SortSpec<CommandRankingSortKey>;
  onSortChange: (spec: SortSpec<CommandRankingSortKey>) => void;
}

/**
 * Command ranking table (Bash lens panel 1) — one row per resolved
 * family+subcommand group. Sortable by every column: clicking a header cell
 * re-sorts via `sortRows` (`tableSort.ts`) against the raw numeric/string
 * fields on each row (never the formatted `*Text` strings — see
 * `CommandRankingRow`'s doc comment in `bashLensFormat.ts`). Defaults to
 * `DEFAULT_COMMAND_RANKING_SORT`, which reproduces `computeByCommand`'s own
 * total-result-chars-desc order (`@junrei/core`'s `bash-stats.ts`) — so with
 * no interaction yet, the table looks exactly like it did before sorting
 * existed.
 *
 * Stays a pure function component: sort state (`sortSpec`) and the setter
 * (`onSortChange`) are owned by `Bash.tsx` one level up, not a local
 * `useState` here — this repo's component tests call components directly as
 * functions and walk the returned element tree (no jsdom/testing-library),
 * which only works for hookless components. Up to 3 distinct sample
 * commands per group surface as a `title=` tooltip on the command label —
 * the same hover-detail disclosure `CostByModelTable`/`FileAccessTree`
 * already use in this app, rather than a new expand/collapse widget with no
 * sibling precedent. Row data itself is precomputed by
 * `buildCommandRankingRows` (`bashLensFormat.ts`).
 */
export function CommandRankingTable({ byCommand, sortSpec, onSortChange }: Props) {
  const rows = sortRows(buildCommandRankingRows(byCommand), sortSpec, COLUMNS);

  const header = (key: CommandRankingSortKey, label: string, align?: "right") => (
    <SortableHeaderCell
      label={label}
      columnKey={key}
      defaultDir={defaultDirFor(columnType(key))}
      sortSpec={sortSpec}
      onSortChange={onSortChange}
      {...(align !== undefined && { align })}
    />
  );

  return (
    // `role="table"`/`role="row"` restore the ancestry a `<th aria-sort>` needs to
    // keep its implicit columnheader role (and thus expose `aria-sort` to AT) — see
    // `SortableHeaderCell.tsx`'s doc comment. `.bcmd` isn't one shared grid but a
    // per-row `display:grid` repeated on every row `<div>` (header + data alike), so
    // "table"/"row" land on this outer wrapper and each `.bcmd` row rather than on
    // `.bcmd` itself. No `<table>`/`<tr>` fits this CSS-grid-of-`<div>`s layout, so
    // Biome's semantic-elements preference is deliberately overridden below — a
    // narrowly-scoped exception, not a rule to relax repo-wide.
    // biome-ignore lint/a11y/useSemanticElements: no <table> fits this CSS-grid-of-divs layout; role="table" is the closest available semantics
    <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }} role="table">
      {/* biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics (see role="table" comment above) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) row, not an ARIA grid/treegrid row — doesn't belong in the tab sequence */}
      <div className="bcmd hdr" role="row">
        {header("label", "Command")}
        {header("calls", "Calls", "right")}
        {header("errors", "Err", "right")}
        {header("totalChars", "Total chars", "right")}
        {header("avgChars", "Avg chars", "right")}
        {header("estTokens", "Est. tokens", "right")}
        {header("share", "Share", "right")}
      </div>
      {rows.length === 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: same as the header row above
        // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
        <div className="bcmd" role="row" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no Bash calls recorded</span>
        </div>
      ) : (
        rows.map((row, i) => (
          // biome-ignore lint/a11y/useSemanticElements: same as the header row above
          // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
          <div
            className="bcmd"
            role="row"
            key={row.key}
            style={i === rows.length - 1 ? { borderBottom: 0 } : undefined}
          >
            <span className="mono fs11 nowrap" title={row.sampleTitle}>
              {row.label}
            </span>
            <span className="num fs12 cellr">{row.calls}</span>
            <span className={`num fs12 cellr${row.hasErrors ? " errtx" : " mut"}`}>
              {row.errors}
            </span>
            <span className="num fs12 cellr">{row.totalCharsText}</span>
            <span className="num fs12 cellr">{row.avgCharsText}</span>
            <span className="num fs12 cellr approx">{row.estTokensText}</span>
            <span className="num fs12 cellr">{row.shareText}</span>
          </div>
        ))
      )}
    </div>
  );
}
