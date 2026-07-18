import type { BashStatsJson } from "../../api.js";
import { buildHeavyHitterRows } from "./bashLensFormat.js";

interface Props {
  heavyHitters: BashStatsJson["heavyHitters"];
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
 * Heavy hitters table (Bash lens panel 2, bottom) — top 10 Bash calls by
 * result chars, across every thread (already ranked/capped by
 * `computeHeavyHitters` in `@junrei/core`'s `bash-stats.ts`, so no further
 * client-side limiting here). When `onOpenRecord` is wired, the command
 * label becomes a `.lnbtn` button opening the record slide-over at that
 * call's own line — the same click-to-drill-down pattern
 * `FileAccessTree.tsx` already uses for its injected-content rows, not a new
 * navigation mechanism. Row data is precomputed by `buildHeavyHitterRows`
 * (`bashLensFormat.ts`).
 */
export function HeavyHittersTable({ heavyHitters, onOpenRecord }: Props) {
  const rows = buildHeavyHitterRows(heavyHitters);

  return (
    <div className="pan f1 mt16" style={{ minWidth: 0, padding: "6px 0" }}>
      <div className="bhh hdr">
        <span className="lbl" />
        <span className="lbl">Command</span>
        <span className="lbl cellr">Thread</span>
        <span className="lbl cellr">Result chars</span>
        <span className="lbl cellr">Line</span>
      </div>
      {rows.length === 0 ? (
        <div className="bhh" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no Bash calls recorded</span>
        </div>
      ) : (
        rows.map((row, i) => (
          <div
            className="bhh"
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
            <span className="num fs11 cellr mut">L{row.line}</span>
          </div>
        ))
      )}
    </div>
  );
}
