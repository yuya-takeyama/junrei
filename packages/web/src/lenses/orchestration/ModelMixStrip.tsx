import type { AnySessionJson } from "../../api.js";
import { formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import { mainDelegatedSplit, mainDelegatedTokenSplit, totalTokensOf } from "./agentTree.js";

interface Props {
  session: AnySessionJson;
}

/**
 * Right-hand half of the controls row — per-model token/cost totals plus the
 * main-vs-delegated split, both by cost and by token volume (the two often
 * rank in opposite directions — see `mainDelegatedTokenSplit`). See
 * design-spec/13-orchestration.md's `.mono fs11 mut` legend row.
 */
export function ModelMixStrip({ session }: Props) {
  const rows = session.totalUsageByModel
    .filter((m) => (m.costUsd ?? 0) > 0 || m.outputTokens > 0 || m.inputTokens > 0)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  const { mainPct } = mainDelegatedSplit(session);
  const { mainPct: mainTokenPct } = mainDelegatedTokenSplit(session);

  return (
    <div className="fx ac gap12 mono fs11 mut" style={{ flexWrap: "wrap" }}>
      {rows.map((m) => (
        <span className="fx ac gap6" key={m.model}>
          <span className={`mdot c-${classifyModel(m.model)}`} />
          {modelShortLabel(m.model)} {formatTokens(totalTokensOf(m))} · {formatUsd(m.costUsd ?? 0)}
        </span>
      ))}
      <span>
        main {mainPct}% cost · {mainTokenPct}% tokens
      </span>
    </div>
  );
}
