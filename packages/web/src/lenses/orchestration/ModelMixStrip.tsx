import type { SessionJson } from "../../api.js";
import { formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import { mainDelegatedSplit, totalTokensOf } from "./agentTree.js";

interface Props {
  session: SessionJson;
}

/**
 * Right-hand half of the controls row — per-model token/cost totals plus the
 * main-vs-delegated cost split. See design-spec/13-orchestration.md's
 * `.mono fs11 mut` legend row.
 */
export function ModelMixStrip({ session }: Props) {
  const rows = session.totalUsageByModel
    .filter((m) => (m.costUsd ?? 0) > 0 || m.outputTokens > 0 || m.inputTokens > 0)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  const { mainPct, delegatedPct } = mainDelegatedSplit(session);

  return (
    <div className="fx ac gap12 mono fs11 mut" style={{ flexWrap: "wrap" }}>
      {rows.map((m) => (
        <span className="fx ac gap6" key={m.model}>
          <span className={`mdot c-${classifyModel(m.model)}`} />
          {modelShortLabel(m.model)} {formatTokens(totalTokensOf(m))} · {formatUsd(m.costUsd ?? 0)}
        </span>
      ))}
      <span>
        main {mainPct}% / delegated {delegatedPct}%
      </span>
    </div>
  );
}
