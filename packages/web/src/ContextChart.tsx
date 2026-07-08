import { useMemo, useState } from "react";
import { formatTokens } from "./format.js";

interface Point {
  contextTokens: number;
  outputTokens: number;
  timestamp?: string | undefined;
  messageId: string;
}

interface Compaction {
  timestamp?: string | undefined;
  preTokens?: number | undefined;
  postTokens?: number | undefined;
  trigger?: string | undefined;
}

interface Props {
  points: Point[];
  compactions: Compaction[];
}

const WIDTH = 920;
const HEIGHT = 220;
const PAD_LEFT = 56;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

/**
 * Context growth over API messages (x = message index, y = effective context
 * tokens). Single series, so no legend; compactions render as reference
 * markers. Hand-rolled SVG with a crosshair tooltip.
 */
export function ContextChart({ points, compactions }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const { path, xFor, yFor, maxY, ticks, compactionXs } = useMemo(() => {
    const maxYRaw = Math.max(1, ...points.map((p) => p.contextTokens));
    const niceMax = niceCeil(maxYRaw);
    const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
    const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const xForFn = (i: number) =>
      PAD_LEFT + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const yForFn = (v: number) => PAD_TOP + innerH - (v / niceMax) * innerH;
    const d = points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${xForFn(i).toFixed(1)},${yForFn(p.contextTokens).toFixed(1)}`,
      )
      .join(" ");
    const tickValues = [0, niceMax / 2, niceMax];

    // Place compaction markers between the surrounding points by timestamp.
    const xs: number[] = [];
    for (const compaction of compactions) {
      if (compaction.timestamp === undefined) continue;
      const t = Date.parse(compaction.timestamp);
      let index = points.findIndex(
        (p) => p.timestamp !== undefined && Date.parse(p.timestamp) >= t,
      );
      if (index === -1) index = points.length - 1;
      if (index >= 0) xs.push(xForFn(Math.max(0, index - 0.5)));
    }
    return {
      path: d,
      xFor: xForFn,
      yFor: yForFn,
      maxY: niceMax,
      ticks: tickValues,
      compactionXs: xs,
    };
  }, [points, compactions]);

  if (points.length === 0) {
    return <p className="muted">No usage records in this session.</p>;
  }

  const hovered = hover !== null ? points[hover] : undefined;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label="Context tokens per API message"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
          const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
          const ratio = Math.min(1, Math.max(0, (x - PAD_LEFT) / innerW));
          setHover(Math.round(ratio * (points.length - 1)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke="var(--gridline)"
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 8}
              y={yFor(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--text-muted)"
            >
              {formatTokens(t)}
            </text>
          </g>
        ))}
        <line
          x1={PAD_LEFT}
          x2={WIDTH - PAD_RIGHT}
          y1={HEIGHT - PAD_BOTTOM}
          y2={HEIGHT - PAD_BOTTOM}
          stroke="var(--baseline)"
          strokeWidth={1}
        />
        {compactionXs.map((x, i) => (
          <g key={`c${String(i)}`}>
            <line
              x1={x}
              x2={x}
              y1={PAD_TOP}
              y2={HEIGHT - PAD_BOTTOM}
              stroke="var(--series-3)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text x={x + 4} y={PAD_TOP + 10} fontSize={10} fill="var(--series-3)">
              compaction
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        {hover !== null && hovered !== undefined && (
          <g>
            <line
              x1={xFor(hover)}
              x2={xFor(hover)}
              y1={PAD_TOP}
              y2={HEIGHT - PAD_BOTTOM}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            <circle
              cx={xFor(hover)}
              cy={yFor(hovered.contextTokens)}
              r={4}
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
          </g>
        )}
        <text
          x={WIDTH - PAD_RIGHT}
          y={HEIGHT - 8}
          textAnchor="end"
          fontSize={11}
          fill="var(--text-muted)"
        >
          API message #{points.length} · peak {formatTokens(maxY)}
        </text>
      </svg>
      {hover !== null && hovered !== undefined && (
        <div
          className="chart-tooltip"
          style={{
            left: `${((xFor(hover) / WIDTH) * 100).toFixed(1)}%`,
            top: 0,
          }}
        >
          <div>
            message #{hover + 1} · context <strong>{formatTokens(hovered.contextTokens)}</strong>
          </div>
          <div className="muted">
            output {formatTokens(hovered.outputTokens)}
            {hovered.timestamp !== undefined
              ? ` · ${new Date(hovered.timestamp).toLocaleTimeString()}`
              : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function niceCeil(v: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * magnitude) return m * magnitude;
  }
  return 10 * magnitude;
}
