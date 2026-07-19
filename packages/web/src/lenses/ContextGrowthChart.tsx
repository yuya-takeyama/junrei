import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { AnySessionJson } from "../api.js";
import { formatTime, formatTokens } from "../format.js";
import { sessionPath, sessionRefOf } from "../router.js";

interface Props {
  session: AnySessionJson;
  /**
   * Overrides the "→ context & cost" link target — used by the agent detail
   * shell (L3) to point at its own (placeholder) context lens instead of the
   * session-level one this component defaults to.
   */
  contextHref?: string;
  /**
   * Skips the outer full-width `.hpad.mt16` wrapper and uses `.pan.f1`
   * (flexible width) instead of a bare `.pan` — for embedding inside a
   * caller-built flex row alongside another panel, e.g. the agent detail
   * shell's (L3) context-growth + "return to parent" row (design-spec/16).
   */
  bare?: boolean;
}

const WIDTH = 1160;
const HEIGHT = 170;
const PAD_TOP = 12;
const BASELINE_Y = 160;
const INNER_H = BASELINE_Y - PAD_TOP;

interface ChartNode {
  x: number;
  y: number;
  kind: "point" | "pre" | "post";
  /** Only set on regular points — used for the hover tooltip. */
  raw?: { t: number; contextTokens: number; outputTokens: number };
}

interface Geometry {
  linePath: string;
  areaPath: string;
  markers: Array<{ x: number; label: string }>;
  gridTicks: Array<{ y: number; label: string }>;
  xLabels: Array<{ frac: number; label: string }>;
  hoverNodes: ChartNode[];
}

function niceCeil(v: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * magnitude) return m * magnitude;
  }
  return 10 * magnitude;
}

