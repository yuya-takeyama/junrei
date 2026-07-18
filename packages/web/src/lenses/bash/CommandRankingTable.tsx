import type { BashStatsJson } from "../../api.js";
import { buildCommandRankingRows } from "./bashLensFormat.js";

interface Props {
  byCommand: BashStatsJson["byCommand"];
}

/**
 * Command ranking table (Bash lens panel 1) — one row per resolved
 * family+subcommand group, already sorted by `totalResultChars` desc (see
 * `computeByCommand` in `@junrei/core`'s `bash-stats.ts`); rendered in that
 * order as-is, no client-side re-sort. Up to 3 distinct sample commands per
 * group surface as a `title=` tooltip on the command label — the same
 * hover-detail disclosure `CostByModelTable`/`FileAccessTree` already use in
 * this app, rather than a new expand/collapse widget with no sibling
 * precedent. Row data itself is precomputed by `buildCommandRankingRows`
 * (`bashLensFormat.ts`), so this component is a pure map+render.
 */
export function CommandRankingTable({ byCommand }: Props) {
  const rows = buildCommandRankingRows(byCommand);

  return (
    <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }}>
      <div className="bcmd hdr">
        <span className="lbl">Command</span>
        <span className="lbl cellr">Calls</span>
        <span className="lbl cellr">Err</span>
        <span className="lbl cellr">Total chars</span>
        <span className="lbl cellr">Avg chars</span>
        <span className="lbl cellr">Est. tokens</span>
        <span className="lbl cellr">Share</span>
      </div>
      {rows.length === 0 ? (
        <div className="bcmd" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no Bash calls recorded</span>
        </div>
      ) : (
        rows.map((row, i) => (
          <div
            className="bcmd"
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
