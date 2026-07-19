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
const CODEX_REPO_URL_PREFIX = "codex-repo:";
const CODEX_FALLBACK_PREFIX = "codex-cwd:";
const UNKNOWN_CWD = "(unknown cwd)";

/**
 * The `?repo=` value `computeRepoOverview` (and the `GET /api/overview`
 * route) accepts is EITHER:
 *  - a real `repoRoot` absolute path (e.g. `/Users/x/junrei`), shared by a
 *    repo-root session and every one of its `.claude/worktrees/<name>`
 *    sessions (see `@junrei/core`'s `deriveRepoIdentity`) — and, for Codex,
 *    by its `$CODEX_HOME/worktrees` sessions whose repository URL anchors to
 *    that path (see `sources/codex.ts`'s `buildRepoRootByUrl`); or
 *  - one of the fallback-bucket keys assigned to a session with no
 *    `repoRoot`: `claude-project:<projectDirName>` for a Claude row
 *    (pre-#36 data, or a `cwd` the worktree heuristic never matched);
 *    `codex-repo:<repoUrl>` for a Codex row whose repository URL no local
 *    checkout anchors; or `codex-cwd:<cwd>` (`codex-cwd:(unknown cwd)` when
 *    even `cwd` is missing) for a Codex row without even a URL.
 * This mirrors the web's `repoFilterKey` exactly — same key, either source.
 * Exported for `search.ts`'s `repo` filter, so search and overview resolve
 * the same `repo` argument identically.
 */
export function repoKeyOf(item: AnySessionListItem): string {
  if (item.repoRoot !== undefined) return item.repoRoot;
  if (item.source !== "codex") return `${CLAUDE_FALLBACK_PREFIX}${item.projectDirName}`;
  if (item.repoUrl !== undefined) return `${CODEX_REPO_URL_PREFIX}${item.repoUrl}`;
  return `${CODEX_FALLBACK_PREFIX}${item.cwd ?? UNKNOWN_CWD}`;
}

/**
 * Session-detail analog of `repoKeyOf` above — same repo-key resolution
 * (same prefixes, same fallback order), but read from a session's own
 * ANALYSIS fields (`repoRoot`/`source`/`projectDirName` (Claude)/
 * `gitRepositoryUrl` (Codex)/`cwd`) rather than an `AnySessionListItem`,
 * since a session-detail route (`GET /api/sessions/.../:id`, app.ts) has no
 * list item at hand — only the `ClaudeSessionAnalysis`/
 * `CodexSessionAnalysisWithSubagents` it already fetched. Deliberately a
 * SEPARATE small function rather than a generalized `repoKeyOf` parameter
 * type: `AnySessionListItem`'s `projectDirName`/`repoUrl` are discriminated
 * by the `source` union in a way a plain structural interface can't
 * reproduce, and duplicating the ~4-line resolution here is the same
 * "kept in lockstep, not re-imported" tradeoff this file's module doc
 * comment already accepts for `CLAUDE_FALLBACK_PREFIX` et al. (web's
 * `repoFilterKey`). Used by `bash-percentile.ts`'s caller (app.ts) to look
 * up the SAME repo bucket `GET /api/overview`/`get_repo_overview` already
 * aggregate for that session's own list row, so a session's percentile rank
 * is computed against its own repo's distribution, not some other bucket.
 */
