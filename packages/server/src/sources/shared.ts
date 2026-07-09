import type { DelegationSummary, ModelUsageSummary, SubagentNode } from "@junrei/core";

/** Per-model output-token totals (main session + all subagents, recursively). */
export interface ModelMixEntry {
  model: string;
  outputTokens: number;
}

/**
 * Slim per-model rollup for a session-list row, sourced from
 * `analysis.totalUsageByModel` (main + all subagents, recursively — same
 * scope as `ModelMixEntry` above). Deliberately lean: no `messageCount` (list
 * rows have no use for it), matching the "keep list payloads small" norm
 * `ModelMixEntry` already set. Feeds the repo-overview aggregate's merged
 * `byModel` breakdown (`overview.ts`) without re-reading any transcripts.
 */
export interface UsageByModelEntry {
  model: string;
  /** undefined only when this model has no known pricing. */
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Project a full `ModelUsageSummary[]` (core) down to the list item's lean `UsageByModelEntry[]`. */
export function sliceUsageByModel(byModel: readonly ModelUsageSummary[]): UsageByModelEntry[] {
  return byModel.map((m) => ({
    model: m.model,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheCreationTokens: m.cacheCreationTokens,
    ...(m.costUsd !== undefined && { costUsd: m.costUsd }),
  }));
}

/** One scope's (main thread, or every subagent combined) slim tokens+cost slice — see `DelegationLite`. */
export interface DelegationScopeSliceLite {
  tokens: number;
  /** undefined only when this scope's usage includes a model with no known pricing. */
  costUsd?: number;
}

/**
 * Slim main-vs-subagents split for a session-list row — the two scope slices
 * from `analysis.delegation` (`@junrei/core`'s `DelegationSummary`), dropping
 * `byModel` (too heavy to ship on every list row) and each slice's
 * `outputTokens`/`messageCount` (the repo-overview aggregate this feeds only
 * needs total tokens + cost). Shape matches `format.ts`'s
 * `formatDelegatedShare` input exactly, so both a session-list row and the
 * repo-overview aggregate can feed it directly.
 */
export interface DelegationLite {
  main: DelegationScopeSliceLite;
  subagents: DelegationScopeSliceLite;
}

/** Project a full `DelegationSummary` (core) down to the list item's lean `DelegationLite`. */
export function sliceDelegation(delegation: DelegationSummary): DelegationLite {
  return {
    main: {
      tokens: delegation.main.tokens,
      ...(delegation.main.costUsd !== undefined && { costUsd: delegation.main.costUsd }),
    },
    subagents: {
      tokens: delegation.subagents.tokens,
      ...(delegation.subagents.costUsd !== undefined && { costUsd: delegation.subagents.costUsd }),
    },
  };
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
  /** Slim per-model cost/token rollup (main + all subagents) — see `UsageByModelEntry`. */
  usageByModel: UsageByModelEntry[];
  /** Slim main-vs-subagents cost/token split — see `DelegationLite`. */
  delegation: DelegationLite;
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
