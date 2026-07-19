/**
 * Server-side binding of the pure `@junrei/core` insight layer to real
 * session/learning I/O — the "gather" tier the PR2 MCP tools and the
 * `/api/briefing` · `/api/learnings` REST routes both call.
 *
 * The core insight functions (`buildBriefing`/`buildSessionInsight`/
 * `findPatterns`) are PURE over already-collected inputs (see their own doc
 * comments); everything impure — listing sessions, loading each one's
 * analysis, computing the trend window, reading/writing the repo-local
 * learning ledger — lives HERE so it's shared between the MCP surface and
 * REST without either owning the I/O. Nothing in this module re-parses a
 * transcript by hand: it reuses the same mtime-cached loaders
 * (`getSession`/`getCodexSession`/`listAllSessionsInBounds`) and pure
 * aggregators (`computeTrends`) the rest of the server already relies on.
 */

import { basename, isAbsolute } from "node:path";
import {
  type Briefing,
  type BriefingSessionInput,
  type BriefingSubagentLaunch,
  buildBriefing,
  buildSessionInsight,
  type ClaudeSessionAnalysis,
  computeTrends,
  type Detail,
  type FindPatternsResult,
  findPatterns,
  type Learning,
  type LearningStatus,
  type LearningVerification,
  listLearnings,
  type OversizedReturn,
  type PatternKind,
  type PatternSessionInput,
  type PatternTextHit,
  resolveRepoRoot,
  type SessionInsight,
  type SessionInsightInput,
  type SessionSource,
  type SubagentNode,
  type TrendsReport,
  type TrendWindowTotals,
} from "@junrei/core";
import { repoKeyOf } from "./overview.js";
import { searchSessions } from "./search.js";
import {
  type AnySessionListItem,
  type CodexSessionAnalysisWithSubagents,
  getCodexSession,
  getSession,
  listAllSessionsInBounds,
  listSessions,
} from "./sessions.js";
import { DEFAULT_TRENDS_TIMEZONE, TRENDS_DAY_MS } from "./trends-params.js";

/** Either harness's full analysis — both carry the subagent forest the insight mappers read. */
type AnyAnalysis = ClaudeSessionAnalysis | CodexSessionAnalysisWithSubagents;

/** Default lookback for `briefing`'s window summary + per-session waste material. */
export const DEFAULT_BRIEFING_DAYS = 7;
/** Default lookback for `find_patterns`' cross-session aggregation. */
export const DEFAULT_PATTERNS_DAYS = 14;
/** Default before/after comparison window (each side) for `review_learnings`. */
export const DEFAULT_REVIEW_WINDOW_DAYS = 14;

/**
 * How many recent sessions to scan when discovering the set of distinct repo
 * roots that own a learning ledger — a global `briefing`/`review_learnings`
 * (no explicit `repoPath`) reads every ledger under these roots. A ceiling,
 * not an exact count: a repo with no session in this slice simply isn't
 * discovered here (pass its `repoPath` explicitly to reach it).
 */
const KNOWN_REPO_ROOTS_SCAN_LIMIT = 500;

/** Load either harness's forest-inclusive analysis by bare session id (both loaders are mtime-cached). */
async function loadAnalysis(
  source: SessionSource,
  sessionId: string,
): Promise<AnyAnalysis | undefined> {
  return source === "codex" ? getCodexSession(sessionId) : getSession(sessionId);
}

