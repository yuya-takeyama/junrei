import type { ToolUsageStatsJson } from "../../api.js";
import { threadMoneyModelDotClass } from "../bash/bashLensFormat.js";
import { buildToolHeavyHitterRows, type ToolHeavyHitterRow } from "./toolsLensFormat.js";

interface Props {
  heavyHitters: ToolUsageStatsJson["heavyHitters"];
  /** How many rows to render before the "show N more" expander cuts off — the rest are hidden until expanded (owned by `AllView`). */
  visibleCount: number;
  /**
   * Opens the record slide-over (L3) at a heavy hitter's own line — same
   * wiring the Bash `HeavyHittersTable` uses. `agentId` is the row's raw
   * (untruncated) subagent id, passed only for non-main rows so the record
   * fetch routes into the right subagent transcript (see `SessionShell.tsx`).
   */
  onOpenRecord?: (line: number, agentId?: string) => void;
}

/**
 * Heavy hitters table (Tools lens → "All" sub-tab) — the top single tool
 * results by size, across every tool AND thread (already ranked/capped at 10
 * by `computeToolUsageStats` in `@junrei/core`). Columns: rank, result (the
 * tool + provenance line, clickable to open the record slide-over), tool
 * badge, owning thread (model-dot + id), result chars, ~est $.
 *
 * Cross-tool heavy hitters carry no per-call command/text (unlike the
 * Bash-only heavy hitters, which show the command line), so the Result column
 * names the tool + its source line rather than a captured snippet — the click
 * target that opens the full record. Fixed engine order (not sortable) with an
 * `AllView`-owned "show N more" expander, matching the mockup. Pure function
 * component (no hooks) — see `ToolRankingTable.tsx`'s doc comment.
 */
export function ToolHeavyHittersTable({ heavyHitters, visibleCount, onOpenRecord }: Props) {
  const rows = buildToolHeavyHitterRows(heavyHitters).slice(0, visibleCount);

  const resultCell = (row: ToolHeavyHitterRow) =>
    onOpenRecord !== undefined ? (
      <button
        type="button"
        className="lnbtn mono fs12 nowrap"
        style={{ color: "inherit", textAlign: "left" }}
        onClick={() => onOpenRecord(row.line, row.agentId)}
        title={`${row.tool} result · L${row.line}`}
      >
        {row.tool} result <span className="mut">· L{row.line}</span>
      </button>
    ) : (
      <span className="mono fs12 nowrap" title={`${row.tool} result · L${row.line}`}>
        {row.tool} result <span className="mut">· L{row.line}</span>
      </span>
    );

  return (
    // biome-ignore lint/a11y/useSemanticElements: no <table> fits this CSS-grid-of-divs layout; role="table" is the closest available semantics (see HeavyHittersTable.tsx)
    <div className="pan" role="table">
      {/* biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) header row */}
      <div className="hh hdr" role="row">
        <span className="lbl cellr">#</span>
        <span className="lbl">Result</span>
        <span className="lbl">Tool</span>
        <span className="lbl">Thread</span>
        <span className="lbl cellr">Chars</span>
        <span className="lbl cellr">~$</span>
      </div>
      {rows.length === 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: same as the header row above
        // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
        <div className="hh" role="row" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no tool results recorded</span>
        </div>
      ) : (
        rows.map((row, i) => (
          // biome-ignore lint/a11y/useSemanticElements: same as the header row above
          // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
          <div
            className="hh"
            role="row"
            key={row.key}
            style={i === rows.length - 1 ? { borderBottom: 0 } : undefined}
          >
            <span className="num fs11 cellr mut">{row.rank}</span>
            {resultCell(row)}
            <span>
              <span className="tbadge">{row.tool}</span>
            </span>
            <span className="mono fs11 nowrap fx ac gap6">
              <span className={`mdot ${threadMoneyModelDotClass(row.model)}`} />
              <span className={row.thread.isMain ? "amb" : undefined}>{row.thread.text}</span>
            </span>
            <span className="num fs12 cellr">{row.resultCharsText}</span>
            <span className={row.estUsdText === "—" ? "num fs12 cellr mut" : "num fs12 cellr"}>
              {row.estUsdText}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
