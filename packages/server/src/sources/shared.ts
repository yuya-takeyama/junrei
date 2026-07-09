import type { SubagentNode } from "@junrei/core";

/** Per-model output-token totals (main session + all subagents, recursively). */
export interface ModelMixEntry {
  model: string;
  outputTokens: number;
}

/**
 * Fields genuinely shared by both harnesses' list items. `projectDirName` and
 * `subagentCount` are deliberately NOT here — Claude's `projectDirName` has
 * no Codex equivalent (see `sources/codex.ts`'s comment on how the web
 * session-list handles that), and while `subagentCount` is now real data for
 * both sources, keeping it on each concrete list-item interface (rather than
 * here) matches how each source module computes it independently.
 */
export interface SessionListItemBase {
  sessionId: string;
  cwd?: string;
  /** Repo-level grouping key derived from `cwd` — see `@junrei/core`'s `deriveRepoIdentity`. */
  repoRoot?: string;
  /** Set alongside `repoRoot` only when `cwd` was under a `.claude/worktrees/<name>` path. */
  worktreeName?: string;
  title?: string;
  firstUserPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  userTurnCount: number;
  models: string[];
  totalCostUsd: number;
  costIsComplete: boolean;
  totalTokens: number;
  cacheReadTokens: number;
  compactionCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  sizeBytes: number;
  /** Output-token share per model, main session + all subagents (for the L0 model-mix bar). */
  modelMix: ModelMixEntry[];
}

/**
 * Aggregate output tokens per model across a main transcript's own usage and
 * every node in a subagent/sub-agent forest (recursively) — shared by both
 * harnesses' "model mix" computation (Claude's tree of sidecar subagents,
 * Codex's tree of sub-agent rollouts), since a `SubagentNode` forest has the
 * same shape either way (see `@junrei/core`'s `codex/orchestration.ts`).
 */
export function mixFromUsageTree(
  ownByModel: readonly { model: string; outputTokens: number }[],
  forest: readonly SubagentNode[],
): ModelMixEntry[] {
  const totals = new Map<string, number>();
  const addUsage = (byModel: readonly { model: string; outputTokens: number }[]) => {
    for (const m of byModel) {
      totals.set(m.model, (totals.get(m.model) ?? 0) + m.outputTokens);
    }
  };
  addUsage(ownByModel);
  const visit = (nodes: readonly SubagentNode[]) => {
    for (const node of nodes) {
      addUsage(node.usage.byModel);
      visit(node.children);
    }
  };
  visit(forest);
  return [...totals].map(([model, outputTokens]) => ({ model, outputTokens }));
}