/** Depth-first flatten of a subagent forest into a flat node list (parents before children). */
function flattenSubagents(nodes: readonly SubagentNode[]): SubagentNode[] {
  const out: SubagentNode[] = [];
  const walk = (node: SubagentNode) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/**
 * Every subagent node whose parent-side return was actually measured, as the
 * insight layer's `OversizedReturn` shape. `costUsd` is deliberately omitted:
 * pricing a return means charging the parent's model for re-reading those
 * chars as input context, which no loader computes today — leaving it unset
 * lets `oversizedReturnsToWaste` rank the finding as unpriced (honest)
 * instead of inventing a dollar figure.
 */
function oversizedReturnsOf(flat: readonly SubagentNode[]): OversizedReturn[] {
  return flat
    .filter((n) => n.returnedChars !== undefined)
    .map((n) => ({ agentId: n.agentId, returnedChars: n.returnedChars as number }));
}

/** Codex has no repetition/task-execution analysis, so mark those unavailable rather than implying zero. */
function notAvailableFor(source: SessionSource): string[] | undefined {
  return source === "codex" ? ["repetitions", "taskExecutions"] : undefined;
}

/** Map one loaded analysis into `buildBriefing`'s per-session waste/wins material. */
function toBriefingSessionInput(a: AnyAnalysis): BriefingSessionInput {
  const flat = flattenSubagents(a.subagents ?? []);
  const notAvailable = notAvailableFor(a.source);
  const launches: BriefingSubagentLaunch[] = flat.map((n) => ({
    ...(n.model !== undefined && { model: n.model }),
    returnedChars: n.returnedChars ?? 0,
    // Only a fully-priced subagent contributes to a win's avg cost — a lower
    // bound would silently understate an expensive delegation pattern.
    ...(n.usage.total.costIsComplete && { costUsd: n.usage.total.costUsd }),
    ...(n.status !== undefined && { status: n.status }),
  }));
  return {
    source: a.source,
    sessionId: a.sessionId,
    ...(a.title !== undefined && { title: a.title }),
    opportunities: a.bashStats.opportunities,
    oversizedReturns: oversizedReturnsOf(flat),
    subagentLaunches: launches,
    ...(notAvailable !== undefined && { notAvailable }),
  };
}

/** Map one loaded analysis into `findPatterns`' cross-session delegation/waste material. */
function toPatternSessionInput(a: AnyAnalysis): PatternSessionInput {
  const flat = flattenSubagents(a.subagents ?? []);
  const measuredReturns = flat.filter((n) => n.returnedChars !== undefined);
  const subagentReturnChars = measuredReturns.reduce((s, n) => s + (n.returnedChars as number), 0);
  return {
    source: a.source,
    sessionId: a.sessionId,
    subagentCount: a.subagentCount ?? 0,
    // "Which models the delegation actually touched" — the models with any
    // subagent-side token volume, the lever `find_patterns` groups shapes by.
    delegationModels: a.delegation.byModel
      .filter((m) => m.subagents.tokens > 0)
      .map((m) => m.model),
    totalCostUsd: a.totalUsage.costUsd,
    ...(measuredReturns.length > 0 && { subagentReturnChars }),
    wasteClasses: a.bashStats.opportunities.map((o) => o.class),
  };
}

/** Map one loaded analysis into `buildSessionInsight`'s input subset. */
function toSessionInsightInput(a: AnyAnalysis, detail: Detail): SessionInsightInput {
  const flat = flattenSubagents(a.subagents ?? []);
  const notAvailable = notAvailableFor(a.source);
  return {
    source: a.source,
    sessionId: a.sessionId,
    ...(a.title !== undefined && { title: a.title }),
    detail,
    totalCostUsd: a.totalUsage.costUsd,
    costIsComplete: a.totalUsage.costIsComplete,
    models: a.models,
    delegation: a.delegation,
    opportunities: a.bashStats.opportunities,
    byThread: a.bashStats.byThread,
    subagentReturns: oversizedReturnsOf(flat),
    subagentCount: a.subagentCount ?? 0,
    ...(notAvailable !== undefined && { notAvailable }),
  };
}

// ---------------------------------------------------------------------------
// Repo roots + learnings
// ---------------------------------------------------------------------------

/**
 * The distinct repo roots that could own a learning ledger, discovered from
 * the most recent `KNOWN_REPO_ROOTS_SCAN_LIMIT` sessions across both
 * harnesses. Only sessions with a real `repoRoot` (a git checkout, not a
 * fallback bucket key) can host a `<repoRoot>/.junrei/learnings/` dir, so
 * only those contribute.
 */
async function knownRepoRoots(): Promise<string[]> {
  const { sessions } = await listSessions(KNOWN_REPO_ROOTS_SCAN_LIMIT, "all");
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.repoRoot !== undefined) roots.add(s.repoRoot);
  }
  return [...roots];
}

// ---------------------------------------------------------------------------
// repo parameter ergonomics (bare-name resolution)
// ---------------------------------------------------------------------------

