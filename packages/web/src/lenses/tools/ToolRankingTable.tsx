import { Link } from "react-router";
import type { ToolUsageStatsJson } from "../../api.js";
import { buildToolRanking, type ToolRankingRow } from "./toolsLensFormat.js";

interface Props {
  stats: ToolUsageStatsJson;
  /** Path to the Bash sub-tab — the Bash row's "drill down →" affordance links here. */
  bashHref: string;
}

/** One `$ share` cell — an inline bar (`.shcell`) scaled to the table's largest share, with the actual percent alongside. Shared visual treatment with the re-anchored Bash `CommandRankingTable`. */
function ShareCell({ row }: { row: ToolRankingRow }) {
  return (
    <span className="shcell">
      <span className="shtrk">
        <span
          className="shfill"
          style={
            row.barMuted
              ? { width: `${row.barPct}%`, background: "var(--mut)" }
              : { width: `${row.barPct}%` }
          }
        />
      </span>
      <span className={row.isRollup ? "shpct mut" : "shpct"}>{row.shareText}</span>
    </span>
  );
}

function ToolNameCell({ row }: { row: ToolRankingRow }) {
  return (
    <span className={row.isRollup ? "tname mut nowrap" : "tname nowrap"}>
      <span className={row.isBash ? "amb" : undefined}>{row.name}</span>
      {row.rollupNames !== undefined && <span className="mut fs11"> {row.rollupNames}</span>}
      {row.isMcp && <span className="tbadge">mcp</span>}
    </span>
  );
}

/**
 * Tool usage ranking table (Tools lens → "All" sub-tab, "TOOL USAGE") — one
 * row per tool, ranked by est $ (the core engine's own `byTool` order), with
 * the top `TOP_TOOLS` shown, a muted "+N more tools" roll-up, and a Totals
 * row (see `buildToolRanking`). The `$ share` column renders as an inline bar
 * (the same `.shcell` treatment the Bash `CommandRankingTable` adopts), and
 * the Bash row alone carries a "drill down →" link to the Bash sub-tab.
 *
 * Deliberately NOT sortable (unlike the Bash command table): the roll-up +
 * Totals rows only make sense against the engine's fixed $-ranked order, and
 * the mockup presents it as a fixed ranking. Stays a pure function component
 * (no hooks) so the repo's call-it-directly component tests can walk its tree.
 */
export function ToolRankingTable({ stats, bashHref }: Props) {
  const model = buildToolRanking(stats);

  const bodyRow = (row: ToolRankingRow) => (
    // biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics (see CommandRankingTable.tsx)
    // biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) row, not an ARIA grid/treegrid row
    <div className={rowClass(row)} role="row" key={row.key}>
      <ToolNameCell row={row} />
      <span className="num fs12 cellr">{row.calls.toLocaleString()}</span>
      <span className={`num fs12 cellr${row.hasErrors ? " errtx" : " mut"}`}>{row.errors}</span>
      <span className={row.estUsdText === "—" ? "num fs12 cellr mut" : "num fs12 cellr"}>
        {row.estUsdText}
      </span>
      <ShareCell row={row} />
      <span className="num fs12 cellr">{row.orchShareText}</span>
      <span className="num fs12 cellr">{row.charsText}</span>
      <span className="cellr">
        {row.isBash && (
          <Link className="drill" to={bashHref}>
            drill down →
          </Link>
        )}
      </span>
    </div>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: no <table> fits this CSS-grid-of-divs layout; role="table" is the closest available semantics (see CommandRankingTable.tsx)
    <div className="pan" role="table">
      {/* biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) header row */}
      <div className="bcmd hdr" role="row">
        <span className="lbl">Tool</span>
        <span className="lbl cellr">Calls</span>
        <span className="lbl cellr">Err</span>
        <span className="lbl cellr">~Est $</span>
        <span className="lbl">$ share</span>
        <span className="lbl cellr">Orch</span>
        <span className="lbl cellr">Chars</span>
        <span className="lbl" />
      </div>
      {model.rows.map(bodyRow)}
      {bodyRow(model.totals)}
    </div>
  );
}

function rowClass(row: ToolRankingRow): string {
  if (row.isTotals) return "bcmd tot";
  return "bcmd";
}
