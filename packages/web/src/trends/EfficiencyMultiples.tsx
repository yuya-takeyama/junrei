import type { TrendBucket } from "@junrei/core";
import { formatTokens } from "../format.js";
import {
  approxTokensFromChars,
  avgSubagentReturnChars,
  compactionsPerSession,
  type SparklineGeometryOptions,
  type SparklinePoint,
  sparklineGeometry,
  sparklinePointsAttr,
  windowMaxSubagentReturnChars,
} from "./trendsLayout.js";

interface Props {
  buckets: readonly TrendBucket[];
}

const WIDTH = 200;
const HEIGHT = 36;

/**
 * The mission's own reference point for a subagent return's size — "typical
 * worker summary: 1–2k tokens" (docs/concept.md §4.6) — shown as a shaded
 * band, not a red/green judgment: the doc comment there explicitly allows
 * "reference points from published research ... shown as annotations,
 * clearly sourced", which is exactly what this is.
 */
const SUBAGENT_RETURN_BENCHMARK_TOKENS = { min: 1000, max: 2000 };

function Sparkline({
  label,
  values,
  formatValue,
  sub,
  maxSub,
  geometryOpts,
}: {
  label: string;
  values: readonly (number | null)[];
  formatValue: (v: number) => string;
  sub: string;
  /** Extra sub-label segment (e.g. "max ≈ 10.2k") for surfacing an outlier a mean alone would hide — see `EfficiencyMultiples`'s own doc comment. */
  maxSub?: string;
  geometryOpts?: SparklineGeometryOptions;
}) {
  const geometry = sparklineGeometry(values, WIDTH, HEIGHT, geometryOpts);
  // Most-recent-day value with data, skipping any trailing null gap —
  // the small multiple's headline number, same "latest reading" convention
  // a sparkline card implies.
  const latest = [...values].reverse().find((v): v is number => v !== null);
  const points: SparklinePoint[] = geometry.segments.flat();

  return (
    <div className="pan tile" style={{ minWidth: 0 }}>
      <div className="lbl">{label}</div>
      <div className="big mt8">{latest !== undefined ? formatValue(latest) : "—"}</div>
      <div className="sub">
        {sub}
        {maxSub !== undefined && <span className="mut"> · {maxSub}</span>}
      </div>
      {points.length === 0 ? (
        <p className="mut fs11 mt8">No data in this window.</p>
      ) : (
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          width="100%"
          height={HEIGHT}
          className="mt8"
          role="img"
          aria-label={`${label} per day`}
        >
          {geometry.referenceBandY !== undefined && (
            <rect
              className="efm-band"
              x={0}
              y={geometry.referenceBandY.top}
              width={WIDTH}
              height={Math.max(0, geometry.referenceBandY.bottom - geometry.referenceBandY.top)}
            />
          )}
          {geometry.segments.map((segment) => (
            <polyline
              key={`seg-${String(segment[0]?.index ?? 0)}`}
              className="efm-spark"
              points={sparklinePointsAttr(segment)}
            />
          ))}
          {points.map((p) => (
            <circle key={p.index} className="efm-dot" cx={p.x} cy={p.y} r={1.6} />
          ))}
        </svg>
      )}
    </div>
  );
}

/**
 * Efficiency small-multiples row (Trends screen spec item 6) — three compact
 * per-day sparklines: cache hit rate, compactions per session, and average
 * subagent-return size. Each reuses `sparklineGeometry`'s null-gap handling
 * (`trendsLayout.ts`) so a sessionless day breaks the line instead of
 * plotting a misleading 0.
 *
 * Cache hit rate is zero-anchored to a FIXED `{min: 0, max: 1}` domain
 * (`geometryOpts.domain`) rather than auto-scaled to its own min/max — a
 * healthy, stable series (say, steady 95–98%) would otherwise get stretched
 * to fill the sparkline's full height and read as a wild cliff, when the
 * true picture is "flat and fine". A 0..1 fraction is treated the same as
 * the "fixed 0–100 for rate metrics" convention this option calls for.
 *
 * The subagent-return panel converts `returnedChars` to an APPROXIMATE token
 * count (`approxTokensFromChars`, chars ÷ 4) and labels every figure it
 * shows as an estimate — the earlier version formatted raw chars through the
 * same token-style "1.6k" formatter used for real token counts elsewhere,
 * which reads as tokens but wasn't, silently misrepresenting the size
 * relative to the mission's own 1–2k-TOKEN benchmark (see
 * `SUBAGENT_RETURN_BENCHMARK_TOKENS`, rendered as a reference band). The
 * mean alone also hides exactly the kind of one-off huge-context-dump leak
 * this signal exists to catch (a 40k-char return buried inside an otherwise-
 * normal daily average), so the window's single largest return
 * (`windowMaxSubagentReturnChars`, itself sourced from `TrendBucket
 * .subagentReturn.maxChars` — a per-day MAX across sessions, not a sum) is
 * surfaced as its own sub-label.
 */
export function EfficiencyMultiples({ buckets }: Props) {
  const cacheHit = buckets.map((b) => b.cacheHitRate);
  const compactions = buckets.map((b) => compactionsPerSession(b));
  const subagentReturnTokens = buckets.map((b) => {
    const chars = avgSubagentReturnChars(b);
    return chars === null ? null : approxTokensFromChars(chars);
  });
  const windowMaxChars = windowMaxSubagentReturnChars(buckets);
  const windowMaxTokens = windowMaxChars === null ? null : approxTokensFromChars(windowMaxChars);

  return (
    <div className="hpad mt16">
      <div className="efm-grid">
        <Sparkline
          label="Cache hit rate"
          values={cacheHit}
          formatValue={(v) => `${(v * 100).toFixed(0)}%`}
          sub="of input tokens, per day"
          geometryOpts={{ domain: { min: 0, max: 1 } }}
        />
        <Sparkline
          label="Compactions / session"
          values={compactions}
          formatValue={(v) => v.toFixed(2)}
          sub="context resets per session"
        />
        <Sparkline
          label="Avg subagent return"
          values={subagentReturnTokens}
          formatValue={(v) => `≈ ${formatTokens(Math.round(v))}`}
          sub="≈ tokens (chars÷4), per call · ref 1–2k"
          {...(windowMaxTokens !== null && {
            maxSub: `max ≈ ${formatTokens(Math.round(windowMaxTokens))}`,
          })}
          geometryOpts={{ referenceBand: SUBAGENT_RETURN_BENCHMARK_TOKENS }}
        />
      </div>
    </div>
  );
}