function buildGeometry(session: AnySessionJson): Geometry | null {
  const rawPoints = session.contextTimeline
    .filter((p) => p.timestamp !== undefined)
    .map((p) => ({
      t: Date.parse(p.timestamp as string),
      y: p.contextTokens,
      outputTokens: p.outputTokens,
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (rawPoints.length === 0) return null;

  const compactionEvents = session.compactions
    .filter(
      (c) => c.timestamp !== undefined && c.preTokens !== undefined && c.postTokens !== undefined,
    )
    .map((c) => ({
      t: Date.parse(c.timestamp as string),
      pre: c.preTokens as number,
      post: c.postTokens as number,
    }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);

  const allTs = [...rawPoints.map((p) => p.t), ...compactionEvents.map((c) => c.t)];
  const tMin = Math.min(...allTs);
  const tMax = Math.max(...allTs);
  const span = tMax - tMin;

  const maxY = Math.max(
    1,
    ...rawPoints.map((p) => p.y),
    ...compactionEvents.map((c) => Math.max(c.pre, c.post)),
  );
  const niceMax = niceCeil(maxY);

  const xFor = (t: number) => (span <= 0 ? WIDTH / 2 : ((t - tMin) / span) * WIDTH);
  const yFor = (v: number) => PAD_TOP + INNER_H - (v / niceMax) * INNER_H;

  // Chronologically merge points and compaction breaks. A compaction becomes
  // two nodes at the same x — "pre" closes the current subpath at the high
  // pre-compaction value, "post" opens the next one at the post-compaction
  // value — producing the sawtooth without interpolating across the drop.
  const nodes: ChartNode[] = [];
  let pi = 0;
  let ci = 0;
  while (pi < rawPoints.length || ci < compactionEvents.length) {
    const p = rawPoints[pi];
    const c = compactionEvents[ci];
    if (c !== undefined && (p === undefined || c.t <= p.t)) {
      nodes.push({ x: xFor(c.t), y: yFor(c.pre), kind: "pre" });
      nodes.push({ x: xFor(c.t), y: yFor(c.post), kind: "post" });
      ci += 1;
    } else if (p !== undefined) {
      nodes.push({
        x: xFor(p.t),
        y: yFor(p.y),
        kind: "point",
        raw: { t: p.t, contextTokens: p.y, outputTokens: p.outputTokens },
      });
      pi += 1;
    }
  }

  const last = nodes[nodes.length - 1];
  const first = nodes[0];
  const areaPath =
    first === undefined || last === undefined
      ? ""
      : `M${nodes.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join(" L")} L${last.x.toFixed(1)},${BASELINE_Y} L${first.x.toFixed(1)},${BASELINE_Y} Z`;

  let linePath = "";
  nodes.forEach((n, i) => {
    linePath += `${i === 0 || n.kind === "post" ? "M" : "L"}${n.x.toFixed(1)},${n.y.toFixed(1)} `;
  });

  const markers = compactionEvents.map((c) => ({
    x: xFor(c.t),
    label: `✕ compaction ${formatTime(new Date(c.t).toISOString())}`,
  }));

  const gridTicks = [
    { y: PAD_TOP, label: formatTokens(niceMax) },
    { y: PAD_TOP + INNER_H / 2, label: formatTokens(niceMax / 2) },
  ];

  const xLabels =
    span <= 0
      ? [{ frac: 0, label: formatTime(new Date(tMin).toISOString()) }]
      : [0, 0.25, 0.5, 0.75, 1].map((f) => ({
          frac: f,
          label: formatTime(new Date(tMin + f * span).toISOString()),
        }));

  return {
    linePath,
    areaPath,
    markers,
    gridTicks,
    xLabels,
    hoverNodes: nodes.filter((n) => n.kind === "point"),
  };
}

/** Context-growth chart (headline panel) — see design-spec/11-session-overview.md. */
export function ContextGrowthChart({ session, contextHref, bare = false }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => buildGeometry(session), [session]);
  const resolvedContextHref =
    contextHref ?? sessionPath(sessionRefOf(session), "evidence", "context");
  const hovered =
    hoverIndex !== null && geometry !== null ? geometry.hoverNodes[hoverIndex] : undefined;

  const card = (
    <div
      className={bare ? "pan f1" : "pan"}
      style={{ padding: "18px 20px", ...(bare && { minWidth: 0 }) }}
    >
      <div className="chartcap">
        <span className="lbl">Context growth · tokens in window</span>
        <Link className="linkc mono fs11" to={resolvedContextHref}>
          → context &amp; cost
        </Link>
      </div>
      {geometry === null ? (
        <p className="mut fs12">No usage records in this session.</p>
      ) : (
        <>
          <div className="chart-wrap">
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              width="100%"
              height={HEIGHT}
              role="img"
              aria-label="Context tokens over time"
              onMouseLeave={() => setHoverIndex(null)}
              onMouseMove={(e) => {
                if (geometry.hoverNodes.length === 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
                let nearest = 0;
                let nearestDist = Number.POSITIVE_INFINITY;
                geometry.hoverNodes.forEach((n, i) => {
                  const dist = Math.abs(n.x - x);
                  if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = i;
                  }
                });
                setHoverIndex(nearest);
              }}
            >
              <line className="gl" x1={0} y1={12} x2={WIDTH} y2={12} strokeDasharray="2 4" />
              <line className="gl" x1={0} y1={86} x2={WIDTH} y2={86} strokeDasharray="2 4" />
              <line className="gl" x1={0} y1={BASELINE_Y} x2={WIDTH} y2={BASELINE_Y} />
              {geometry.gridTicks.map((t) => (
                <text key={t.y} className="axis" x={4} y={t.y + 12}>
                  {t.label}
                </text>
              ))}
              <path className="carea" d={geometry.areaPath} />
              <path className="cline" d={geometry.linePath} />
              {geometry.markers.map((m) => (
                <g key={`${m.x}-${m.label}`}>
                  <line className="cmark" x1={m.x} y1={16} x2={m.x} y2={BASELINE_Y} />
                  <text className="axamb" x={m.x + 6} y={26}>
                    {m.label}
                  </text>
                </g>
              ))}
              {hovered !== undefined && (
                <g>
                  <line x1={hovered.x} x2={hovered.x} y1={PAD_TOP} y2={BASELINE_Y} className="gl" />
                  <circle cx={hovered.x} cy={hovered.y} r={3.5} fill="var(--amb)" />
                </g>
              )}
            </svg>
            {hovered?.raw !== undefined && (
              <div
                className="chart-tooltip"
                style={{ left: `${((hovered.x / WIDTH) * 100).toFixed(1)}%`, top: 0 }}
              >
                context {formatTokens(hovered.raw.contextTokens)} · out{" "}
                {formatTokens(hovered.raw.outputTokens)} ·{" "}
                {formatTime(new Date(hovered.raw.t).toISOString())}
              </div>
            )}
          </div>
          <div className="fx jb mono fs10 mut mt8">
            {geometry.xLabels.map((x) => (
              <span key={x.frac}>{x.label}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );

  return bare ? card : <div className="hpad mt16">{card}</div>;
}
