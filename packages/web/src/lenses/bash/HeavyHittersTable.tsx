import type { BashStatsJson } from "../../api.js";
import { defaultDirFor, type SortColumnDef, type SortSpec, sortRows } from "../../tableSort.js";
import { buildHeavyHitterRows, type HeavyHitterRow } from "./bashLensFormat.js";
import { SortableHeaderCell } from "./SortableHeaderCell.js";

export type HeavyHitterSortKey = "rank" | "command" | "thread" | "resultChars" | "estUsd" | "line";

/** Column defs for `sortRows` — `thread` compares the row's already-shortened display text (`thread.text`), the same string every row actually shows, rather than the raw untruncated `agentId`. */
const COLUMNS: readonly SortColumnDef<HeavyHitterRow, HeavyHitterSortKey>[] = [
  { key: "rank", type: "numeric", value: (r) => r.rank },
  { key: "command", type: "string", value: (r) => r.command },
  { key: "thread", type: "string", value: (r) => r.thread.text },
  { key: "resultChars", type: "numeric", value: (r) => r.resultChars },
  { key: "estUsd", type: "numeric", value: (r) => r.estUsd },
  { key: "line", type: "numeric", value: (r) => r.line },
];

function columnType(key: HeavyHitterSortKey): "numeric" | "string" {
  return COLUMNS.find((c) => c.key === key)?.type ?? "numeric";
}

/** `computeHeavyHitters`'s own order (`@junrei/core`'s `bash-stats.ts`) — result chars desc — made explicit as this table's default `sortSpec`, so with no interaction yet it renders exactly as it did before sorting existed. */
export const DEFAULT_HEAVY_HITTER_SORT: SortSpec<HeavyHitterSortKey> = {
  key: "resultChars",
  dir: "desc",
};

interface Props {
  heavyHitters: BashStatsJson["heavyHitters"];
  sortSpec: SortSpec<HeavyHitterSortKey>;
  onSortChange: (spec: SortSpec<HeavyHitterSortKey>) => void;
  /**
   * Opens the record slide-over (L3) at a heavy hitter's own line — same
   * `onOpenRecord` wiring `FileAccessTree`'s clickable rows use, threaded
   * down from the shell. `agentId` is the row's raw (untruncated) subagent
   * id (`row.agentId` from `buildHeavyHitterRows`), passed only for
   * non-main-thread rows — heavy hitters rank across every thread, so most
   * rows need it to route into the right subagent transcript rather than
   * 404ing against the main one (see `SessionShell.tsx`).
   */
  onOpenRecord?: (line: number, agentId?: string) => void;
}

/**
 * Heavy hitters table (Bash lens — EVIDENCE, collapsed-by-default drill-down
 * per the v2 redesign; `Bash.tsx` wraps this in a collapsible section) — top
 * 10 Bash calls by result chars, across every thread (already ranked/capped
 * by `computeHeavyHitters` in `@junrei/core`'s `bash-stats.ts`), now with an
 * `~Est $` column alongside result chars. Sortable by every column via
 * `sortRows` (`tableSort.ts`); defaults to `DEFAULT_HEAVY_HITTER_SORT`,
 * matching the engine's own order. When `onOpenRecord` is wired, the command
 * label becomes a `.lnbtn` button opening the record slide-over at that
 * call's own line — the same click-to-drill-down pattern `FileAccessTree.tsx`
 * already uses for its injected-content rows, not a new navigation mechanism.
 *
 * Stays a pure function component — `sortSpec`/`onSortChange` are owned by
 * `Bash.tsx`, not a local `useState` here (see `CommandRankingTable.tsx`'s
 * doc comment for why: this repo's component tests call components
 * directly as functions, which only works hook-free). Row data is
 * precomputed by `buildHeavyHitterRows` (`bashLensFormat.ts`).
 */
export function HeavyHittersTable({ heavyHitters, sortSpec, onSortChange, onOpenRecord }: Props) {
  const rows = sortRows(buildHeavyHitterRows(heavyHitters), sortSpec, COLUMNS);

  const header = (key: HeavyHitterSortKey, label: string, align?: "right") => (
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
    // `SortableHeaderCell.tsx`'s doc comment. `.bhh` isn't one shared grid but a
    // per-row `display:grid` repeated on every row `<div>` (header + data alike), so
    // "table"/"row" land on this outer wrapper and each `.bhh` row rather than on
    // `.bhh` itself. No `<table>`/`<tr>` fits this CSS-grid-of-`<div>`s layout, so
    // Biome's semantic-elements preference is deliberately overridden below — a
    // narrowly-scoped exception, not a rule to relax repo-wide.
    // biome-ignore lint/a11y/useSemanticElements: no <table> fits this CSS-grid-of-divs layout; role="table" is the closest available semantics
    <div className="pan f1 mt16" style={{ minWidth: 0, padding: "6px 0" }} role="table">
      {/* biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics (see role="table" comment above) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) row, not an ARIA grid/treegrid row — doesn't belong in the tab sequence */}
      <div className="bhh hdr" role="row">
        {header("rank", "#")}
        {header("command", "Command")}
        {header("thread", "Thread", "right")}
        {header("resultChars", "Result chars", "right")}
        {header("estUsd", "~Est $", "right")}
        {header("line", "Line", "right")}
      </div>
      {rows.length === 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: same as the header row above
        // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
        <div className="bhh" role="row" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no Bash calls recorded</span>
        </div>
      ) : (
        rows.map((row, i) => (
          // biome-ignore lint/a11y/useSemanticElements: same as the header row above
          // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
          <div
            className="bhh"
            role="row"
            key={row.key}
            style={i === rows.length - 1 ? { borderBottom: 0 } : undefined}
          >
            <span className="num fs11 cellr mut">{row.rank}</span>
            {onOpenRecord !== undefined ? (
              <button
                type="button"
                className="lnbtn mono fs11 nowrap"
                style={{ color: "inherit", textAlign: "left" }}
                onClick={() => onOpenRecord(row.line, row.agentId)}
                title={row.command}
              >
                {row.command}
              </button>
            ) : (
              <span className="mono fs11 nowrap" title={row.command}>
                {row.command}
              </span>
            )}
            <span className={`mono fs10 cellr ${row.thread.isMain ? "mut" : "amb"}`}>
              {row.thread.text}
            </span>
            <span className="num fs12 cellr">{row.resultCharsText}</span>
            <span className={row.estUsd === undefined ? "num fs12 cellr mut" : "num fs12 cellr"}>
              {row.estUsdText}
            </span>
            <span className="num fs11 cellr mut">L{row.line}</span>
          </div>
        ))
      )}
    </div>
  );
}
