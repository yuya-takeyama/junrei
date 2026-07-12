import type { SessionSource } from "@junrei/core";
import { type AnySessionListItem, listSessions, MAX_LIST_LIMIT } from "./sessions.js";

// Fallback-bucket key prefixes for sessions with no `repoRoot` — duplicated
// (not imported) from `packages/web/src/sessionListHelpers.ts`'s
// `repoFilterKey`, since the web package isn't a server dependency and the
// two list-item shapes coincide by construction (both extend
// `SessionListItemBase`). Keep these two functions in lockstep: any drift
// would silently break `?repo=` links the web builds from `repoFilterKey`
// but this route can no longer resolve.
const CLAUDE_FALLBACK_PREFIX = "claude-project:";
const CODEX_FALLBACK_PREFIX = "codex-cwd:";
const UNKNOWN_CWD = "(unknown cwd)";

/**
 * The `?repo=` value `computeRepoOverview` (and the `GET /api/overview`
 * route) accepts is EITHER:
 *  - a real `repoRoot` absolute path (e.g. `/Users/x/junrei`), shared by a
 *    repo-root session and every one of its `.claude/worktrees/<name>`
 *    sessions (see `@junrei/core`'s `deriveRepoIdentity`); or
 *  - one of the fallback-bucket keys assigned to a session with no
 *    `repoRoot` at all (pre-#36 data, or a `cwd` the worktree heuristic
 *    never matched): `claude-project:<projectDirName>` for a Claude row, or
 *    `codex-cwd:<cwd>` (`codex-cwd:(unknown cwd)` when even `cwd` is
 *    missing) for a Codex row.
 * This mirrors the web's `repoFilterKey` exactly — same key, either source.
 * Exported for `search.ts`'s `repo` filter, so search and overview resolve
 * the same `repo` argument identically.
 */
export function repoKeyOf(item: AnySessionListItem): string {
  if (item.repoRoot !== undefined) return item.repoRoot;
  return item.source === "codex"
    ? `${CODEX_FALLBACK_PREFIX}${item.cwd ?? UNKNOWN_CWD}`
    : `${CLAUDE_FALLBACK_PREFIX}${item.projectDirName}`;
}

/** One UTC calendar day's cost/session-count bucket — see `RepoOverview.perDay`. */
export interface RepoOverviewDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  costUsd: number;
  sessionCount: number;
}

