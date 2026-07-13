import type { AnySessionJson, ModelUsageSummary, SubagentNodeJson } from "../../api.js";

/** "main" (the root transcript) or a subagent's `agentId` — the tree's selection unit. */
export type SelectedId = string;

export const MAIN_ID = "main";

interface TokenTotalsLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Sum of every counted token field — the "Tokens" column basis throughout this lens. */
export function totalTokensOf(totals: TokenTotalsLike): number {
  return (
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  );
}

/** A node's own cost plus every descendant's, recursively — the "total" half of Cost self/total. */
export function subtreeCost(node: SubagentNodeJson): number {
  return node.usage.total.costUsd + node.children.reduce((sum, c) => sum + subtreeCost(c), 0);
}

/** A node's own token total plus every descendant's, recursively (tokens-metric flame width). */
export function subtreeTokens(node: SubagentNodeJson): number {
  return (
    totalTokensOf(node.usage.total) + node.children.reduce((sum, c) => sum + subtreeTokens(c), 0)
  );
}

/** The model with the highest cost in a byModel breakdown — used for "main"'s single badge. */
export function primaryModel(byModel: readonly ModelUsageSummary[]): string | undefined {
  let best: ModelUsageSummary | undefined;
  for (const m of byModel) {
    if (best === undefined || (m.costUsd ?? 0) > (best.costUsd ?? 0)) best = m;
  }
  return best?.model;
}

/**
 * `byModel` entries with real activity — nonzero token volume or cost, cost
 * descending. Filters out zero-usage placeholder entries such as Claude
 * Code's "<synthetic>" harness-stub model, which can carry a `messageCount`
 * without ever moving a token or a cent (see `computeUsage`'s zero-usage
 * short-circuit in `@junrei/core`'s metrics.ts) — `messageCount` alone is
 * NOT activity, or every node with a synthetic stub message would grow a
 * spurious extra badge. Closely mirrors the zero-usage filter already used
 * by ModelMixStrip/CostByModelChart/CostByModelTable (extended here to
 * `totalTokensOf` so cache-only activity counts too); centralized here so
 * the tree row and detail panel can render every model a node actually used
 * (not just the single highest-cost one — see `primaryModel` above) without
 * a subagent's SendMessage-induced model switch (sonnet → fable mid-run,
 * say) hiding behind one badge.
 */
export function activeModels(byModel: readonly ModelUsageSummary[]): ModelUsageSummary[] {
  return byModel
    .filter((m) => totalTokensOf(m) > 0 || (m.costUsd ?? 0) > 0)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}

/**
 * Share of `total` that `part` represents, as a 0..1 fraction — the basis
 * for the tree table's "%" column (share of the SESSION total, not of any
 * subtree — see `formatPctShare` in format.ts for the display side).
 * `undefined` when `total` isn't a real denominator (<= 0, i.e. no priced
 * session cost at all) rather than dividing by zero or reporting a
 * meaningless 0%.
 */
export function costShare(part: number, total: number): number | undefined {
  return total > 0 ? part / total : undefined;
}

/**
 * Liveness threshold for `isSessionLive` — 5 minutes. Liveness is inferred
 * from file mtime (the log has no explicit "still running" marker), and a
 * tool call that runs quietly for a long time (a slow build, a long-polling
 * MCP call) can stall the mtime well past the point the agent is actually
 * still working. This errs GENEROUS on purpose: a wider window occasionally
 * shows "run" a little past the real finish, which is a far less confusing
 * mistake than flagging a still-running agent as "done".
 */
export const SESSION_LIVE_THRESHOLD_MS = 5 * 60_000;

/**
 * Whether a session still looks "live" — its last on-disk activity
 * (`lastActivityAt`, the max mtime across the main transcript and every
 * subagent sidecar; see the server's `getClaudeLastActivityAt`/
 * `getCodexLastActivityAt`) is within `SESSION_LIVE_THRESHOLD_MS` of `now`.
 * `false` for an undefined or unparseable timestamp — no evidence of
 * recent activity is treated the same as no activity, never "probably live".
 */
export function isSessionLive(lastActivityAt: string | undefined, nowMs: number): boolean {
  if (lastActivityAt === undefined) return false;
  const activityMs = Date.parse(lastActivityAt);
  if (!Number.isFinite(activityMs)) return false;
  return nowMs - activityMs < SESSION_LIVE_THRESHOLD_MS;
}

/**
 * Tree/detail-panel "run"/"done"/"fail" status label for one subagent node,
 * derived from its own `SubagentNode.status` (see that field's doc comment
 * in `@junrei/core` for the completion-evidence rules) plus whether the
 * SESSION itself still looks live:
 *  - "completed" -> "done", "failed" -> "fail" — real evidence either way,
 *    session liveness doesn't change the reading.
 *  - "unresolved" (no completion evidence yet) -> "run" ONLY while the
 *    session still looks live; in a long-finished session an unresolved
 *    status just means the log never captured a completion, not that the
 *    agent is still running — rendering "run" there would be actively
 *    misleading, so it falls through to `undefined` instead.
 *  - `status` undefined (Codex — no completion-evidence source exists at
 *    all, see `codex/orchestration.ts`) -> `undefined`. Guessing from timing
 *    here would be worse than the tree just showing "—".
 */
export function nodeStatus(
  node: Pick<SubagentNodeJson, "status">,
  sessionLive: boolean,
): "run" | "done" | "fail" | undefined {
  if (node.status === "completed") return "done";
  if (node.status === "failed") return "fail";
  if (node.status === "unresolved") return sessionLive ? "run" : undefined;
  return undefined;
}

