import type { CSSProperties } from "react";
import type { SessionJson } from "../../api.js";
import { formatTime, formatTokens } from "../../format.js";
import {
  interleaveTurnsAndCompactions,
  turnStackHeights,
  turnStackTotal,
} from "./timelineLayout.js";

interface Props {
  session: SessionJson;
}

function segmentStyle(px: number): CSSProperties {
  return { height: `${String(px)}px` };
}

/**
 * Per-turn stacked token composition (Context & cost lens, row 2) — see
 * design-spec/14-context-cost.md. One `.scol` column per user turn
 * (`session.turnUsage`), `.svd` dashed dividers wherever a compaction falls
 * between turns (via `interleaveTurnsAndCompactions`).
 */
export function TurnCompositionChart({ session }: Props) {
  const turns = session.turnUsage;
  const hasUsage = turns.some((t) => turnStackTotal(t) > 0);

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "18px 20px" }}>
        <div className="chartcap">
          <span className="lbl">Per-turn token composition</span>
          <span className="fx gap12">
            <span className="lg">
              <span className="lgs k-cr" />
              cache read
            </span>
            <span className="lg">
              <span className="lgs k-cw" />
              cache write
            </span>
            <span className="lg">
              <span className="lgs k-in" />
              fresh in
            </span>
            <span className="lg">
              <span className="lgs k-out" />
              output
            </span>
          </span>
        </div>
        {!hasUsage ? (
          <p className="mut fs12">No API usage recorded for this session.</p>
        ) : (
          <ChartBody session={session} turns={turns} />
        )}
      </div>
    </div>
  );
}

function ChartBody({ session, turns }: { session: SessionJson; turns: SessionJson["turnUsage"] }) {
  const maxTotal = Math.max(0, ...turns.map(turnStackTotal));
  const items = interleaveTurnsAndCompactions(turns, session.compactions);

  const footer: Array<{ key: string; label: string; amber?: boolean }> = [];
  if (turns.length > 0) footer.push({ key: "first", label: "turn 1" });
  for (const compaction of [...session.compactions].sort((a, b) => a.line - b.line)) {
    footer.push({
      key: `c-${String(compaction.line)}`,
      label: `✕ ${compaction.timestamp !== undefined ? formatTime(compaction.timestamp) : "compaction"}`,
      amber: true,
    });
  }
  if (turns.length > 1) footer.push({ key: "last", label: `turn ${String(turns.length)}` });

  return (
    <>
      <div className="stk">
        {items.map((item) => {
          if (item.kind === "compaction") {
            return <span key={`svd-${String(item.compaction.line)}`} className="svd" />;
          }
          const heights = turnStackHeights(item.turn, maxTotal);
          const turnNumber = item.index + 1;
          const title =
            `turn ${String(turnNumber)} · L${String(item.turn.line)} — ` +
            `cache read ${formatTokens(item.turn.cacheReadTokens)} / ` +
            `cache write ${formatTokens(item.turn.cacheCreationTokens)} / ` +
            `fresh in ${formatTokens(item.turn.inputTokens)} / ` +
            `out ${formatTokens(item.turn.outputTokens)}`;
          return (
            <div className="scol" key={item.turn.line} title={title}>
              <span className="sseg k-cr" style={segmentStyle(heights.cacheRead)} />
              <span className="sseg k-cw" style={segmentStyle(heights.cacheWrite)} />
              <span className="sseg k-in" style={segmentStyle(heights.freshIn)} />
              <span className="sseg k-out" style={segmentStyle(heights.output)} />
            </div>
          );
        })}
      </div>
      <div className="fx jb mono fs10 mut mt8">
        {footer.map((f) => (
          <span key={f.key} className={f.amber === true ? "amb" : undefined}>
            {f.label}
          </span>
        ))}
      </div>
    </>
  );
}
