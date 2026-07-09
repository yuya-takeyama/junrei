interface CacheableTokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Fraction of "effective input" tokens (input + cache-read + cache-creation)
 * actually served from cache — shared by the session-level stat strip (L1,
 * `shell/StatStrip.tsx`) and the agent detail shell (L3, `AgentShell.tsx`) so
 * both compute "cache hit" identically instead of duplicating the formula.
 */
export function cacheHitRate(totals: CacheableTokenTotals): number {
  const denominator = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return denominator > 0 ? totals.cacheReadTokens / denominator : 0;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Time-only, 24h — used for the L1 title-block meta line and chart axis labels. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Time with millisecond precision (`14:03:12.480`) — used for the record
 * slide-over's `Started` row (design-spec/17-record-detail.md), where the
 * minute-granular `formatTime` above would collapse everything within the
 * same minute to an identical label.
 */
export function formatTimeMs(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${time}.${ms}`;
}

interface DelegationShareScope {
  tokens: number;
  // `| undefined` explicit (not just `?:`) — the API's JSON-inferred type
  // for an optional field is `T | undefined`, not "may be omitted", under
  // `exactOptionalPropertyTypes`.
  costUsd?: number | undefined;
}

/** Shape shared by `DelegationSummary.main`/`.subagents` — see `@junrei/core`'s `delegation.ts`. */
interface DelegationShareInput {
  main: DelegationShareScope;
  subagents: DelegationShareScope;
}

/**
 * "44% of cost · 77% of tokens" — the delegated (subagents) share of a
 * session's cost and token volume, from a `DelegationSummary`. This is the
 * inverse-ranking signal itself: cost share and token share can (and often
 * do) point in different directions, which is exactly what a mental-math-free
 * reading of both should surface.
 *
 * Returns undefined when there's nothing to report (no subagent tokens at
 * all — the common single-thread session) so callers can fall back to a
 * plain dollar figure. The cost share is omitted (tokens-only string) when
 * either scope's cost is unpriced, rather than guessing.
 */
export function formatDelegatedShare(delegation: DelegationShareInput): string | undefined {
  const { main, subagents } = delegation;
  if (subagents.tokens <= 0) return undefined;

  const totalTokens = main.tokens + subagents.tokens;
  const tokenPct = totalTokens > 0 ? Math.round((subagents.tokens / totalTokens) * 100) : 0;

  if (main.costUsd === undefined || subagents.costUsd === undefined) {
    return `${tokenPct}% of tokens`;
  }
  const totalCost = main.costUsd + subagents.costUsd;
  const costPct = totalCost > 0 ? Math.round((subagents.costUsd / totalCost) * 100) : 0;
  return `${costPct}% of cost · ${tokenPct}% of tokens`;
}

/** Shorten a munged project dir name to its meaningful tail. */
export function formatProject(projectDirName: string, cwd?: string): string {
  if (cwd !== undefined) {
    const parts = cwd.split("/").filter((p) => p !== "");
    return parts.slice(-2).join("/");
  }
  const parts = projectDirName.split("-").filter((p) => p !== "");
  return parts.slice(-2).join("-");
}
