/**
 * Claude Code adapter for the harness-neutral cross-tool usage engine
 * (`../shared/tool-usage-stats.ts`) — maps EVERY tool call (not just Bash)
 * across the MAIN transcript and every subagent transcript into the neutral
 * `NeutralToolCall`/`NeutralToolThread` shape and delegates the computation.
 * The Bash-only sibling (`./bash-stats.ts`) drills into one tool; this covers
 * all of them, so a session's Read/Edit/WebFetch/Agent/Bash context cost ranks
 * side by side.
 *
 * Reuses the SAME per-thread input contract (`ToolUsageStatsThread`,
 * structurally identical to `BashStatsThread`) and the SAME thread list
 * `analyze.ts` already assembles for `computeBashStats` — main tagged with its
 * dominant-by-input-tokens model, each subagent tagged with its own
 * `SubagentNode.model` — so the two engines price against identical models.
 *
 * Error classification reuses `classifyToolError` (`./metrics.ts`, the same
 * function `computeToolStats` uses over the same tool_result text), so a
 * tool's `errorCategories` here matches `toolStats[].errorCategories`.
 */

import type {
  NeutralToolCall,
  NeutralToolThread,
  ToolUsageStats,
} from "../shared/tool-usage-stats.js";
import { computeToolUsageStats as computeNeutralToolUsageStats } from "../shared/tool-usage-stats.js";
import { classifyToolError } from "./metrics.js";
import type { SessionData } from "./session-data.js";

export type {
  ToolGroup,
  ToolHeavyHitter,
  ToolUsageStats,
  ToolUsageTotals,
} from "../shared/tool-usage-stats.js";

/** One thread's session data, tagged with attribution and its own dominant model — structurally identical to `BashStatsThread` (see `./bash-stats.ts`), so `analyze.ts` reuses one thread list for both engines. */
export interface ToolUsageStatsThread {
  thread: string;
  data: SessionData;
  /** This thread's own dominant model (for $ weighting) — `undefined` when unknown. */
  model?: string;
}

function toNeutralCalls(data: SessionData): NeutralToolCall[] {
  const calls: NeutralToolCall[] = [];
  for (const call of data.toolCalls) {
    const isError = call.result?.isError === true;
    calls.push({
      id: call.toolUseId,
      line: call.line,
      tool: call.name,
      resultChars: call.result?.fullTextLength ?? 0,
      ...(isError && { isError: true }),
      // Classify from the SAME tool_result text `computeToolStats` reads, so a
      // tool's `errorCategories` matches `toolStats`. Only errored calls carry
      // a category; the engine tallies an errored call with none under "other".
      ...(isError &&
        call.result !== undefined && {
          errorCategory: classifyToolError(call.result.text),
        }),
    });
  }
  return calls;
}

/**
 * Compute cross-tool usage analytics over every thread's tool calls (main
 * transcript first, then each subagent) — see `../shared/tool-usage-stats.ts`'s
 * module doc comment for why this is one joint pass.
 */
export function computeToolUsageStats(threads: readonly ToolUsageStatsThread[]): ToolUsageStats {
  const neutralThreads: NeutralToolThread[] = threads.map(({ thread, data, model }) => ({
    thread,
    ...(model !== undefined && { model }),
    calls: toNeutralCalls(data),
  }));
  return computeNeutralToolUsageStats(neutralThreads);
}
