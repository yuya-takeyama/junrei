import { useState } from "react";
import type { AnySessionJson } from "../api.js";
import type { SortSpec } from "../tableSort.js";
import { hasBashActivity } from "./bash/bashLensFormat.js";
import {
  type CommandRankingSortKey,
  CommandRankingTable,
  DEFAULT_COMMAND_RANKING_SORT,
  DEFAULT_COMMAND_RANKING_SORT_UNPRICED,
} from "./bash/CommandRankingTable.js";
import { FixQueue } from "./bash/FixQueue.js";
import { HeaderStrip } from "./bash/HeaderStrip.js";
import {
  DEFAULT_HEAVY_HITTER_SORT,
  type HeavyHitterSortKey,
  HeavyHittersTable,
} from "./bash/HeavyHittersTable.js";
import { WhoPaidPanel } from "./bash/WhoPaidPanel.js";

interface Props {
  session: AnySessionJson;
  /** Opens the record slide-over (L3) for a source line — see `HeavyHittersTable`/`FixQueue`. `agentId` scopes the fetch to a subagent's own transcript, when the line came from one. */
  onOpenRecord?: (line: number, agentId?: string) => void;
}

/**
 * Bash lens (L2) — v2 redesign ("top of screen = the decision, not the
 * data"), replacing the v1 data-dump layout (4 stat tiles, a chars-ranked
 * command table, chars-ranked heavy hitters, 4 bare waste-count
 * subsections) end to end. Source-uniform, same as v1 (see `bashStats` on
 * `SessionAnalysisCore` in `@junrei/core`'s `shared/session-analysis.ts`;
 * both `analyzeClaudeSession` and `analyzeCodexSession`/`getCodexSession`
 * populate it).
 *
 * Layout, top to bottom:
 *
 *   ┌ HEADER STRIP ─────────────────────────────────────────────┐
 *   │ Bash context cost ~$X.XX (est)      [pNN for this repo ·  │
 *   │                                       M.Mx median]        │
 *   └─────────────────────────────────────────────────────────┘
 *   ┌ WHO PAID ─────────────────────────────────────────────────┐
 *   │ main (sonnet)   chars ▓░░░░░░░░░ 1.6%    $ ▓▓▓▓▓▓▓▓░░ 81% │
 *   │ sub (haiku)     chars ▓▓▓▓▓▓▓▓▓▓ 60%     $ ▓░░░░░░░░░ 8%  │
 *   │ +N more         chars ▓▓░░░░░░░░ 8.4%    $ ░░░░░░░░░░ 5%  │
 *   └─────────────────────────────────────────────────────────┘
 *   ┌ FIX QUEUE (N) ────────────────────────────────────────────┐
 *   │ #1 [near-duplicate][spawn-prompt]              ~$0.31     │
 *   │    5× "git diff <PATH>" repeated across main, sub1        │
 *   │    ┌ Fix ──────────────────────────────── [copy] ┐        │
 *   │    │ Batch or cache `git diff <PATH>` ...         │        │
 *   │    └───────────────────────────────────────────────┘      │
 *   │    ▸ evidence (5)                                          │
 *   └─────────────────────────────────────────────────────────┘
 *   ┌ COST BY COMMAND ──────────────────────────────  [chars] ──┐
 *   │ Command   Calls  Err  ~Est $  $share  Orch%  Est.tokens   │
 *   │ git diff    12     0   $0.31    74%    12%      3.1k      │
 *   └─────────────────────────────────────────────────────────┘
 *   ▸ EVIDENCE — heavy hitters (10)              [collapsed]
 *   ─────────────────────────────────────────────────────────────
 *   ~ token/$ figures are chars/4 × model input price estimates;
 *   compound commands can mis-bucket families; Codex
 *   local_shell_call sizes are placeholders.
 *
 * `programFrequency` and the four `waste` subsections never surface here
 * directly — `waste` feeds `opportunities` (core, `bash-opportunities.ts`),
 * which the Fix Queue renders instead; `programFrequency` has no consumer
 * in this lens (still MCP-only). The 4 v1 stat tiles are gone (the header
 * strip's headline $ figure replaces them); the 4 v1 waste subsections are
 * gone (the Fix Queue replaces them); heavy hitters survives as a demoted,
 * collapsed-by-default drill-down.
 *
 * This is the ONE place in the Bash lens that holds React state — every
 * table/card component below is a pure function component (no `useState`
 * inside one itself), because this repo's component tests call components
 * directly as functions and walk the returned element tree (no
 * jsdom/testing-library), which only works for hook-free components. Sort
 * state, the chars-column toggle, the Fix Queue's per-card evidence-expand
 * set, and the Evidence section's own collapse all live here as one
 * `useState` each, handed down as value + setter pairs — see
 * `tableSort.ts` for the underlying `SortSpec`/`sortRows` primitive every
 * sortable table here uses.
 */
