import type { BashStatsJson } from "../../api.js";
import { defaultDirFor, type SortColumnDef, type SortSpec, sortRows } from "../../tableSort.js";
import { buildCommandRankingRows, type CommandRankingRow } from "./bashLensFormat.js";
import { SortableHeaderCell } from "./SortableHeaderCell.js";

export type CommandRankingSortKey =
  | "label"
  | "calls"
  | "errors"
  | "estUsd"
  | "usdSharePct"
  | "orchSharePct"
  | "estTokens"
  | "totalChars"
  | "avgChars"
  | "share";

/** Column defs for `sortRows` — one source of truth shared with the header buttons' `defaultDir` (see `COLUMNS` usages below), so sort behavior and the header's first-click direction can't drift apart. */
const COLUMNS: readonly SortColumnDef<CommandRankingRow, CommandRankingSortKey>[] = [
  { key: "label", type: "string", value: (r) => r.label },
  { key: "calls", type: "numeric", value: (r) => r.calls },
  { key: "errors", type: "numeric", value: (r) => r.errors },
  { key: "estUsd", type: "numeric", value: (r) => r.estUsd },
  { key: "usdSharePct", type: "numeric", value: (r) => r.usdSharePct },
  { key: "orchSharePct", type: "numeric", value: (r) => r.orchSharePct },
  { key: "estTokens", type: "numeric", value: (r) => r.estTokens },
  { key: "totalChars", type: "numeric", value: (r) => r.totalChars },
  { key: "avgChars", type: "numeric", value: (r) => r.avgChars },
  { key: "share", type: "numeric", value: (r) => r.share },
];

function columnType(key: CommandRankingSortKey): "numeric" | "string" {
  return COLUMNS.find((c) => c.key === key)?.type ?? "numeric";
}

/**
 * Money-anchored default (v2 redesign): `estUsd` desc, so with no
 * interaction yet the table reads "most expensive command first" — the
 * whole point of re-anchoring this table on $. `undefined` `estUsd` rows
 * (no priced model anywhere in the session) sort last via `sortRows`'
 * always-last-for-undefined rule, which degrades gracefully to
 * `DEFAULT_COMMAND_RANKING_SORT_UNPRICED`-equivalent insertion order only
 * when NOT ONE command has a known price — see `Bash.tsx`, which picks
 * `totalChars` desc instead in that case so the table still opens sorted by
 * something meaningful.
 */
export const DEFAULT_COMMAND_RANKING_SORT: SortSpec<CommandRankingSortKey> = {
  key: "estUsd",
  dir: "desc",
};

/** `computeByCommand`'s own order (`@junrei/core`'s `bash-stats.ts`) — total result chars desc. Used as the table's default instead of `DEFAULT_COMMAND_RANKING_SORT` whenever the session has no priced Bash usage at all (see `Bash.tsx`). */
export const DEFAULT_COMMAND_RANKING_SORT_UNPRICED: SortSpec<CommandRankingSortKey> = {
  key: "totalChars",
  dir: "desc",
};

interface Props {
  byCommand: BashStatsJson["byCommand"];
  totals: BashStatsJson["totals"];
  sortSpec: SortSpec<CommandRankingSortKey>;
  onSortChange: (spec: SortSpec<CommandRankingSortKey>) => void;
  /** Shows the Total/Avg chars column group when true — collapsed by default in favor of the money columns (see `Bash.tsx`'s `showChars` toggle). */
  showChars: boolean;
}

/**
 * Cost by command table (Bash lens — "COST BY COMMAND") — one row per
 * resolved family+subcommand group, re-anchored on money for the v2
 * redesign: command / calls / err / ~est$ / $share / orch-share% / ~est
 * tokens, with the legacy chars columns (total/avg) available behind
 * `showChars` rather than always taking up a column slot. Sortable by every
 * column via `sortRows` (`tableSort.ts`) against the raw numeric/string
 * fields on each row (never the formatted `*Text` strings — see
 * `CommandRankingRow`'s doc comment in `bashLensFormat.ts`). Defaults to
 * `DEFAULT_COMMAND_RANKING_SORT` (`estUsd` desc) when the session has any
 * priced Bash usage, or `DEFAULT_COMMAND_RANKING_SORT_UNPRICED` (`totalChars`
 * desc, the v1 default) otherwise — picked by `Bash.tsx` at mount, since
 * "most expensive first" has nothing to say when nothing is priced.
 *
 * Stays a pure function component: sort state (`sortSpec`) and the setter
 * (`onSortChange`), plus `showChars`, are owned by `Bash.tsx` one level up,
 * not local `useState` here — this repo's component tests call components
 * directly as functions and walk the returned element tree (no
 * jsdom/testing-library), which only works for hook-free components. Up to
 * 3 distinct sample commands per group surface as a `title=` tooltip on the
 * command label, same as before.
 */
export function CommandRankingTable({
  byCommand,
  totals,
  sortSpec,
  onSortChange,
  showChars,
}: Props) {
  const rows = sortRows(buildCommandRankingRows(byCommand, totals), sortSpec, COLUMNS);

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
    // See `HeavyHittersTable.tsx`'s doc comment for why `role="table"`/`role="row"`
    // stand in for `<table>`/`<tr>` throughout this app's CSS-grid-of-`<div>`s tables.
    // biome-ignore lint/a11y/useSemanticElements: no <table> fits this CSS-grid-of-divs layout; role="table" is the closest available semantics
    <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }} role="table">
      {/* biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics (see role="table" comment above) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) row, not an ARIA grid/treegrid row — doesn't belong in the tab sequence */}
      <div className={showChars ? "bcmd hdr chars" : "bcmd hdr"} role="row">
        {header("label", "Command")}
        {header("calls", "Calls", "right")}
        {header("errors", "Err", "right")}
        {header("estUsd", "~Est $", "right")}
        {header("usdSharePct", "$ share", "right")}
        {header("orchSharePct", "Orch %", "right")}
        {header("estTokens", "Est. tokens", "right")}
        {showChars && header("totalChars", "Total chars", "right")}
        {showChars && header("avgChars", "Avg chars", "right")}
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
            className={showChars ? "bcmd chars" : "bcmd"}
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
            <span className={row.estUsd === undefined ? "num fs12 cellr mut" : "num fs12 cellr"}>
              {row.estUsdText}
            </span>
            <span
              className={row.usdSharePct === undefined ? "num fs12 cellr mut" : "num fs12 cellr"}
            >
              {row.usdShareText}
            </span>
            <span className="num fs12 cellr">{row.orchShareText}</span>
            <span className="num fs12 cellr approx">{row.estTokensText}</span>
            {showChars && <span className="num fs12 cellr">{row.totalCharsText}</span>}
            {showChars && <span className="num fs12 cellr">{row.avgCharsText}</span>}
          </div>
        ))
      )}
    </div>
  );
}