/**
 * Fallback-bucket key prefixes — a `repo` starting with one of these names a
 * bucket with no on-disk checkout (see `overview.ts`'s `repoKeyOf`), so it's
 * already a valid opaque key and is NEVER treated as a bare name to resolve.
 */
const FALLBACK_BUCKET_PREFIXES = ["claude-project:", "codex-repo:", "codex-cwd:"] as const;

/**
 * Raised when a bare repo name (e.g. `junrei`) matches more than one known
 * repo root by basename. The caller surfaces the candidates so the user can
 * re-issue with an unambiguous absolute `repoRoot` — a REST route as a 400,
 * an MCP tool as an error with the candidates in its message.
 */
export class AmbiguousRepoError extends Error {
  constructor(
    readonly repo: string,
    readonly candidates: string[],
  ) {
    super(
      `repo "${repo}" matches ${String(candidates.length)} repo roots — pass an absolute repoRoot instead: ${candidates.join(", ")}`,
    );
    this.name = "AmbiguousRepoError";
  }
}

/**
 * Pure repo-key resolution against an already-collected set of known repo
 * roots — the testable core of `resolveRepoParam` below. Rules, in order:
 *  - empty/undefined -> no filter (`{ repo: undefined }`).
 *  - an absolute path (a real `repoRoot`) -> used verbatim.
 *  - a fallback-bucket key (`claude-project:`/`codex-repo:`/`codex-cwd:`) ->
 *    used verbatim (it names a bucket, not a checkout).
 *  - anything else is a BARE NAME: matched against `knownRoots` by `basename`.
 *    Exactly one match -> that root's absolute path; several -> `candidates`
 *    (the caller errors); none -> passed through verbatim, so it simply
 *    matches zero sessions (an honest empty result, never an error).
 */
export function resolveRepoAgainstRoots(
  rawRepo: string | undefined,
  knownRoots: readonly string[],
): { repo?: string; candidates?: string[] } {
  const repo = rawRepo === undefined || rawRepo === "" ? undefined : rawRepo;
  if (repo === undefined) return {};
  if (isAbsolute(repo)) return { repo };
  if (FALLBACK_BUCKET_PREFIXES.some((p) => repo.startsWith(p))) return { repo };
  const matches = [...new Set(knownRoots.filter((root) => basename(root) === repo))].sort();
  if (matches.length > 1) return { candidates: matches };
  // Unique match -> that root's absolute path; no match -> the bare name
  // verbatim (matches zero sessions, an honest empty result).
  const [only] = matches;
  return { repo: only ?? repo };
}

/**
 * Resolve a `repo` parameter to a concrete filter key, accepting a bare repo
 * name (basename of a known repo root) in addition to an absolute `repoRoot`
 * or a fallback-bucket key — the PR3 ergonomics fix (a live `briefing(repo:
 * "junrei")` returned 0 rows because the ledger key is an absolute path).
 * Throws `AmbiguousRepoError` when a bare name matches several roots. Shared
 * by `buildRepoBriefing`/`findPatternsFor` and the REST `/api/briefing` route
 * so every surface resolves `repo` identically.
 */
export async function resolveRepoParam(rawRepo?: string): Promise<string | undefined> {
  const repo = rawRepo === undefined || rawRepo === "" ? undefined : rawRepo;
  if (repo === undefined || isAbsolute(repo)) return repo;
  if (FALLBACK_BUCKET_PREFIXES.some((p) => repo.startsWith(p))) return repo;
  const resolution = resolveRepoAgainstRoots(repo, await knownRepoRoots());
  if (resolution.candidates !== undefined) {
    throw new AmbiguousRepoError(repo, resolution.candidates);
  }
  return resolution.repo;
}

/**
 * The repo roots a learnings read/review should scan. An explicit `repoPath`
 * (or a `repo` that's itself an absolute path — i.e. a repoRoot) pins the
 * scan to that one ledger; otherwise every known repo root is scanned. A
 * `repo` that's a fallback bucket key (`claude-project:…`) has no on-disk
 * ledger, so it resolves to no roots (empty learnings, never an error).
 */