export function Bash({ session, onOpenRecord }: Props) {
  const { bashStats } = session;

  const [commandRankingSort, setCommandRankingSort] = useState<SortSpec<CommandRankingSortKey>>(
    bashStats.totals.estUsd !== undefined
      ? DEFAULT_COMMAND_RANKING_SORT
      : DEFAULT_COMMAND_RANKING_SORT_UNPRICED,
  );
  const [showChars, setShowChars] = useState(false);
  const [heavyHitterSort, setHeavyHitterSort] =
    useState<SortSpec<HeavyHitterSortKey>>(DEFAULT_HEAVY_HITTER_SORT);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [expandedOpportunities, setExpandedOpportunities] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleExpandedOpportunity = (key: string) => {
    setExpandedOpportunities((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
        <HeaderStrip
          totals={bashStats.totals}
          bashPercentile={session.bashPercentile}
          source={session.source}
        />
      </div>

      <div className="hpad mt16">
        <WhoPaidPanel byThread={bashStats.byThread} />
      </div>

      <div className="hpad mt16">
        <div className="chartcap">
          <span className="lbl">Fix queue · {bashStats.opportunities.length}</span>
        </div>
        <FixQueue
          opportunities={bashStats.opportunities}
          expandedKeys={expandedOpportunities}
          onToggleExpand={toggleExpandedOpportunity}
          {...(onOpenRecord !== undefined && { onOpenRecord })}
        />
      </div>

      <div className="hpad mt16">
        <div className="chartcap">
          <span className="lbl">Cost by command</span>
          <button type="button" className="chip" onClick={() => setShowChars((v) => !v)}>
            {showChars ? "hide chars" : "show chars"}
          </button>
        </div>
        <CommandRankingTable
          byCommand={bashStats.byCommand}
          totals={bashStats.totals}
          sortSpec={commandRankingSort}
          onSortChange={setCommandRankingSort}
          showChars={showChars}
        />
      </div>

      <div className="hpad mt16">
        <button
          type="button"
          className="exp-toggle mono fs11 mut"
          onClick={() => setEvidenceOpen((v) => !v)}
          aria-expanded={evidenceOpen}
        >
          {evidenceOpen ? "▾" : "▸"} Evidence — heavy hitters ({bashStats.heavyHitters.length})
        </button>
        {evidenceOpen && (
          <HeavyHittersTable
            heavyHitters={bashStats.heavyHitters}
            sortSpec={heavyHitterSort}
            onSortChange={setHeavyHitterSort}
            {...(onOpenRecord !== undefined && { onOpenRecord })}
          />
        )}
      </div>

      <div className="hpad mt16" style={{ paddingBottom: "16px" }}>
        <div className="mono fs10 mut">
          ~ token/$ figures are chars/4 × model input price estimates; compound commands can
          mis-bucket families; Codex local_shell_call sizes are placeholders.
        </div>
      </div>
    </>
  );
}
