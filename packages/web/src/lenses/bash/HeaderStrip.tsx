import type { BashStatsJson, SessionBashPercentileJson } from "../../api.js";
import { buildHeaderStrip } from "./bashLensFormat.js";

interface Props {
  totals: BashStatsJson["totals"];
  bashPercentile: SessionBashPercentileJson | undefined;
  source: "claude-code" | "codex";
}

/**
 * Header strip (Bash lens, top) — the lede, per the v2 redesign brief: "top
 * of screen = the decision, not the data". Renders the headline $/token
 * figure plus, when the server's `bashPercentile` seam cleared its
 * not-enough-repo-history gate (`bash-percentile.ts`), a percentile chip
 * comparing this session against the rest of its repo. The chip is entirely
 * ABSENT (not a disabled/greyed placeholder) when `bashPercentile` is
 * `undefined` — a thin repo history isn't an error state worth a visual
 * complaint about.
 *
 * Pure presentational — all the fallback/formatting logic lives in
 * `buildHeaderStrip` (`bashLensFormat.ts`), independently unit-tested there.
 */
export function HeaderStrip({ totals, bashPercentile, source }: Props) {
  const model = buildHeaderStrip(totals, bashPercentile, source);

  return (
    <div className="pan" style={{ padding: "18px 20px" }}>
      <div className="fx ac jb" style={{ flexWrap: "wrap", gap: "12px" }}>
        <div>
          <div className="lbl">Bash context cost</div>
          <div className={model.isUsd ? "big mt8" : "big mt8 mut"}>{model.costText}</div>
        </div>
        {model.percentileText !== undefined && (
          <span className="chip" title={model.tooltip}>
            {model.percentileText}
            {model.medianRatioText !== undefined && ` · ${model.medianRatioText}`}
          </span>
        )}
      </div>
    </div>
  );
}
