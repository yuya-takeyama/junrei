import type { AnySessionJson } from "../../api.js";
import { formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import { EstBadge } from "../../shell/EstBadge.js";

interface Props {
  session: AnySessionJson;
}

/**
 * Cost-by-model TABLE (Context & cost lens, row 3) — see
 * design-spec/14-context-cost.md's `.cmg` grid. Distinct from the Overview
 * lens's `CostByModelChart` (bar-row list): this shows the fresh-in /
 * cache-read / cache-write / output token breakdown per model, not just
 * cost, so it stays a separate component fed by the same
 * `totalUsageByModel` (main + every subagent, recursively merged).
 */
export function CostByModelTable({ session }: Props) {
  // Same zero-usage filter as CostByModelChart: drop synthetic/placeholder
  // model entries that never actually billed or produced tokens.
  const rows = session.totalUsageByModel
    .filter((m) => (m.costUsd ?? 0) > 0 || m.outputTokens > 0 || m.inputTokens > 0)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  const totals = rows.reduce(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
    }),
    { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
  );

  return (
    <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }}>
      <div className="cmg hdr">
        <span className="lbl">Model</span>
        <span className="lbl cellr">Fresh in</span>
        <span className="lbl cellr">Cache read</span>
        <span className="lbl cellr">Cache write</span>
        <span className="lbl cellr">Output</span>
        <span className="lbl cellr">Cost</span>
      </div>
      {rows.length === 0 ? (
        <p className="mut fs12" style={{ padding: "10px 16px", margin: 0 }}>
          No priced usage in this session.
        </p>
      ) : (
        <>
          {rows.map((m) => (
            <div className="cmg" key={m.model}>
              <span className="fx ac gap6">
                <span className={`mdot c-${classifyModel(m.model)}`} />
                <span className="mono fs11">{modelShortLabel(m.model)}</span>
              </span>
              <span className="num fs12 cellr">{formatTokens(m.inputTokens)}</span>
              <span className="num fs12 cellr">{formatTokens(m.cacheReadTokens)}</span>
              <span className="num fs12 cellr">{formatTokens(m.cacheCreationTokens)}</span>
              <span className="num fs12 cellr">{formatTokens(m.outputTokens)}</span>
              <span className="num fs12 cellr">{formatUsd(m.costUsd ?? 0)}</span>
            </div>
          ))}
          <div className="cmg" style={{ borderBottom: 0 }}>
            <span className="mono fs11 mut">total</span>
            <span className="num fs12 cellr">{formatTokens(totals.inputTokens)}</span>
            <span className="num fs12 cellr">{formatTokens(totals.cacheReadTokens)}</span>
            <span className="num fs12 cellr">{formatTokens(totals.cacheCreationTokens)}</span>
            <span className="num fs12 cellr">{formatTokens(totals.outputTokens)}</span>
            <span className="num fs12 cellr amb">
              {formatUsd(session.totalUsage.costUsd)}
              {session.totalUsage.costIsComplete ? "" : "*"}
              {session.source === "codex" && <EstBadge />}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
