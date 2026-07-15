/**
 * `SubagentNode` — the subagent-forest node shape shared by both harnesses'
 * orchestration trees. Claude Code builds it from sidecar transcripts
 * (`claude/analyze.ts`'s `analyzeSubagents`); Codex builds the same shape
 * from a flat pool of sibling rollout files (`codex/orchestration.ts`'s
 * `buildCodexSubagentForest`). Promoted here (out of `claude/analyze.ts`) so
 * Codex never has to import a Claude-specific module just for this type.
 */
import type { UsageSummary } from "./metrics.js";

/**
 * Completion status for a subagent's launch, from EVIDENCE only — never
 * guessed from timing:
 *  - "completed"/"failed": a sync launch's parent-side `tool_result` resolved
 *    (`result.isError` picks completed vs. failed), OR an async launch's
 *    harness task-notification resolved (same join `computeTaskExecutions`
 *    uses: launch toolUseId -> taskId -> last notification for that taskId).
 *  - "unresolved": no completion evidence in the log at all — the launching
 *    tool_use couldn't be matched, the sync result never arrived, or the
 *    async notification never arrived (the task outlived the session, or is
 *    still running).
 *
 * `endedAt` (the sidecar transcript's last record timestamp) is deliberately
 * NEVER used as a completion signal here: a still-running agent's sidecar
 * keeps getting appended to, so `endedAt` just tracks "most recent record
 * observed so far", not "the agent finished". Only the two evidence sources
 * above count.
 */
export type SubagentStatus = "completed" | "failed" | "unresolved";

export interface SubagentNode {
  agentId: string;
  agentType?: string;
  description?: string;
  /**
   * tool_use id of the Agent/Task call that spawned this agent — from the
   * sidecar's meta.json, or recovered from the parent-side
   * `toolUseResult.agentId` when meta.json lacks it (some Claude Code
   * versions write only agentType/description there).
   */
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
  promptPreview?: string;
  usage: UsageSummary;
  toolCallCount: number;
  toolErrorCount: number;
  startedAt?: string;
  endedAt?: string;
  /**
   * Length of the parent-side `tool_result` text for the launching
   * Agent/Task tool call — undefined while unresolved (no result yet, the
   * launching call couldn't be matched, or the launch was ASYNC — see
   * `asyncLaunch`). Mirrors `SubagentLaunchEntry.returnedChars` in
   * `shared/timeline.ts` (same underlying `ToolCall.result`), computed here
   * too so the Orchestration lens doesn't need a second round-trip through
   * the timeline builder just to show "↩ return" tokens in the tree.
   */
  returnedChars?: number;
  /**
   * The parent-side `tool_result` text itself (truncated to 2000 chars),
   * for the "return to parent" panel — same resolution rules as
   * `returnedChars` (undefined while unresolved or for async launches; the
   * async launch-ack boilerplate must never surface here as if it were the
   * agent's real return).
   */
  returnedPreview?: string;
  /**
   * True when the launch was asynchronous (`status: "async_launched"`). The
   * parent-side tool_result for an async launch is only the launch-ack
   * boilerplate — the agent's real return arrives later as a
   * task-notification whose text isn't in the log — so `returnedChars` stays
   * undefined rather than measuring the ack.
   */
  asyncLaunch?: boolean;
  /** Source line of the launching tool_use, in whichever transcript issued it (main or a parent subagent). */
  launchLine?: number;
  /** Timestamp of the launching tool_use — only set when distinct from `startedAt` (the agent's own first record). */
  launchedAt?: string;
  /** "main" when launched directly from the main transcript, otherwise the parent subagent's `agentId`. */
  spawnedBy?: string;
  /** See `SubagentStatus`'s doc comment for the evidence rules. Codex never sets this — no parent-side completion signal exists to read (see `codex/orchestration.ts`). */
  status?: SubagentStatus;
  /**
   * Set only for agents spawned by Claude Code's Workflow tool — the run id
   * (`<sessionDir>/subagents/workflows/<runId>/`), letting the web group
   * these nodes under a per-run header instead of treating them as ordinary
   * root-level launches. See `claude/workflows.ts` for how the run's own
   * state file is parsed, and `claude/analyze.ts`'s `analyzeSubagents` for
   * how this and the fields below are populated from it. Deliberately never
   * set for classic sidecar subagents.
   */
  workflowRunId?: string;
  /**
   * This agent's `label` from the workflow run's `workflowProgress` (e.g.
   * "research:agentcore") — the display name the web prefers over `agentId`
   * for workflow agents. Undefined when the run's state file is missing or
   * doesn't mention this agent.
   */
  workflowLabel?: string;
  /** This agent's phase title (e.g. "Research") from the same run-state lookup as `workflowLabel`. */
  workflowPhase?: string;
  /** ISO timestamp, converted from the run-state `queuedAt` epoch-ms field — when this agent was queued to run, which can precede `startedAt` (its own transcript's first record). */
  queuedAt?: string;
  children: SubagentNode[];
}