export interface FlatTreeRow {
  id: string;
  depth: number;
  /** Box-drawing prefix (├/│/└ + spacing), empty for the synthetic "main" row. */
  prefix: string;
  /** Whether each ancestor is the final sibling in its own list, root-first. */
  ancestorIsLast: readonly boolean[];
  /** Whether this node is the final sibling in its own list. */
  isLast: boolean;
  node: SubagentNodeJson;
  /** True when this node has at least one ancestor — used to prefix waterfall labels too. */
  nested: boolean;
}

function buildPrefix(ancestorIsLast: readonly boolean[], isLast: boolean): string {
  return `${ancestorIsLast.map((last) => (last ? "  " : "│ ")).join("")}${isLast ? "└ " : "├ "}`;
}

/** Depth-first flatten of the subagent forest (main excluded), box-drawing prefix per row. */
export function flattenSubagents(nodes: readonly SubagentNodeJson[]): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const visit = (
    list: readonly SubagentNodeJson[],
    depth: number,
    ancestorIsLast: readonly boolean[],
  ) => {
    list.forEach((node, i) => {
      const isLast = i === list.length - 1;
      rows.push({
        id: node.agentId,
        depth,
        prefix: buildPrefix(ancestorIsLast, isLast),
        ancestorIsLast,
        isLast,
        node,
        nested: depth > 1,
      });
      visit(node.children, depth + 1, [...ancestorIsLast, isLast]);
    });
  };
  visit(nodes, 1, []);
  return rows;
}

/** Every subagent, depth-first, flattened with no ordering guarantee beyond that. */
export function allSubagents(nodes: readonly SubagentNodeJson[]): SubagentNodeJson[] {
  const out: SubagentNodeJson[] = [];
  const visit = (list: readonly SubagentNodeJson[]) => {
    for (const n of list) {
      out.push(n);
      visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

/** Find a node by agentId anywhere in the forest (any depth). */
export function findSubagent(
  nodes: readonly SubagentNodeJson[],
  agentId: string,
): SubagentNodeJson | undefined {
  for (const n of nodes) {
    if (n.agentId === agentId) return n;
    const found = findSubagent(n.children, agentId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Ancestor chain (root-first, inclusive of the target) for a given agentId
 * anywhere in the forest — used by the agent detail shell (L3) to render its
 * breadcrumb (`session ▸ ancestor ▸ … ▸ agent`) and depth ticks. `undefined`
 * when the agentId isn't in the tree at all.
 */
export function findAgentPath(
  nodes: readonly SubagentNodeJson[],
  agentId: string,
): SubagentNodeJson[] | undefined {
  for (const node of nodes) {
    if (node.agentId === agentId) return [node];
    const childPath = findAgentPath(node.children, agentId);
    if (childPath !== undefined) return [node, ...childPath];
  }
  return undefined;
}

/** Duration in ms between a node's startedAt/endedAt, when both are present. */
export function nodeDurationMs(
  node: Pick<SubagentNodeJson, "startedAt" | "endedAt">,
): number | undefined {
  if (node.startedAt === undefined || node.endedAt === undefined) return undefined;
  const start = Date.parse(node.startedAt);
  const end = Date.parse(node.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

/**
 * Human label for who spawned a node: "main", or the parent subagent's own
 * display name (falls back to the raw id if the parent can't be found —
 * shouldn't happen in practice, but the tree must never throw on odd data).
 */
export function spawnedByLabel(
  node: SubagentNodeJson,
  allNodes: readonly SubagentNodeJson[],
): string {
  const spawnedBy = node.spawnedBy ?? MAIN_ID;
  if (spawnedBy === MAIN_ID) return MAIN_ID;
  const parent = findSubagent(allNodes, spawnedBy);
  return parent === undefined ? spawnedBy : displayName(parent);
}

/** Display name for a tree row: description, then agent type, then the raw id. */
export function displayName(node: SubagentNodeJson): string {
  return node.description ?? node.agentType ?? node.agentId;
}

/** Session wall-clock span (ms) for positioning waterfall bars — undefined if unusable. */
export function sessionSpan(session: AnySessionJson): { start: number; end: number } | undefined {
  if (session.startedAt === undefined || session.endedAt === undefined) return undefined;
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return { start, end };
}

/** Cost split by main vs. delegated (every subagent, recursively), rounded to whole percent. */
export function mainDelegatedSplit(session: AnySessionJson): {
  mainPct: number;
  delegatedPct: number;
} {
  const total = session.totalUsage.costUsd;
  if (total <= 0) return { mainPct: 0, delegatedPct: 0 };
  const mainPct = Math.round((session.usage.total.costUsd / total) * 100);
  return { mainPct, delegatedPct: 100 - mainPct };
}

/**
 * Token split by main vs. delegated, same shape as `mainDelegatedSplit` but
 * over token volume (via `session.delegation`) rather than cost — the two
 * are compared side by side in the Orchestration header because they often
 * rank in opposite directions (main can spend most of the DOLLARS while
 * subagents move most of the TOKENS, or vice versa).
 */
export function mainDelegatedTokenSplit(session: AnySessionJson): {
  mainPct: number;
  delegatedPct: number;
} {
  const { main, subagents } = session.delegation;
  const total = main.tokens + subagents.tokens;
  if (total <= 0) return { mainPct: 0, delegatedPct: 0 };
  const mainPct = Math.round((main.tokens / total) * 100);
  return { mainPct, delegatedPct: 100 - mainPct };
}