/** One model's merged rollup across every session in the repo — see `RepoOverview.byModel`. */
export interface RepoOverviewModelUsage {
  model: string;
  /** undefined only when this model has no known pricing. */
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** One scope's (main thread, or every subagent combined) summed tokens+cost across the whole repo — see `RepoOverview.delegation`. */
export interface RepoOverviewDelegationSlice {
  tokens: number;
  /** undefined only when this scope's usage includes a model with no known pricing. */
  costUsd?: number;
}

/** One of the top-5-by-cost sessions in `RepoOverview.topSessions`. */
export interface RepoOverviewTopSession {
  sessionId: string;
  source: SessionSource;
  /** Claude-only — Codex sessions have no project-dir concept (see `sources/codex.ts`). */
  projectDirName?: string;
  title?: string;
  /** Truncated to ~80 chars — a preview, not the full prompt. */
  firstUserPrompt?: string;
  startedAt?: string;
  costUsd: number;
  worktreeName?: string;
}

/**
 * Repo-level rollup across every session-list item matching one repo key —
 * see `computeRepoOverview`. Structured as a reusable pure function (over
 * already-computed list items, no transcript re-reads) so a follow-up PR can
 * reuse it verbatim for an MCP tool, and so it's directly unit-testable here.
 */
export interface RepoOverview {
  /** Echoes the `repoKey` argument verbatim. */
  repo: string;
  sessionCount: number;
  sourceCounts: Record<SessionSource, number>;
  totalCostUsd: number;
  /** AND of every matched session's own `costIsComplete` — false if ANY session has unpriced usage. */
  costIsComplete: boolean;
  totalTokens: number;
  /** Sum of every matched session's `usageByModel[].outputTokens` — always populated (cheaply available from list items, no re-analysis needed). */
  totalOutputTokens?: number;
  /** Bucketed by `startedAt`'s UTC calendar day. Sessions with no `startedAt` are counted in every total above but have no day to bucket under, so they're omitted here (not silently dropped from the aggregate as a whole). */
  perDay: RepoOverviewDay[];
  /** Merged across every matched session, cost-descending. */
  byModel: RepoOverviewModelUsage[];
  /** Summed across every matched session — see `@junrei/core`'s `DelegationSummary`. */
  delegation: { main: RepoOverviewDelegationSlice; subagents: RepoOverviewDelegationSlice };
  /** Top 5 matched sessions by cost, descending. */
  topSessions: RepoOverviewTopSession[];
}

const TOP_SESSIONS_LIMIT = 5;
const FIRST_PROMPT_TRUNCATE = 80;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** UTC calendar day (`YYYY-MM-DD`) for an ISO timestamp, or undefined for an unparseable one. */
function utcDateKey(iso: string): string | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

/** Add `delta` to an optional running total, propagating undefined once any input is undefined (unpriced) — mirrors how `costIsComplete` propagates through a sum. */
function sumOptional(running: number | undefined, delta: number | undefined): number | undefined {
  return running === undefined || delta === undefined ? undefined : running + delta;
}

/**
 * Aggregate every session-list item whose repo key (see the module doc
 * comment on `repoKeyOf` for the accepted forms) equals `repoKey` into one
 * repo-level rollup: totals, a per-day cost timeline, a merged per-model
 * breakdown, the main/subagent delegation split, and the top 5 sessions by
 * cost. A pure function over already-computed list items — no transcript
 * re-reads — so it's cheap per-request and independently testable; MCP
 * parity (a tool wrapping this same function) lands in a follow-up PR.
 */
export function computeRepoOverview(
  items: readonly AnySessionListItem[],
  repoKey: string,
): RepoOverview {
  const matched = items.filter((item) => repoKeyOf(item) === repoKey);

  const sourceCounts: Record<SessionSource, number> = { "claude-code": 0, codex: 0 };
  let totalCostUsd = 0;
  let costIsComplete = true;
  let totalTokens = 0;
  const perDay = new Map<string, { costUsd: number; sessionCount: number }>();
  const byModel = new Map<string, RepoOverviewModelUsage>();
  let mainTokens = 0;
  let subagentTokens = 0;
  let mainCost: number | undefined = 0;
  let subagentCost: number | undefined = 0;

  for (const item of matched) {
    sourceCounts[item.source] += 1;
    totalCostUsd += item.totalCostUsd;
    if (!item.costIsComplete) costIsComplete = false;
    totalTokens += item.totalTokens;

    if (item.startedAt !== undefined) {
      const day = utcDateKey(item.startedAt);
      if (day !== undefined) {
        const bucket = perDay.get(day) ?? { costUsd: 0, sessionCount: 0 };
        bucket.costUsd += item.totalCostUsd;
        bucket.sessionCount += 1;
        perDay.set(day, bucket);
      }
    }

    for (const model of item.usageByModel) {
      const entry = byModel.get(model.model) ?? {
        model: model.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      entry.inputTokens += model.inputTokens;
      entry.outputTokens += model.outputTokens;
      entry.cacheReadTokens += model.cacheReadTokens;
      entry.cacheCreationTokens += model.cacheCreationTokens;
      if (model.costUsd !== undefined) entry.costUsd = (entry.costUsd ?? 0) + model.costUsd;
      byModel.set(model.model, entry);
    }

    mainTokens += item.delegation.main.tokens;
    subagentTokens += item.delegation.subagents.tokens;
    mainCost = sumOptional(mainCost, item.delegation.main.costUsd);
    subagentCost = sumOptional(subagentCost, item.delegation.subagents.costUsd);
  }

  const totalOutputTokens = [...byModel.values()].reduce((sum, m) => sum + m.outputTokens, 0);

  const perDayArray: RepoOverviewDay[] = [...perDay.entries()]
    .map(([date, bucket]) => ({ date, costUsd: bucket.costUsd, sessionCount: bucket.sessionCount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byModelArray = [...byModel.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  const topSessions: RepoOverviewTopSession[] = [...matched]
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, TOP_SESSIONS_LIMIT)
    .map((item) => ({
      sessionId: item.sessionId,
      source: item.source,
      costUsd: item.totalCostUsd,
      ...(item.source === "claude-code" && { projectDirName: item.projectDirName }),
      ...(item.title !== undefined && { title: item.title }),
      ...(item.firstUserPrompt !== undefined && {
        firstUserPrompt: truncate(item.firstUserPrompt, FIRST_PROMPT_TRUNCATE),
      }),
      ...(item.startedAt !== undefined && { startedAt: item.startedAt }),
      ...(item.worktreeName !== undefined && { worktreeName: item.worktreeName }),
    }));

  return {
    repo: repoKey,
    sessionCount: matched.length,
    sourceCounts,
    totalCostUsd,
    costIsComplete,
    totalTokens,
    totalOutputTokens,
    perDay: perDayArray,
    byModel: byModelArray,
    delegation: {
      main: { tokens: mainTokens, ...(mainCost !== undefined && { costUsd: mainCost }) },
      subagents: {
        tokens: subagentTokens,
        ...(subagentCost !== undefined && { costUsd: subagentCost }),
      },
    },
    topSessions,
  };
}

/**
 * The one listing+aggregation path every repo-overview surface calls through
 * — `GET /api/overview` (app.ts) and the `get_repo_overview` MCP tool
 * (mcp.ts) both just forward `repoKey` here, so there's no risk of the two
 * surfaces silently drifting (e.g. one forgetting the `MAX_LIST_LIMIT`
 * ceiling or filtering by source). See `computeRepoOverview`'s doc comment
 * for the accepted `repoKey` forms.
 */
export async function getRepoOverview(repoKey: string): Promise<RepoOverview> {
  const items = await listSessions(MAX_LIST_LIMIT, "all");
  return computeRepoOverview(items, repoKey);
}
