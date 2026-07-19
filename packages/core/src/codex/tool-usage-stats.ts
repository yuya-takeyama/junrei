/**
 * Codex adapter for the harness-neutral cross-tool usage engine
 * (`../shared/tool-usage-stats.ts`) — maps EVERY Codex tool call (via
 * `./tool-calls.ts`'s generic listing, not just the shell subset
 * `./bash-stats.ts` filters to) into the neutral shape and feeds the same
 * ranking engine Claude's adapter uses.
 *
 * Limitations, mirroring what `codex/bash-stats.ts` already notes for the
 * shell subset:
 *
 *  - A `local_shell_call`-sourced entry's `resultChars` is only the
 *    synthesized `"exited with code N"` placeholder length (Codex records no
 *    real stdout/stderr for that wire surface), threaded through as
 *    `resultIsPlaceholder` so the $ weighting excludes it — same as
 *    `computeCodexBashEntries`.
 *  - Error classification: Codex's tool records carry no result *text* this
 *    layer can key regexes off (unlike Claude's tool_result), so an errored
 *    Codex call gets NO `errorCategory` — the engine tallies it under `"other"`
 *    in `ToolGroup.errorCategories`. `isError` itself is honest (reuses
 *    `resolveCodexToolOutcome`'s existing rule, surfaced as
 *    `CodexToolCallRecord.status === "error"`).
 *
 * `computeCodexToolUsageEntries`/`computeCodexToolUsageStats` operate on ONE
 * transcript (this session's own rollout) — main-thread-only, the same
 * "own-thread value, overridden at serve time" pattern `bashStats`/`fileAccess`
 * follow (see `shared/session-analysis.ts`). Codex sub-agent threads are
 * sibling rollout files; the server re-derives a JOINT main+forest value once
 * the forest is known (`getCodexSession`), reusing `computeCodexForestToolUsageStats`.
 */
import type { NeutralToolCall, ToolUsageStats } from "../shared/tool-usage-stats.js";
import { computeToolUsageStats } from "../shared/tool-usage-stats.js";
import type { CodexTranscript } from "./parser.js";
import { listCodexToolCalls } from "./tool-calls.js";

export type { NeutralToolCall, NeutralToolThread } from "../shared/tool-usage-stats.js";

/** Every tool call in one Codex transcript, mapped to the neutral shape — see this module's doc comment. */
export function computeCodexToolUsageEntries(transcript: CodexTranscript): NeutralToolCall[] {
  const calls: NeutralToolCall[] = [];
  for (const record of listCodexToolCalls(transcript)) {
    calls.push({
      id: record.callId,
      line: record.line,
      tool: record.toolName,
      resultChars: record.resultChars,
      ...(record.status === "error" && { isError: true }),
      ...(record.resultIsPlaceholder === true && { resultIsPlaceholder: true }),
    });
  }
  return calls;
}

/**
 * Cross-tool usage analytics for one Codex transcript, main thread only — see
 * this module's doc comment on why the forest-joint version lives on the
 * server. `model` (this session's own dominant model) tags the single `"main"`
 * thread for $ weighting; `undefined` leaves every `estUsd` field absent.
 */
export function computeCodexToolUsageStats(
  transcript: CodexTranscript,
  model?: string,
): ToolUsageStats {
  return computeToolUsageStats([
    {
      thread: "main",
      ...(model !== undefined && { model }),
      calls: computeCodexToolUsageEntries(transcript),
    },
  ]);
}

/**
 * Joint cross-tool usage analytics across several already-extracted per-thread
 * entry lists (this session's own `computeCodexToolUsageEntries` output plus
 * one per descendant sub-agent thread) — a thin re-export of the shared engine
 * under a Codex-specific name, same pattern as `computeCodexForestBashStats`
 * (see `codex/bash-stats.ts`). Used by `getCodexSession` (`@junrei/server`).
 */
export { computeToolUsageStats as computeCodexForestToolUsageStats } from "../shared/tool-usage-stats.js";
