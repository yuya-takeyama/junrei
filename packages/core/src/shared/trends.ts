/**
 * Multi-day trend aggregation — `computeTrends` buckets a set of session-list
 * items (Claude + Codex, already-computed, no transcript re-reads — same
 * "pure function over list items" shape as `packages/server/src/overview.ts`'s
 * `computeRepoOverview`, which this module's bucketing/repo-key/delegation
 * patterns deliberately mirror) into per-LOCAL-DAY buckets over a window,
 * plus a current-vs-previous-window summary and simple anomaly detection.
 *
 * Lives in `@junrei/core` (not `packages/server`) so a future MCP tool
 * (Phase 3) can call it directly without depending on the server package.
 * Because of that, `TrendSessionItem` below is a STRUCTURAL subset of the
 * server's `AnySessionListItem` (`packages/server/src/sessions.ts`) declared
 * independently here — core can't import server's types (wrong dependency
 * direction), but every real list item already has every field this module
 * needs, so passing `AnySessionListItem[]` to `computeTrends` type-checks
 * with no adapter/mapping step required.
 */
import { cacheHitRate } from "./metrics.js";
import type { SessionSource } from "./session-analysis.js";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** Per-model rollup a trend session item must carry — structurally the same as the server's lean `UsageByModelEntry` (`sources/shared.ts`). */
export interface TrendModelUsageEntry {
  model: string;
  /** undefined only when this model has no known pricing. */
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** One scope's (main thread, or every subagent combined) slim cost slice — structurally the server's `DelegationScopeSliceLite`. */
export interface TrendDelegationSlice {
  tokens: number;
  /** undefined only when this scope's usage includes a model with no known pricing. */
  costUsd?: number;
}

/** Sum of subagent `returnedChars` for one session — see `SubagentNode.returnedChars`. */
export interface TrendSubagentReturn {
  count: number;
  totalChars: number;
}

/**
 * The subset of a session-list item `computeTrends` reads. Every real list
 * item (`ClaudeSessionListItem` / `CodexSessionListItem`, server-side)
 * satisfies this structurally — see the module doc comment. `projectDirName`
 * (Claude-only) and `repoUrl` (Codex-only) are both declared optional here
 * (rather than as a discriminated union keyed on `source`) purely to keep
 * this a single flat interface; `trendRepoKey` below branches on `source`
 * itself to pick the right one, same as the server's `repoKeyOf`.
 */
export interface TrendSessionItem {
  sessionId: string;
  source: SessionSource;
  cwd?: string;
  repoRoot?: string;
  projectDirName?: string;
  repoUrl?: string;
  startedAt?: string;
  durationMs?: number;
  userTurnCount: number;
  totalCostUsd: number;
  compactionCount: number;
  firstUserPrompt?: string;
  usageByModel: readonly TrendModelUsageEntry[];
  delegation: { main: TrendDelegationSlice; subagents: TrendDelegationSlice };
  /**
   * Claude-only in practice — Codex's own `SubagentNode`s never populate
   * `returnedChars` (no parent-side tool_result to measure — see
   * `codex/orchestration.ts`), so a Codex list item omits this entirely
   * rather than reporting a fake all-zero count.
   */
  subagentReturn?: TrendSubagentReturn;
}

export interface TrendsOptions {
  /** Start of the CURRENT window, epoch ms, inclusive. */
  sinceMs: number;
  /** End of the CURRENT window, epoch ms, exclusive — also "now" for the report. */
  untilMs: number;
  /** IANA time zone name — days are bucketed by LOCAL calendar day in this zone (see `localDayKey`). */
  timeZone: string;
  /** Same repo-key semantics as `computeRepoOverview`'s `repoKey` (see `trendRepoKey`) — omitted means no filter. */
  repo?: string;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface TrendWindow {
  sinceMs: number;
  untilMs: number;
  /** Number of calendar-day buckets — `round((untilMs - sinceMs) / 86400000)`. */
  days: number;
  timeZone: string;
  bucket: "day";
}

/** One model's cost/token rollup within a single day bucket — see `TrendBucket.byModel`. */
export interface TrendModelCost {
  model: string;
  /** undefined only when this model has no known pricing. */
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
}

/** Main-vs-subagents cost split within a single day bucket — see `TrendBucket.delegation`. */
export interface TrendDelegationCostSplit {
  main: { costUsd?: number };
  subagents: { costUsd?: number };
}

export interface TrendTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** One LOCAL calendar day's rollup — zero-filled for a day with no sessions (see `computeTrends`). */
export interface TrendBucket {
  /** Local calendar day, `YYYY-MM-DD` (see `localDayKey`). */
  date: string;
  sessionCount: number;
  userTurnCount: number;
  totalDurationMs: number;
  totalCostUsd: number;
  tokens: TrendTokenTotals;
  /** Cost-descending. */
  byModel: TrendModelCost[];
  delegation: TrendDelegationCostSplit;
  /** `cacheHitRate` over `tokens` — null (not 0) when there's no effective-input volume at all this day. */
  cacheHitRate: number | null;
  compactionCount: number;
  /** Merged across every session in the bucket that had one — null when none did. */
  subagentReturn: TrendSubagentReturn | null;
}

/** Totals over one whole window (current or previous) — see `TrendsReport.summary`. */
export interface TrendWindowTotals {
  totalCostUsd: number;
  sessionCount: number;
  /** null when there's no effective-input volume in the window at all. */
  cacheHitRate: number | null;
  /** Subagent cost as a share of total cost — null when total cost is 0 or any contributing session's subagent slice is unpriced. */
  subagentCostShare: number | null;
}

/** Null-safe current-vs-previous deltas — every field null when the corresponding pair can't be compared (see each field's producing formula). */
export interface TrendDelta {
  /** Percent change, `(current - previous) / previous * 100` — null when `previous` is 0. */
  totalCostUsdPct: number | null;
  sessionCountPct: number | null;
  /** Percentage-POINT change (not percent) — null when either side is null. */
  cacheHitRatePts: number | null;
  /** Percentage-POINT change (not percent) — null when either side is null. */
  subagentCostSharePts: number | null;
}

/** One day whose cost was a statistical outlier — see `computeTrends`'s spike-detection doc comment. */
export interface TrendSpikeDay {
  date: string;
  costUsd: number;
  /** Window-wide mean daily cost (population, over every bucket including zero-cost days). */
  mean: number;
  /** Window-wide population standard deviation of daily cost, same basis as `mean`. */
  stddev: number;
}

/** One of the top-5-by-cost sessions in the CURRENT window — see `TrendsReport.anomalies.topSessions`. */
export interface TrendTopSession {
  sessionId: string;
  source: SessionSource;
  /** Same key scheme as `computeRepoOverview`'s `repo` — see `trendRepoKey`. */
  repoKey: string;
  startedAt?: string;
  totalCostUsd: number;
  /** Truncated to `TOP_SESSION_PROMPT_TRUNCATE` (120) chars — a preview, not the full prompt. */
  firstUserPrompt?: string;
}

export interface TrendsReport {
  window: TrendWindow;
  /** Oldest -> newest, one entry per calendar day in the window, zero-filled. */
  buckets: TrendBucket[];
  summary: {
    current: TrendWindowTotals;
    /** null when the equal-length window immediately before `sinceMs` had zero matching sessions. */
    previous: TrendWindowTotals | null;
    /** null exactly when `previous` is null. */
    delta: TrendDelta | null;
  };
  anomalies: {
    spikeDays: TrendSpikeDay[];
    topSessions: TrendTopSession[];
  };
}

// ---------------------------------------------------------------------------
// Repo-key matching — duplicated (not imported), same precedent as
// `overview.ts`'s `repoKeyOf`
// ---------------------------------------------------------------------------

// Fallback-bucket key prefixes for sessions with no `repoRoot`. Duplicated
// (not imported) from `packages/server/src/overview.ts`'s `repoKeyOf` —
// itself already duplicated (not imported) from the web's
// `sessionListHelpers.ts#repoFilterKey`, per that file's own doc comment,
// because the web package isn't a server dependency. This is the THIRD
// independent copy for the same underlying reason: `@junrei/core` can't
// depend on `packages/server` (wrong dependency direction — server depends
// on core, not vice versa). Keep all three key schemes in lockstep.
const CLAUDE_FALLBACK_PREFIX = "claude-project:";
const CODEX_REPO_URL_PREFIX = "codex-repo:";
const CODEX_FALLBACK_PREFIX = "codex-cwd:";
const UNKNOWN_CWD = "(unknown cwd)";

/** Same repo-key derivation as `computeRepoOverview`'s `repoKeyOf` — see that function's doc comment for the accepted key forms. */
function trendRepoKey(item: TrendSessionItem): string {
  if (item.repoRoot !== undefined) return item.repoRoot;
  if (item.source !== "codex") return `${CLAUDE_FALLBACK_PREFIX}${item.projectDirName ?? ""}`;
  if (item.repoUrl !== undefined) return `${CODEX_REPO_URL_PREFIX}${item.repoUrl}`;
  return `${CODEX_FALLBACK_PREFIX}${item.cwd ?? UNKNOWN_CWD}`;
}

// ---------------------------------------------------------------------------
// Local-day bucketing
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Local calendar day (`YYYY-MM-DD`) for an epoch-ms instant in an IANA time
 * zone. `en-CA` is the one built-in locale whose default date format IS
 * `YYYY-MM-DD`, so this needs no date library and no manual field
 * reassembly — matches the option's doc comment ("no date libraries").
 */
function localDayKey(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/** Every calendar day in `[sinceMs, sinceMs + days*DAY_MS)`, stepped in fixed 24h increments and formatted per `localDayKey`.
 *
 * This assumes no DST transition falls inside the window shifts a 24h step
 * across a local-day boundary twice (or zero times) in the target zone — an
 * accepted Phase-1 simplification (no date-arithmetic library), same
 * "no date libraries" constraint the option's doc comment states. `days` is
 * always derived from a whole number of 24h periods (`untilMs - sinceMs`),
 * so this reliably produces exactly `days` entries.
 */
function dayBucketDates(sinceMs: number, days: number, timeZone: string): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(localDayKey(sinceMs + i * DAY_MS, timeZone));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Null-safe optional-cost summation — same semantics as `overview.ts`'s
// `sumOptional`: once ANY contributing value is undefined (unpriced), the
// running total stays undefined for good.
// ---------------------------------------------------------------------------

function sumOptional(running: number | undefined, delta: number | undefined): number | undefined {
  return running === undefined || delta === undefined ? undefined : running + delta;
}

// ---------------------------------------------------------------------------
// Bucket accumulation
// ---------------------------------------------------------------------------

interface MutableBucket {
  date: string;
  sessionCount: number;
  userTurnCount: number;
  totalDurationMs: number;
  totalCostUsd: number;
  tokens: TrendTokenTotals;
  byModel: Map<string, TrendModelCost>;
  mainCostUsd: number | undefined;
  subagentsCostUsd: number | undefined;
  compactionCount: number;
  subagentReturnCount: number;
  subagentReturnChars: number;
}

function freshBucket(date: string): MutableBucket {
  return {
    date,
    sessionCount: 0,
    userTurnCount: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    byModel: new Map(),
    // Starts at 0 (not undefined) — a bucket with zero sessions has a real,
    // known $0 delegation split, not an unpriced one. Mirrors
    // `overview.ts`'s `mainCost`/`subagentCost` accumulator seeding.
    mainCostUsd: 0,
    subagentsCostUsd: 0,
    compactionCount: 0,
    subagentReturnCount: 0,
    subagentReturnChars: 0,
  };
}

function accumulate(bucket: MutableBucket, item: TrendSessionItem): void {
  bucket.sessionCount += 1;
  bucket.userTurnCount += item.userTurnCount;
  bucket.totalDurationMs += item.durationMs ?? 0;
  bucket.totalCostUsd += item.totalCostUsd;
  bucket.compactionCount += item.compactionCount;

  for (const m of item.usageByModel) {
    bucket.tokens.inputTokens += m.inputTokens;
    bucket.tokens.outputTokens += m.outputTokens;
    bucket.tokens.cacheReadTokens += m.cacheReadTokens;
    bucket.tokens.cacheCreationTokens += m.cacheCreationTokens;

    const existing = bucket.byModel.get(m.model) ?? {
      model: m.model,
      inputTokens: 0,
      outputTokens: 0,
    };
    existing.inputTokens += m.inputTokens;
    existing.outputTokens += m.outputTokens;
    if (m.costUsd !== undefined) existing.costUsd = (existing.costUsd ?? 0) + m.costUsd;
    bucket.byModel.set(m.model, existing);
  }

  bucket.mainCostUsd = sumOptional(bucket.mainCostUsd, item.delegation.main.costUsd);
  bucket.subagentsCostUsd = sumOptional(bucket.subagentsCostUsd, item.delegation.subagents.costUsd);

  if (item.subagentReturn !== undefined) {
    bucket.subagentReturnCount += item.subagentReturn.count;
    bucket.subagentReturnChars += item.subagentReturn.totalChars;
  }
}

/** `cacheHitRate` over `tokens`, but null (not 0) when there's no effective-input volume — see `TrendBucket.cacheHitRate`'s doc comment. */
function cacheHitRateOrNull(tokens: TrendTokenTotals): number | null {
  const denominator = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens;
  return denominator > 0 ? cacheHitRate(tokens) : null;
}

function finalizeBucket(bucket: MutableBucket): TrendBucket {
  return {
    date: bucket.date,
    sessionCount: bucket.sessionCount,
    userTurnCount: bucket.userTurnCount,
    totalDurationMs: bucket.totalDurationMs,
    totalCostUsd: bucket.totalCostUsd,
    tokens: bucket.tokens,
    byModel: [...bucket.byModel.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    delegation: {
      main: { ...(bucket.mainCostUsd !== undefined && { costUsd: bucket.mainCostUsd }) },
      subagents: {
        ...(bucket.subagentsCostUsd !== undefined && { costUsd: bucket.subagentsCostUsd }),
      },
    },
    cacheHitRate: cacheHitRateOrNull(bucket.tokens),
    compactionCount: bucket.compactionCount,
    subagentReturn:
      bucket.subagentReturnCount > 0
        ? { count: bucket.subagentReturnCount, totalChars: bucket.subagentReturnChars }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Window totals, delta, anomalies
// ---------------------------------------------------------------------------

function windowTotals(items: readonly TrendSessionItem[]): TrendWindowTotals {
  let totalCostUsd = 0;
  const tokens: TrendTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let subagentCostUsd: number | undefined = 0;

  for (const item of items) {
    totalCostUsd += item.totalCostUsd;
    for (const m of item.usageByModel) {
      tokens.inputTokens += m.inputTokens;
      tokens.outputTokens += m.outputTokens;
      tokens.cacheReadTokens += m.cacheReadTokens;
      tokens.cacheCreationTokens += m.cacheCreationTokens;
    }
    subagentCostUsd = sumOptional(subagentCostUsd, item.delegation.subagents.costUsd);
  }

  const subagentCostShare =
    subagentCostUsd !== undefined && totalCostUsd > 0 ? subagentCostUsd / totalCostUsd : null;

  return {
    totalCostUsd,
    sessionCount: items.length,
    cacheHitRate: cacheHitRateOrNull(tokens),
    subagentCostShare,
  };
}

/** Percent change, null when `previous` is 0 (divide-by-zero guard, not "no data" — `previous` being null entirely is handled by the caller). */
function pctChange(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

/** Percentage-POINT change (current/previous are already 0..1 fractions) — null when either side is null. */
function ptsChange(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : (current - previous) * 100;
}

function computeDelta(current: TrendWindowTotals, previous: TrendWindowTotals): TrendDelta {
  return {
    totalCostUsdPct: pctChange(current.totalCostUsd, previous.totalCostUsd),
    sessionCountPct: pctChange(current.sessionCount, previous.sessionCount),
    cacheHitRatePts: ptsChange(current.cacheHitRate, previous.cacheHitRate),
    subagentCostSharePts: ptsChange(current.subagentCostShare, previous.subagentCostShare),
  };
}

/**
 * Minimum count of sessionCount-bearing ("active") days required before spike
 * detection runs at all — with fewer than this many data points, a
 * mean+stddev computed over the window is too noisy to call anything an
 * outlier (a 2-session window where one day cost more than the other isn't a
 * "spike", it's just... the other day).
 */
const MIN_ACTIVE_DAYS_FOR_SPIKE_DETECTION = 4;

/** Number of standard deviations above the mean a day's cost must exceed to be flagged. */
const SPIKE_STDDEV_MULTIPLE = 2;

/**
 * Days whose cost is a statistical outlier vs. the rest of the window.
 *
 * Mean/stddev are computed over EVERY bucket in the window, including
 * zero-cost (zero-session) days — not just the active ones. This is a
 * deliberate choice, not an oversight: the buckets array is already
 * zero-filled for calendar-day continuity, and a repo that's normally quiet
 * (mostly zero-cost days) with one genuinely expensive day should see that
 * day flagged as a real outlier against its normal (near-zero) baseline.
 * Excluding zero days would inflate the baseline mean/stddev toward "typical
 * active-day cost" instead, which would suppress exactly the burst-on-a-quiet-
 * repo case this feature exists to surface, and would also make the "≥4
 * active days" gate below redundant with an "≥4 buckets" gate that's already
 * guaranteed by the smallest supported window (7 days).
 *
 * Population standard deviation (divide by N, not N-1) — this is the full
 * window being measured, not a sample estimating some larger population.
 */
function computeSpikeDays(buckets: readonly TrendBucket[]): TrendSpikeDay[] {
  const activeDays = buckets.filter((b) => b.sessionCount > 0).length;
  if (activeDays < MIN_ACTIVE_DAYS_FOR_SPIKE_DETECTION) return [];

  const costs = buckets.map((b) => b.totalCostUsd);
  const mean = costs.reduce((sum, c) => sum + c, 0) / costs.length;
  const variance = costs.reduce((sum, c) => sum + (c - mean) ** 2, 0) / costs.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + SPIKE_STDDEV_MULTIPLE * stddev;

  return buckets
    .filter((b) => b.totalCostUsd > threshold)
    .map((b) => ({ date: b.date, costUsd: b.totalCostUsd, mean, stddev }));
}

const TOP_SESSIONS_LIMIT = 5;
const TOP_SESSION_PROMPT_TRUNCATE = 120;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function computeTopSessions(items: readonly TrendSessionItem[]): TrendTopSession[] {
  return [...items]
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, TOP_SESSIONS_LIMIT)
    .map((item) => ({
      sessionId: item.sessionId,
      source: item.source,
      repoKey: trendRepoKey(item),
      totalCostUsd: item.totalCostUsd,
      ...(item.startedAt !== undefined && { startedAt: item.startedAt }),
      ...(item.firstUserPrompt !== undefined && {
        firstUserPrompt: truncate(item.firstUserPrompt, TOP_SESSION_PROMPT_TRUNCATE),
      }),
    }));
}

// ---------------------------------------------------------------------------
// computeTrends
// ---------------------------------------------------------------------------

/**
 * Aggregate session-list items into a multi-day trend report: per-local-day
 * buckets (zero-filled) over `[options.sinceMs, options.untilMs)`, a
 * current-vs-previous-window summary (the "previous" window is the
 * equal-length span immediately before `sinceMs`), and simple anomaly
 * detection (cost spike days, top sessions by cost).
 *
 * `items` should include every session whose `startedAt` falls in EITHER
 * window (current or previous) — this function does the windowing itself
 * (see the loop below), so passing extra items outside both windows is
 * harmless (they're silently excluded), but passing too NARROW a set will
 * silently undercount `summary.previous`. `GET /api/trends` (server) is
 * expected to fetch the full 2×`days` span up front — see that route's doc
 * comment.
 *
 * A session with no `startedAt` (or an unparseable one) can't be assigned to
 * either window and is excluded entirely, from every total — there's no
 * "uncategorized" bucket to fall back to (unlike `computeRepoOverview`,
 * which still counts such a session in its all-time totals; this function
 * has no all-time total to count it into).
 */
export function computeTrends(
  items: readonly TrendSessionItem[],
  options: TrendsOptions,
): TrendsReport {
  const { sinceMs, untilMs, timeZone, repo } = options;
  const days = Math.max(0, Math.round((untilMs - sinceMs) / DAY_MS));
  const previousSinceMs = sinceMs - (untilMs - sinceMs);

  const filtered = repo === undefined ? items : items.filter((item) => trendRepoKey(item) === repo);

  const currentItems: TrendSessionItem[] = [];
  const previousItems: TrendSessionItem[] = [];
  for (const item of filtered) {
    if (item.startedAt === undefined) continue;
    const ms = Date.parse(item.startedAt);
    if (Number.isNaN(ms)) continue;
    if (ms >= sinceMs && ms < untilMs) {
      currentItems.push(item);
    } else if (ms >= previousSinceMs && ms < sinceMs) {
      previousItems.push(item);
    }
  }

  const bucketDates = dayBucketDates(sinceMs, days, timeZone);
  const bucketsByDate = new Map<string, MutableBucket>();
  for (const date of bucketDates) {
    bucketsByDate.set(date, freshBucket(date));
  }
  for (const item of currentItems) {
    // Already validated (parseable, non-NaN) in the windowing loop above.
    const ms = Date.parse(item.startedAt as string);
    const bucket = bucketsByDate.get(localDayKey(ms, timeZone));
    // A day-key miss here means the fixed-24h-step bucket list (see
    // `dayBucketDates`) didn't land exactly on this session's local day —
    // the known DST edge case documented there. The session still counts in
    // `summary.current`/`anomalies.topSessions` either way; it just has no
    // bucket to add its per-day figures into.
    if (bucket !== undefined) accumulate(bucket, item);
  }

  const buckets = bucketDates.map((date) => {
    const bucket = bucketsByDate.get(date);
    // Every date in `bucketDates` was just inserted into `bucketsByDate`
    // above — this is defensive, not a real possibility.
    return bucket === undefined ? finalizeBucket(freshBucket(date)) : finalizeBucket(bucket);
  });

  const current = windowTotals(currentItems);
  const previous = previousItems.length > 0 ? windowTotals(previousItems) : null;
  const delta = previous === null ? null : computeDelta(current, previous);

  return {
    window: { sinceMs, untilMs, days, timeZone, bucket: "day" },
    buckets,
    summary: { current, previous, delta },
    anomalies: {
      spikeDays: computeSpikeDays(buckets),
      topSessions: computeTopSessions(currentItems),
    },
  };
}
