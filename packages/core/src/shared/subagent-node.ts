/**
 * `SubagentNode` — the subagent-forest node shape shared by both harnesses'
 * orchestration trees. Claude Code builds it from sidecar transcripts
 * (`claude/analyze.ts`'s `analyzeSubagents`); Codex builds the same shape
 * from a flat pool of sibling rollout files (`codex/orchestration.ts`'s
 * `buildCodexSubagentForest`). Promoted here (out of `claude/analyze.ts`) so
 * Codex never has to import a Claude-specific module just for this type.
 */
import type { UsageSummary } from "./metrics.js";

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
  children: SubagentNode[];
}