export function repoKeyOfSession(session: {
  repoRoot?: string;
  source: SessionSource;
  projectDirName?: string;
  gitRepositoryUrl?: string;
  cwd?: string;
}): string {
  if (session.repoRoot !== undefined) return session.repoRoot;
  if (session.source !== "codex") {
    return `${CLAUDE_FALLBACK_PREFIX}${session.projectDirName ?? ""}`;
  }
  if (session.gitRepositoryUrl !== undefined) {
    return `${CODEX_REPO_URL_PREFIX}${session.gitRepositoryUrl}`;
  }
  return `${CODEX_FALLBACK_PREFIX}${session.cwd ?? UNKNOWN_CWD}`;
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

/**
 * Every matched session's own `bashSummary.resultChars` (ascending — 0 for a
 * session with no Bash calls, since that's still a real, meaningful data
 * point in the distribution) and `bashSummary.estUsd` (ascending, but only
 * from sessions whose `estUsd` was actually known — same partial-sum-when-
 * known posture `BashSummary.estUsd` itself already has, so `estUsd.length`
 * can be shorter than `resultChars.length`/`RepoOverview.sessionCount`).
 *
 * RAW sorted arrays, deliberately NOT precomputed quantile markers
 * (median/p90/...): `@junrei/core`'s `percentileRank` needs the actual
 * per-session distribution to compute an EXACT rank for an arbitrary
 * session's own figure ("this session is P88 for this repo") — a caller
 * holding only a handful of quantile snapshots could at best interpolate an
 * approximate rank. Response size stays bounded regardless of this choice:
 * `matched` (and therefore both arrays) can never exceed `MAX_LIST_LIMIT`
 * (500) sessions, the same ceiling every other `computeRepoOverview` caller
 * already accepts (`getRepoOverview`'s own doc comment) — no extra cap
 * needed here.
 */
export interface RepoOverviewBashDistribution {
  resultChars: number[];
  estUsd: number[];
}

/**
 * Repo-wide Bash/shell-command rollup — see `RepoOverview.bash`. `estUsd`
 * follows the same partial-sum-when-known convention as
 * `BashSummary.estUsd`/`BashStats.totals.estUsd`: undefined only when NOT
 * ONE matched session resolved a known price, never `0`.
 */
export interface RepoOverviewBash {
  calls: number;
  resultChars: number;
  estUsd?: number;
  /** Per-session values feeding `percentileRank` (`@junrei/core`) — see `RepoOverviewBashDistribution`'s doc comment. */
  distribution: RepoOverviewBashDistribution;
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
  /** Repo-wide Bash/shell-command totals + per-session distribution — see `RepoOverviewBash`. */
  bash: RepoOverviewBash;
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
  let bashCalls = 0;
  let bashResultChars = 0;
  let bashEstUsd = 0;
  let bashEstUsdKnown = false;
  const bashResultCharsSamples: number[] = [];
  const bashEstUsdSamples: number[] = [];

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

    bashCalls += item.bashSummary.calls;
    bashResultChars += item.bashSummary.resultChars;
    bashResultCharsSamples.push(item.bashSummary.resultChars);
    if (item.bashSummary.estUsd !== undefined) {
      bashEstUsd += item.bashSummary.estUsd;
      bashEstUsdKnown = true;
      bashEstUsdSamples.push(item.bashSummary.estUsd);
    }
  }

  bashResultCharsSamples.sort((a, b) => a - b);
  bashEstUsdSamples.sort((a, b) => a - b);

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
    bash: {
      calls: bashCalls,
      resultChars: bashResultChars,
      ...(bashEstUsdKnown && { estUsd: bashEstUsd }),
      distribution: {
        resultChars: bashResultCharsSamples,
        estUsd: bashEstUsdSamples,
      },
    },
  };
}

