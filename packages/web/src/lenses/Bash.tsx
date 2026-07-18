import { useState } from "react";
import type { AnySessionJson } from "../api.js";
import type { SortSpec } from "../tableSort.js";
import { BashStatsSummary } from "./bash/BashStatsSummary.js";
import { hasBashActivity } from "./bash/bashLensFormat.js";
import {
  type CommandRankingSortKey,
  CommandRankingTable,
  DEFAULT_COMMAND_RANKING_SORT,
} from "./bash/CommandRankingTable.js";
import {
  DEFAULT_HEAVY_HITTER_SORT,
  type HeavyHitterSortKey,
  HeavyHittersTable,
} from "./bash/HeavyHittersTable.js";
import {
  DEFAULT_BASH_AS_READ_SORT,
  DEFAULT_LARGE_RESULTS_SORT,
  type FlatWasteSortKey,
  WasteDetectionPanel,
} from "./bash/WasteDetectionPanel.js";

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
 *      group, sortable by every column (default: result chars desc, matching
 *      the engine's own order).
 *   2. Context consumption — a stat-tile summary row (`BashStatsSummary`)
 *      over `totals`, then the top-10 `heavyHitters` table (also sortable).
 *   3. Waste detection — `waste`'s four subsections (near-duplicates, large
 *      results, rerun-after-error, bash-as-read); the two flat grids (large
 *      results, bash-as-read) are sortable, the two free-form group lists
 *      are not (see `WasteDetectionPanel`'s doc comment).
 *
 * Quantitative only throughout — counts, char totals, line-number
 * occurrences — no advice/hint prose. That's a deliberate scope decision
 * carried over from `@junrei/core`'s `BashWaste` doc comment: this PR wires
 * the data into the UI, a later PR (if any) would be the one to turn
 * "near-duplicate ×5" into an actionable suggestion.
 *
 * This is the ONE place in the Bash lens that holds React state: each
 * table below is a pure function component (`CommandRankingTable`,
 * `HeavyHittersTable`, `WasteDetectionPanel`'s flat grids) — no `useState`
 * inside a table itself, because this repo's component tests call
 * components directly as plain functions and walk the returned element
 * tree (no jsdom/testing-library), which only works for hook-free
 * components. So sort state lives here instead, one `useState` per table,
 * seeded from that table's own `DEFAULT_*_SORT` (each exported next to its
 * table so the default lives beside the component it describes) and handed
 * down as a `sortSpec`/`onSortChange` pair — see `tableSort.ts` for the
 * underlying `SortSpec`/`sortRows` primitive every table sorts with.
 */
export function Bash({ session, onOpenRecord }: Props) {
  const { bashStats } = session;

  const [commandRankingSort, setCommandRankingSort] = useState<SortSpec<CommandRankingSortKey>>(
    DEFAULT_COMMAND_RANKING_SORT,
  );
  const [heavyHitterSort, setHeavyHitterSort] =
    useState<SortSpec<HeavyHitterSortKey>>(DEFAULT_HEAVY_HITTER_SORT);
  const [largeResultsSort, setLargeResultsSort] = useState<SortSpec<FlatWasteSortKey>>(
    DEFAULT_LARGE_RESULTS_SORT,
  );
  const [bashAsReadSort, setBashAsReadSort] =
    useState<SortSpec<FlatWasteSortKey>>(DEFAULT_BASH_AS_READ_SORT);

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
        <CommandRankingTable
          byCommand={bashStats.byCommand}
          sortSpec={commandRankingSort}
          onSortChange={setCommandRankingSort}
        />
      </div>
      <div className="hpad">
        <BashStatsSummary totals={bashStats.totals} />
        <HeavyHittersTable
          heavyHitters={bashStats.heavyHitters}
          sortSpec={heavyHitterSort}
          onSortChange={setHeavyHitterSort}
          {...(onOpenRecord !== undefined && { onOpenRecord })}
        />
      </div>
      <div className="hpad">
        <WasteDetectionPanel
          waste={bashStats.waste}
          largeResultsSortSpec={largeResultsSort}
          onLargeResultsSortChange={setLargeResultsSort}
          bashAsReadSortSpec={bashAsReadSort}
          onBashAsReadSortChange={setBashAsReadSort}
        />
      </div>
    </>
  );
}
