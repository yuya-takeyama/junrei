import type { AnySessionJson } from "../api.js";
import { BashStatsSummary } from "./bash/BashStatsSummary.js";
import { hasBashActivity } from "./bash/bashLensFormat.js";
import { CommandRankingTable } from "./bash/CommandRankingTable.js";
import { HeavyHittersTable } from "./bash/HeavyHittersTable.js";
import { WasteDetectionPanel } from "./bash/WasteDetectionPanel.js";

interface Props {
  session: AnySessionJson;
  /** Opens the record slide-over (L3) for a source line — see `HeavyHittersTable`. `agentId` scopes the fetch to a subagent's own transcript, when the line came from one. */
  onOpenRecord?: (line: number, agentId?: string) => void;
}

/**
 * Bash lens (L2) — source-uniform (see `bashStats` on `SessionAnalysisCore`
 * in `@junrei/core`'s `shared/session-analysis.ts`; both `analyzeClaudeSession`
 * and `analyzeCodexSession`/`getCodexSession` populate it). Three panels,
 * laid out top-to-bottom as full-width sections (unlike Files & skills/
 * Context & cost's two-column rows, since none of these three panels pair
 * naturally side-by-side):
 *
 *   1. Command ranking — `byCommand`, one row per resolved family+subcommand
 *      group, already sorted by result chars desc.
 *   2. Context consumption — a stat-tile summary row (`BashStatsSummary`)
 *      over `totals`, then the top-10 `heavyHitters` table.
 *   3. Waste detection — `waste`'s four subsections (near-duplicates, large
 *      results, rerun-after-error, bash-as-read).
 *
 * Quantitative only throughout — counts, char totals, line-number
 * occurrences — no advice/hint prose. That's a deliberate scope decision
 * carried over from `@junrei/core`'s `BashWaste` doc comment: this PR wires
 * the data into the UI, a later PR (if any) would be the one to turn
 * "near-duplicate ×5" into an actionable suggestion.
 */
export function Bash({ session, onOpenRecord }: Props) {
  const { bashStats } = session;

  if (!hasBashActivity(bashStats.totals)) {
    return (
      <div className="hpad mt16">
        <div className="pan tile mut">No Bash calls recorded in this session.</div>
      </div>
    );
  }

  return (
    <>
      <div className="hpad mt16">
        <CommandRankingTable byCommand={bashStats.byCommand} />
      </div>
      <div className="hpad">
        <BashStatsSummary totals={bashStats.totals} />
        <HeavyHittersTable
          heavyHitters={bashStats.heavyHitters}
          {...(onOpenRecord !== undefined && { onOpenRecord })}
        />
      </div>
      <div className="hpad">
        <WasteDetectionPanel waste={bashStats.waste} />
      </div>
    </>
  );
}