async function resolveLearningRoots(repoPath?: string, repo?: string): Promise<string[]> {
  if (repoPath !== undefined && repoPath !== "") return [repoPath];
  if (repo !== undefined && repo !== "" && isAbsolute(repo)) return [repo];
  if (repo !== undefined && repo !== "") return []; // fallback bucket key — no ledger on disk
  return knownRepoRoots();
}

/** Merged learnings across the resolved repo roots, newest-first, with any per-file skip warnings. */
export async function listLearningsForRepo(options: {
  repoPath?: string;
  repo?: string;
  status?: LearningStatus;
}): Promise<{ learnings: Learning[]; warnings: string[] }> {
  const roots = await resolveLearningRoots(options.repoPath, options.repo);
  const learnings: Learning[] = [];
  const warnings: string[] = [];
  for (const root of roots) {
    const res = await listLearnings(
      root,
      options.status !== undefined ? { status: options.status } : {},
    );
    learnings.push(...res.learnings);
    warnings.push(...res.warnings);
  }
  learnings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { learnings, warnings };
}

/**
 * Resolve the repo root a learning should be created/updated under for a
 * `log_learning` upsert: an explicit `repoPath` wins; otherwise the source
 * session's own `cwd` is normalized via `resolveRepoRoot` (stripping any
 * worktree suffix so every worktree shares one ledger). `undefined` when
 * neither is available (the caller then reports the ambiguity).
 */
