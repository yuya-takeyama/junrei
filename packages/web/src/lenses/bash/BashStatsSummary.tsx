import type { ReactNode } from "react";
import type { BashStatsJson } from "../../api.js";
import { formatTokens } from "../../format.js";
import { formatEstimatedTokens } from "./bashLensFormat.js";

interface Props {
  totals: BashStatsJson["totals"];
}

/** Same `.pan.tile` shape as `ContextCost.tsx`'s local `StatTile` — kept as its own small copy (four fields, one lens) rather than sharing a component across two lens files for one four-line render. */
function StatTile({ label, big, sub }: { label: string; big: ReactNode; sub: ReactNode }) {
  return (
    <div className="pan tile" style={{ minWidth: 0 }}>
      <div className="lbl">{label}</div>
      <div className="big mt8">{big}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

/**
 * Context consumption stat row (Bash lens panel 2, top) — total Bash calls
 * (+ error count folded into the same tile, mirroring `StatStrip`'s
 * "Compact / API err" combined-cell convention), input/result chars, and
 * estimated tokens. The estimated-tokens tile always carries the `≈` prefix
 * (`formatEstimatedTokens`) — see `BashTotals.estimatedTokens`'s doc comment
 * in `@junrei/core`: `Math.ceil(chars / 4)`, never a real tokenizer count.
 */
export function BashStatsSummary({ totals }: Props) {
  return (
    <div className="fx gap12 mt16">
      <StatTile
        label="Bash calls"
        big={totals.calls}
        sub={
          <span className={totals.errors > 0 ? "errtx" : undefined}>
            {totals.errors} {totals.errors === 1 ? "error" : "errors"}
          </span>
        }
      />
      <StatTile label="Input chars" big={formatTokens(totals.inputChars)} sub="sent to shell" />
      <StatTile
        label="Result chars"
        big={formatTokens(totals.resultChars)}
        sub="returned to agent"
      />
      <StatTile
        label="Est. tokens"
        big={<span className="approx">{formatEstimatedTokens(totals.estimatedTokens)}</span>}
        sub="input + result, ~4 chars/tok"
      />
    </div>
  );
}
