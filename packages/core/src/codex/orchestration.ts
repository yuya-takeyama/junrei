/**
 * Builds a Claude-compatible `SubagentNode` forest out of a Codex parent
 * session's own sub-agent threads.
 *
 * Unlike Claude Code (where a subagent is a sidecar transcript nested under
 * the main session's directory), a Codex sub-agent is a first-class rollout
 * file of its own — its own `session_meta`, its own usage. `buildCodexSubagentForest`
 * assembles those into the same tree shape the Orchestration lens (web)
 * already renders for Claude, so the lens can be reused almost unchanged.
 */
import type { SubagentNode } from "../shared/subagent-node.js";
import type { CodexSessionAnalysis } from "./analyze.js";

const byStart = (a: SubagentNode, b: SubagentNode) =>
  (a.startedAt ?? "").localeCompare(b.startedAt ?? "");

/**
 * Build the sub-agent forest rooted at `rootId` (the parent session's own
 * `sessionId`) out of a flat pool of Codex analyses.
 *
 * `analyses` must include the root session's OWN analysis (so its
 * `codex.spawnedThreadIds` can be matched against direct children for
 * `toolUseId`/`launchLine`/`launchedAt`) plus every descendant the caller
 * wants represented — typically every analysis whose `codex.parentThreadId`
 * chains back to `rootId`, at any depth. Analyses that aren't reachable from
 * `rootId` via `parentThreadId` are ignored (not just unmatched — genuinely
 * not part of this tree).
 */
export function buildCodexSubagentForest(
  analyses: readonly CodexSessionAnalysis[],
  rootId: string,
): SubagentNode[] {
  const bySessionId = new Map(analyses.map((a) => [a.sessionId, a] as const));
  const childrenOf = new Map<string, CodexSessionAnalysis[]>();
  for (const analysis of analyses) {
    const parentId = analysis.codex.parentThreadId;
    if (parentId === undefined) continue;
    const list = childrenOf.get(parentId);
    if (list === undefined) childrenOf.set(parentId, [analysis]);
    else list.push(analysis);
  }

  // Guards against a malformed/cyclic parentThreadId chain (shouldn't happen
  // on real data, but the tree-builder must never infinite-loop on it).
  const visited = new Set<string>();

  const buildNode = (
    analysis: CodexSessionAnalysis,
    parentId: string,
    depth: number,
  ): SubagentNode | undefined => {
    if (visited.has(analysis.sessionId)) return undefined;
    visited.add(analysis.sessionId);

    // The parent's own analysis is only needed to look up the
    // collab_agent_spawn_end record for toolUseId/launchLine/launchedAt —
    // `spawnedBy` itself is resolvable from `parentId` alone (always known,
    // it's how `analysis` ended up in `childrenOf` in the first place), so a
    // parent whose own analysis wasn't included in the pool still gets a
    // structurally correct tree, just without that extra launch metadata.
    const parent = bySessionId.get(parentId);
    const spawnRecord = parent?.codex.spawnedThreadIds.find(
      (s) => s.threadId === analysis.sessionId,
    );
    const model = analysis.models[0];
    // No Codex equivalent of Claude's Task-tool `description` argument — the
    // agent's own nickname (when the parent gave it one) is the closest
    // human-readable label; falling back to its own title (from
    // thread_name_updated, if any) keeps the tree row from just showing a
    // raw session id.
    const description = analysis.codex.agentNickname ?? analysis.title;
    const spawnedBy = parentId === rootId ? "main" : parentId;

    const children = (childrenOf.get(analysis.sessionId) ?? [])
      .map((child) => buildNode(child, analysis.sessionId, depth + 1))
      .filter((n): n is SubagentNode => n !== undefined)
      .sort(byStart);

    return {
      agentId: analysis.sessionId,
      agentType: analysis.codex.agentRole ?? "codex-subagent",
      usage: analysis.usage,
      toolCallCount: analysis.toolCallCount,
      toolErrorCount: analysis.toolErrorCount,
      children,
      ...(description !== undefined && { description }),
      ...(spawnRecord?.callId !== undefined && { toolUseId: spawnRecord.callId }),
      // Prefer the depth this thread's own session_meta reported; fall back
      // to the recursion depth from rootId when the wire payload omitted it.
      spawnDepth: analysis.codex.subagentDepth ?? depth,
      ...(model !== undefined && { model }),
      ...(analysis.firstUserPrompt !== undefined && { promptPreview: analysis.firstUserPrompt }),
      ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
      ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
      ...(spawnRecord?.line !== undefined && { launchLine: spawnRecord.line }),
      ...(spawnRecord?.timestamp !== undefined &&
        spawnRecord.timestamp !== analysis.startedAt && { launchedAt: spawnRecord.timestamp }),
      spawnedBy,
      // No Codex equivalent of a parent-side tool_result (or a background
      // task-notification) to measure — these stay honestly undefined rather
      // than fabricated: returnedChars/returnedPreview/asyncLaunch/status
      // (see `SubagentStatus`'s doc comment — Codex has no completion
      // evidence source to read, so the Orchestration lens's Status column
      // renders "—" for every Codex node rather than guessing from timing).
    };
  };

  const roots = (childrenOf.get(rootId) ?? [])
    .map((child) => buildNode(child, rootId, 1))
    .filter((n): n is SubagentNode => n !== undefined)
    .sort(byStart);
  return roots;
}
