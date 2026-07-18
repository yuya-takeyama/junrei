/**
 * Codex adapter for the harness-neutral Bash-analysis engine
 * (`../shared/bash-stats.ts`) — extracts every genuine shell execution from a
 * Codex transcript (via `./tool-calls.ts`'s generic listing, filtered to
 * calls that resolved a `shellCommand`) and feeds it through the same
 * ranking/waste-detection logic Claude's adapter (`claude/bash-stats.ts`)
 * uses. See `tool-calls.ts`'s module doc comment for exactly what Codex
 * records for a shell call (which wire surfaces, with file:line evidence)
 * and what it structurally can't recover.
 *
 * Scope, deliberately NOT covered here:
 *
 *  - `background` is always `[]` — Codex has no `run_in_background` concept
 *    (or any equivalent) in the current data model; see
 *    `../shared/bash-stats.ts`'s module doc comment on why `background` is
 *    resolved per-harness rather than by the shared engine.
 *  - Exit-code -> `isError` mapping reuses `resolveCodexToolOutcome`'s
 *    existing rule (nonzero `exec_command_end.exit_code`, a structured
 *    `{success:false}` output, or output text matching
 *    `"exited with code <nonzero>"`) — never re-derived here.
 *  - `exec_command_end.duration` is NEVER mapped to `wallClockMs` — see
 *    `tool-calls.ts`'s module doc comment for why (unknown wire shape, no
 *    fixture evidence of its units).
 *
 * `computeCodexBashEntries`/`computeCodexBashStats` operate on ONE
 * transcript (this session's own rollout) — main-thread-only, the same
 * "own-thread value, overridden at serve time" pattern `fileAccess` already
 * follows (see `shared/session-analysis.ts`'s doc comment on `bashStats`).
 * Codex sub-agent threads ARE reachable — each is a full sibling rollout
 * file discoverable through the same analysis pool `getCodexSession`
 * (`@junrei/server`) already scans for the sub-agent forest — so the server
 * re-derives a JOINT main+forest `BashStats` there once the forest is known,
 * mirroring `mergeCodexFileAccess`/`collectForestFileAccess` but using this
 * module's `computeCodexBashEntries` per descendant transcript (a joint pass
 * is required, not an additive fold — see the shared engine's own doc
 * comment on why ranking fields can't be merged after the fact).
 */
import type { BashStats, NeutralBashCall } from "../shared/bash-stats.js";
import { computeBashStats } from "../shared/bash-stats.js";
import type { CodexTranscript } from "./parser.js";
import { listCodexToolCalls } from "./tool-calls.js";

export type { NeutralBashCall, NeutralBashThread } from "../shared/bash-stats.js";

/** Every genuine shell execution in one Codex transcript, mapped to the neutral shape — see this module's doc comment. */
export function computeCodexBashEntries(transcript: CodexTranscript): NeutralBashCall[] {
  const calls: NeutralBashCall[] = [];
  for (const record of listCodexToolCalls(transcript)) {
    if (record.shellCommand === undefined) continue;
    calls.push({
      id: record.callId,
      line: record.line,
      command: record.shellCommand,
      resultChars: record.resultChars,
      isError: record.status === "error",
    });
  }
  return calls;
}

/** Bash-command analytics for one Codex transcript, main thread only — see this module's doc comment on why the forest-joint version lives on the server. */
export function computeCodexBashStats(transcript: CodexTranscript): BashStats {
  return computeBashStats([{ thread: "main", calls: computeCodexBashEntries(transcript) }]);
}

/**
 * Joint Bash-command analytics across several ALREADY-EXTRACTED per-thread
 * entry lists (this session's own `computeCodexBashEntries` output, plus one
 * per descendant sub-agent thread's own transcript) — a thin re-export of the
 * shared neutral engine under a Codex-specific name (`@junrei/core`'s public
 * barrel never exports the shared engine's own `computeBashStats` directly,
 * to avoid colliding with Claude's differently-shaped adapter of the same
 * name — see `shared/index.ts`'s doc comment). Used by `getCodexSession`
 * (`@junrei/server`) once a session's sub-agent forest is known — see this
 * module's own doc comment for why that recompute can't be an additive fold.
 */
export { computeBashStats as computeCodexForestBashStats } from "../shared/bash-stats.js";