/**
 * `getRepoOverview` memoization (perf fix, PR C review finding + v2 PR D) —
 * `bash-percentile.ts`'s `resolveBashPercentile` calls `getRepoOverview` on
 * EVERY session-detail request (both the `GET /api/sessions/{source}/:id`
 * routes and, as of PR D, the `get_bash_stats` MCP tool),
 * and `getRepoOverview` itself was an unconditional `listSessions(500,
 * "all")` — a full directory sweep across every session-file store — plus a
 * repo-key filter/aggregation pass over the result, on EVERY call, even when
 * ten requests in a row ask about the SAME repo within the same second (e.g.
 * an agent walking a repo's recent sessions one at a time via MCP).
 *
 * Per-file ANALYSIS is already mtime-keyed-cached one layer down (see
 * `sources/claude.ts`'s `analyzeCached` / `sources/codex.ts`'s
 * `analyzeCodexCached`), so a repeat `listSessions` call doesn't re-parse
 * unchanged transcripts — but it still re-walks the directory tree, re-reads
 * every ref's stat info, and re-runs `computeRepoOverview`'s full filter +
 * aggregation pass over up to `MAX_LIST_LIMIT` (500) items. That's the cost
 * this cache actually removes.
 *
 * Chosen invalidation: a plain TTL (`REPO_OVERVIEW_CACHE_TTL_MS`, keyed by
 * `repoKey`) rather than a session-list "version" signal — `listSessions`
 * exposes no cheap change signal of its own (no directory mtime, no
 * generation counter; each adapter's `listItems` re-walks its own store on
 * every call), so the only invalidation cheaper than "just re-list" would be
 * inventing and maintaining a new signal purely for this cache. A flat TTL is
 * the honest, minimal choice: STALENESS BOUND — this function's result can
 * lag real filesystem state by up to `REPO_OVERVIEW_CACHE_TTL_MS` (currently
 * 30s), so a session that just landed on disk may not appear in a repo's
 * `bash.distribution`/`sessionCount`/etc. for up to 30s. Acceptable here
 * because every caller of this path (percentile ranking, the repo-overview
 * screen, the MCP tool) is itself a "roughly how does this compare" read,
 * never a source of truth for an individual session's own numbers (those
 * come straight from that session's own, unmemoized, mtime-fresh analysis).
 *
 * `nowMs` is an optional override (same "override X for tests" convention
 * `sources/reconstruction.ts`'s filesystem providers use for their root dirs)
 * so tests can assert the TTL boundary deterministically instead of racing a
 * real 30-second clock — see `overview.test.ts`'s memoization test. Defaults
 * to `Date.now()` for every real caller.
 */
const REPO_OVERVIEW_CACHE_TTL_MS = 30_000;

interface RepoOverviewCacheEntry {
  overview: RepoOverview;
  expiresAtMs: number;
}

const repoOverviewCache = new Map<string, RepoOverviewCacheEntry>();

/**
 * The one listing+aggregation path every repo-overview surface calls through
 * — `GET /api/overview` (app.ts), `bash-percentile.ts`'s
 * `resolveBashPercentile` (called from both the `GET /api/sessions/{source}/:id`
 * routes and the `get_bash_stats` MCP tool), and the `get_repo_overview` MCP
 * tool (mcp.ts) all just forward `repoKey` here, so there's no risk of the
 * surfaces silently drifting (e.g. one forgetting the `MAX_LIST_LIMIT`
 * ceiling or filtering by source) — AND all of them automatically share the
 * memoization above, being the same module-level cache. See
 * `computeRepoOverview`'s doc comment for the accepted `repoKey` forms.
 *
 * Note this is a repo-scoped ALL-TIME rollup (newest `MAX_LIST_LIMIT`
 * window) with no notion of the web UI's date/search filters — the
 * session-list band stopped consuming it for exactly that reason and
 * computes a filter-aware rollup client-side instead (the web's
 * `computeFilteredOverview`, kept in lockstep with `computeRepoOverview`
 * above).
 */
export async function getRepoOverview(
  repoKey: string,
  nowMs: number = Date.now(),
): Promise<RepoOverview> {
  const cached = repoOverviewCache.get(repoKey);
  if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.overview;

  const { sessions } = await listSessions(MAX_LIST_LIMIT, "all");
  const overview = computeRepoOverview(sessions, repoKey);
  repoOverviewCache.set(repoKey, { overview, expiresAtMs: nowMs + REPO_OVERVIEW_CACHE_TTL_MS });
  return overview;
}
