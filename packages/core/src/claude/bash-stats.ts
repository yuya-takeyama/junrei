/**
 * Claude Code adapter for the harness-neutral Bash-analysis engine
 * (`../shared/bash-stats.ts`) — maps every `Bash` tool call across the MAIN
 * transcript and every subagent transcript into the neutral
 * `NeutralBashCall`/`NeutralBashThread` shape and delegates the actual
 * computation. This file WAS the whole engine (PR 1 of 4, "Bash analysis")
 * before the Codex adapter (PR 4) needed the same ranking/waste-detection
 * logic over its own shell-call source — the extraction changed nothing
 * about Claude's own output: same `BashStats` shape, same numbers, same
 * `BashStatsThread` input contract callers already use.
 *
 * Background-task resolution (`run_in_background` Bash launches joined to
 * their completion notification via `taskId`) is Claude-specific and stays
 * here rather than in the shared engine — see `toBackgroundCalls` below and
 * the shared module's own doc comment on why `background` isn't computed
 * there.
 */

import type {
  BashBackgroundCall,
  BashStats,
  NeutralBashCall,
  NeutralBashThread,
} from "../shared/bash-stats.js";
import { computeBashStats as computeNeutralBashStats } from "../shared/bash-stats.js";
import { backgroundStatus, spanMs } from "./metrics.js";
import type { SessionData, ToolCall } from "./session-data.js";

export type {
  BashAsReadCall,
  BashBackgroundCall,
  BashCommandGroup,
  BashHeavyHitter,
  BashLargeResult,
  BashNearDuplicateGroup,
  BashProgramFrequency,
  BashRerunAfterError,
  BashStats,
  BashTotals,
  BashWaste,
} from "../shared/bash-stats.js";
export { LARGE_RESULT_CHARS_THRESHOLD, normalizeCommandForDedup } from "../shared/bash-stats.js";

/** One thread's session data, tagged with how it should be attributed — `"main"` for the top-level transcript, else a subagent's `agentId`. */
export interface BashStatsThread {
  thread: string;
  data: SessionData;
}

/** Same 200-char cap (with an ellipsis marker) the shared engine's own `cap` applies to every other command string — duplicated here (not exported by the shared module) since `background` is resolved entirely in this Claude-specific adapter. */
const BACKGROUND_COMMAND_CAP = 200;
function cap(text: string, limit = BACKGROUND_COMMAND_CAP): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function commandOf(call: ToolCall): string {
  const input = call.input;
  if (typeof input !== "object" || input === null) return "";
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function toNeutralCalls(data: SessionData): NeutralBashCall[] {
  const calls: NeutralBashCall[] = [];
  for (const call of data.toolCalls) {
    if (call.name !== "Bash") continue;
    calls.push({
      id: call.toolUseId,
      line: call.line,
      command: commandOf(call),
      resultChars: call.result?.fullTextLength ?? 0,
      isError: call.result?.isError === true,
    });
  }
  return calls;
}

/**
 * One thread's `run_in_background` Bash launches, joined to their completion
 * notification (last one wins per `taskId`, same rule `computeTaskExecutions`
 * applies) — the Claude-specific half of `background` (see this module's own
 * doc comment for why the shared engine doesn't compute it).
 */
function toBackgroundCalls(thread: string, data: SessionData): BashBackgroundCall[] {
  const callsById = new Map(data.toolCalls.map((c) => [c.toolUseId, c]));
  const background: BashBackgroundCall[] = [];
  for (const launch of data.backgroundLaunches) {
    if (launch.kind !== "bash") continue;
    const launchCall = launch.toolUseId !== undefined ? callsById.get(launch.toolUseId) : undefined;
    const command = launchCall !== undefined ? commandOf(launchCall) : "";
    // Last notification for this taskId wins — same rule `computeTaskExecutions` applies.
    let notification: (typeof data.taskNotifications)[number] | undefined;
    for (const candidate of data.taskNotifications) {
      if (candidate.taskId === launch.taskId) notification = candidate;
    }
    const wallClockMs = spanMs(launchCall?.timestamp ?? launch.timestamp, notification?.timestamp);
    // `backgroundStatus` is shared with `computeTaskExecutions`, whose status
    // union also covers preview-server "stopped" — unreachable for a Bash
    // launch (never fed a preview-stop event), so fold it into "unresolved"
    // defensively.
    const rawStatus = backgroundStatus(notification);
    const status = rawStatus === "stopped" ? "unresolved" : rawStatus;
    background.push({
      taskId: launch.taskId,
      command: cap(command !== "" ? command : launch.name),
      thread,
      launchLine: launch.line,
      ...(notification?.line !== undefined && { completionLine: notification.line }),
      ...(wallClockMs !== undefined && { wallClockMs }),
      status,
    });
  }
  return background;
}

/**
 * Compute Bash-command analytics over every thread's `Bash` tool calls (main
 * transcript first, then each subagent) — see `../shared/bash-stats.ts`'s
 * module doc comment for why this is one joint pass rather than a per-thread
 * fold+merge.
 */
export function computeBashStats(threads: readonly BashStatsThread[]): BashStats {
  const neutralThreads: NeutralBashThread[] = threads.map(({ thread, data }) => ({
    thread,
    calls: toNeutralCalls(data),
    background: toBackgroundCalls(thread, data),
  }));
  return computeNeutralBashStats(neutralThreads);
}
