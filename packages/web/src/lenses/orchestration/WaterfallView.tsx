import { useMemo, useState } from "react";
import type { SessionJson } from "../../api.js";
import { formatDuration, formatTime, formatTokens, formatUsd } from "../../format.js";
import { MAIN_ID, type SelectedId } from "./agentTree.js";
import { axisTicks, buildWaterfallRows, type WaterfallRow } from "./waterfall.js";

interface Props {
  session: SessionJson;
  selected: SelectedId;
  onSelect: (id: SelectedId) => void;
}

function tooltipText(row: WaterfallRow): string {
  if (row.kind === "task") {
    return row.durationMs !== undefined ? formatDuration(row.durationMs) : "duration unknown";
  }
  const parts: string[] = [];
  if (row.tokens !== undefined) parts.push(`${formatTokens(row.tokens)} tok`);
  if (row.costUsd !== undefined) parts.push(formatUsd(row.costUsd));
  if (row.durationMs !== undefined) parts.push(formatDuration(row.durationMs));
  return parts.length > 0 ? parts.join(" · ") : "no timing captured";
}

/**
 * Waterfall view — real concurrency over the session's wall-clock span. See
 * design-spec/13-orchestration.md's `.wrow`/`.wtrk`/`.wbar` sample.
 */
export function WaterfallView({ session, selected, onSelect }: Props) {
  const { rows, span } = useMemo(() => buildWaterfallRows(session), [session]);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const hovered = rows.find((r) => r.key === hoverKey);

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "16px 20px" }}>
        <div className="chartcap">
          <span className="lbl">
            Same toggle · Waterfall
            {span !== undefined &&
              ` — real concurrency over ${formatTime(new Date(span.start).toISOString())} → ${formatTime(new Date(span.end).toISOString())}`}
          </span>
        </div>
        {span === undefined && (
          <p className="mut fs12">
            Session start/end timestamps aren&apos;t both available — showing rows without a time
            axis.
          </p>
        )}
        <div style={{ position: "relative" }}>
          {rows.map((row) => {
            const isSelected = row.kind === "agent" && row.agentId === selected;
            const isMain = row.kind === "main" && selected === MAIN_ID;
            const clickable = row.kind === "main" || row.kind === "agent";
            return (
              <div className="wrow" key={row.key}>
                <span className="wlab">{row.label}</span>
                <div className="wtrk">
                  <button
                    type="button"
                    className={`wbar${row.colorClass !== undefined ? ` c-${row.colorClass}` : ""}${!row.hasTiming ? " notiming" : ""}${isSelected || isMain ? " sel" : ""}`}
                    style={{
                      left: `${row.left}%`,
                      width: `${row.width}%`,
                      ...(row.opacity !== undefined && { opacity: row.opacity }),
                      ...(row.colorClass === undefined && row.hasTiming && row.kind === "task"
                        ? { background: "var(--mut)" }
                        : undefined),
                    }}
                    disabled={!clickable}
                    onClick={() => {
                      if (row.kind === "main") onSelect(MAIN_ID);
                      else if (row.agentId !== undefined) onSelect(row.agentId);
                    }}
                    onMouseEnter={() => setHoverKey(row.key)}
                    onMouseLeave={() => setHoverKey((k) => (k === row.key ? null : k))}
                  />
                  {hovered?.key === row.key && (
                    <div className="chart-tooltip" style={{ left: `${row.left}%`, top: "-26px" }}>
                      {row.label} · {tooltipText(row)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {span !== undefined && (
          <div className="fx jb mono fs10 mut mt8" style={{ paddingLeft: "168px" }}>
            {axisTicks(span).map((t) => (
              <span key={t}>{formatTime(new Date(t).toISOString())}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