export async function resolveLearningRepoRoot(input: {
  repoPath?: string;
  source?: SessionSource;
  sessionId?: string;
}): Promise<string | undefined> {
  if (input.repoPath !== undefined && input.repoPath !== "") return input.repoPath;
  if (input.source !== undefined && input.sessionId !== undefined) {
    const analysis = await loadAnalysis(input.source, input.sessionId);
    if (analysis?.cwd !== undefined) return resolveRepoRoot(analysis.cwd);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// briefing
// ---------------------------------------------------------------------------

/**
 * Collect the trend window and per-session waste/wins material for one repo
 * (or globally), then fold them into a conclusion-first `Briefing` via the
 * pure core builder. Two listing passes on the same axis: a wide one
 * (`2*days+2` days) feeds `computeTrends` its current+previous windows, and
 * the current-window slice of it (repo-filtered, last `days` days by start
 * time) is what gets each session's full analysis loaded for waste/wins — so
 * the expensive per-transcript analysis load is bounded to the window the
 * briefing actually reports on.
 */
export async function buildRepoBriefing(options: {
  repo?: string;
  days?: number;
  detail?: Detail;
}): Promise<Briefing> {
  const days = options.days ?? DEFAULT_BRIEFING_DAYS;
  const detail = options.detail ?? "concise";
  // Accepts a bare repo name in addition to an absolute repoRoot / bucket key
  // (throws AmbiguousRepoError on a multi-match bare name — the caller 400s).
  const repo = await resolveRepoParam(options.repo);

  const nowMs = Date.now();
  const trendsItems = await listAllSessionsInBounds({
    sinceMs: nowMs - (2 * days + 2) * TRENDS_DAY_MS,
    untilMs: nowMs,
  });
  const trends: TrendsReport = computeTrends(trendsItems, {
    nowMs,
    days,
    timeZone: DEFAULT_TRENDS_TIMEZONE,
    ...(repo !== undefined && { repo }),
  });

  // Current-window slice for the per-session waste/wins material: repo-matched
  // and started within the last `days` days. `repoKeyOf` is the same repo-key
  // resolution `computeTrends`' own filter uses, so this can't diverge on
  // which sessions "belong" to the repo.
  const windowStartMs = nowMs - days * TRENDS_DAY_MS;
  const windowItems = trendsItems.filter((item) => {
    if (repo !== undefined && repoKeyOf(item) !== repo) return false;
    if (item.startedAt === undefined) return false;
    const ms = Date.parse(item.startedAt);
    return !Number.isNaN(ms) && ms >= windowStartMs;
  });

  const sessions = await gatherSessionInputs(windowItems, toBriefingSessionInput);
  const { learnings } = await listLearningsForRepo(repo !== undefined ? { repo } : {});

  return buildBriefing({
    ...(repo !== undefined && { repo }),
    days,
    detail,
    trends,
    sessions,
    learnings,
  });
}

/** Load each list item's full analysis and map it, silently skipping any that no longer resolve. */
async function gatherSessionInputs<T>(
  items: readonly AnySessionListItem[],
  map: (a: AnyAnalysis) => T,
): Promise<T[]> {
  const analyses = await Promise.all(
    items.map((item) => loadAnalysis(item.source, item.sessionId)),
  );
  const out: T[] = [];
  for (const analysis of analyses) {
    if (analysis !== undefined) out.push(map(analysis));
  }
  return out;
}

// ---------------------------------------------------------------------------
// analyze_session
// ---------------------------------------------------------------------------

/** Build the single-session insight, or `undefined` when the session doesn't resolve. */
export async function buildSessionInsightFor(options: {
  source: SessionSource;
  sessionId: string;
  detail?: Detail;
}): Promise<SessionInsight | undefined> {
  const analysis = await loadAnalysis(options.source, options.sessionId);
  if (analysis === undefined) return undefined;
  return buildSessionInsight(toSessionInsightInput(analysis, options.detail ?? "concise"));
}

// ---------------------------------------------------------------------------
// find_patterns
// ---------------------------------------------------------------------------

/**
 * Cross-session pattern search. `text` wraps the full-text index (the server
 * runs it; this reshapes the hits); `delegation`/`waste` load each in-window
 * session's analysis and aggregate its delegation shape / waste classes. The
 * per-session analysis load is bounded to the (repo-filtered) window, same as
 * `briefing`.
 */
export async function findPatternsFor(options: {
  kind: PatternKind;
  query?: string;
  repo?: string;
  days?: number;
  detail?: Detail;
}): Promise<FindPatternsResult> {
  const days = options.days ?? DEFAULT_PATTERNS_DAYS;
  const detail = options.detail ?? "concise";
  // Same bare-name ergonomics as briefing (throws AmbiguousRepoError on a
  // multi-match bare name — the caller surfaces the candidates).
  const repo = await resolveRepoParam(options.repo);

  if (options.kind === "text") {
    const response = await searchSessions({
      query: options.query ?? "",
      ...(repo !== undefined && { repo }),
      includeSubagents: false,
    });
    const hits: PatternTextHit[] = [];
    for (const result of response.results) {
      for (const match of result.matches) {
        hits.push({
          source: result.source,
          sessionId: result.sessionId,
          ...(result.title !== undefined && { title: result.title }),
          field: match.field,
          excerpt: match.snippet,
        });
      }
    }
    return findPatterns({
      kind: "text",
      detail,
      ...(options.query !== undefined && { query: options.query }),
      ...(repo !== undefined && { repo }),
      days,
      hits,
    });
  }

  const nowMs = Date.now();
  const items = await listAllSessionsInBounds({
    sinceMs: nowMs - days * TRENDS_DAY_MS,
    untilMs: nowMs,
  });
  const windowItems = repo === undefined ? items : items.filter((item) => repoKeyOf(item) === repo);
  const sessions = await gatherSessionInputs(windowItems, toPatternSessionInput);
  return findPatterns({
    kind: options.kind,
    detail,
    ...(options.query !== undefined && { query: options.query }),
    ...(repo !== undefined && { repo }),
    days,
    sessions,
  });
}

// ---------------------------------------------------------------------------
// review_learnings
// ---------------------------------------------------------------------------

/** The four window metrics `review_learnings` compares before vs. after a learning was applied. */
export interface ReviewWindowMetrics {
  costPerDayUsd: number;
  /** Subagent share of cost, 0-1, null when unpriced / no cost. */
  delegationShare: number | null;
  /** 0-1, null when the window had no effective-input token volume. */
  cacheHitRate: number | null;
  /** Bash spend estimate over the window, undefined when nothing priced. */
  bashEstUsd?: number;
}

/** A computed (never persisted) before/after comparison for one applied learning. */
export interface ReviewComparison {
  windowDays: number;
  before: ReviewWindowMetrics | null;
  after: ReviewWindowMetrics;
  /** A `log_learning`-ready `verification` object for the primary metric (cost/day). */
  suggestedVerification: LearningVerification;
}

export interface ReviewedLearning {
  learning: Learning;
  /** Present only for `applied` learnings with an `appliedAt` timestamp. */
  comparison?: ReviewComparison;
}

function toWindowMetrics(totals: TrendWindowTotals, windowDays: number): ReviewWindowMetrics {
  return {
    costPerDayUsd: windowDays > 0 ? totals.totalCostUsd / windowDays : totals.totalCostUsd,
    delegationShare: totals.subagentCostShare,
    cacheHitRate: totals.cacheHitRate,
    ...(totals.bashEstUsd !== undefined && { bashEstUsd: totals.bashEstUsd }),
  };
}

/**
 * Compute the before/after window comparison for a learning applied at
 * `appliedAtMs`. Anchoring `computeTrends` at `appliedAt + windowDays` makes
 * its CURRENT window the "after" span (`[appliedAt, appliedAt+windowDays]`)
 * and its PREVIOUS window the "before" span (`[appliedAt-windowDays,
 * appliedAt]`) — one report yields both sides with no bespoke bucketing.
 */
async function computeReviewComparison(
  repoRoot: string,
  appliedAtMs: number,
  windowDays: number,
): Promise<ReviewComparison> {
  const anchorMs = appliedAtMs + windowDays * TRENDS_DAY_MS;
  const items = await listAllSessionsInBounds({
    sinceMs: appliedAtMs - (windowDays + 2) * TRENDS_DAY_MS,
    untilMs: anchorMs,
  });
  const trends = computeTrends(items, {
    nowMs: anchorMs,
    days: windowDays,
    timeZone: DEFAULT_TRENDS_TIMEZONE,
    repo: repoRoot,
  });
  const after = toWindowMetrics(trends.summary.current, windowDays);
  const before =
    trends.summary.previous === null ? null : toWindowMetrics(trends.summary.previous, windowDays);
  return {
    windowDays,
    before,
    after,
    suggestedVerification: {
      metric: "costPerDayUsd",
      before: before?.costPerDayUsd ?? 0,
      after: after.costPerDayUsd,
      windowDays,
      note:
        "Auto-computed candidate from the repo's cost trend around appliedAt — " +
        "record it via log_learning (status: verified/rejected) once you judge it.",
    },
  };
}

/**
 * Read the repo's open/applied learnings (read-only — this NEVER writes a
 * status; `log_learning` is the only writer) and attach, to each APPLIED
 * learning, a computed before/after window comparison of the repo's key
 * metrics around its `appliedAt`. `status`, when given, narrows which
 * learnings are returned; the default returns `open` + `applied`.
 */
export async function reviewLearningsFor(options: {
  repoPath?: string;
  repo?: string;
  status?: LearningStatus;
  windowDays?: number;
}): Promise<{ learnings: ReviewedLearning[]; windowDays: number; warnings: string[] }> {
  const windowDays = options.windowDays ?? DEFAULT_REVIEW_WINDOW_DAYS;
  const roots = await resolveLearningRoots(options.repoPath, options.repo);
  const reviewed: ReviewedLearning[] = [];
  const warnings: string[] = [];

  for (const root of roots) {
    const res = await listLearnings(
      root,
      options.status !== undefined ? { status: options.status } : {},
    );
    warnings.push(...res.warnings);
    for (const learning of res.learnings) {
      // Default view: only the actionable open/applied learnings (an explicit
      // `status` filter overrides this — `listLearnings` already applied it).
      if (
        options.status === undefined &&
        learning.status !== "open" &&
        learning.status !== "applied"
      ) {
        continue;
      }
      if (learning.status === "applied" && learning.appliedAt !== undefined) {
        const appliedMs = Date.parse(learning.appliedAt);
        if (!Number.isNaN(appliedMs)) {
          reviewed.push({
            learning,
            comparison: await computeReviewComparison(root, appliedMs, windowDays),
          });
          continue;
        }
      }
      reviewed.push({ learning });
    }
  }

  reviewed.sort((a, b) => b.learning.createdAt.localeCompare(a.learning.createdAt));
  return { learnings: reviewed, windowDays, warnings };
}
