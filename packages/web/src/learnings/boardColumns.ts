import type { Learning } from "../api.js";

/**
 * Pure assignment of the repo-local learnings into the loop board's columns
 * (Pattern B: MEASURE / LEARN / CHANGE / VERIFY). MEASURE is fed by the
 * briefing's waste feed, not the ledger, so only three columns are learning-
 * derived here:
 *  - LEARN   = `open` learnings (awaiting an accept/dismiss decision)
 *  - CHANGE  = `applied` learnings (awaiting before/after data)
 *  - VERIFY  = `verified` + `rejected` learnings (resolved, with an effect)
 * Each column is newest-first by `createdAt` — the same order the ledger API
 * already returns. Kept pure so the routing is testable without React.
 */
export interface BoardColumns {
  learn: Learning[];
  change: Learning[];
  verify: Learning[];
}

export function assignColumns(learnings: readonly Learning[]): BoardColumns {
  const byNewest = [...learnings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    learn: byNewest.filter((l) => l.status === "open"),
    change: byNewest.filter((l) => l.status === "applied"),
    verify: byNewest.filter((l) => l.status === "verified" || l.status === "rejected"),
  };
}

/**
 * Loop-health summary strip. Counts are exact; the verified-effect figure is
 * computed ONLY from learnings that carry a `verification` whose metric is
 * `costPerDayUsd` — a Σ(before−after) $/day figure of a single, well-defined
 * unit — and is `null` when none do (never a fabricated aggregate across
 * mixed metrics; concept "numbers, never grades / no invented figures").
 * `cycleTimeDays` is likewise `null` unless every verified learning has both
 * an `appliedAt` and a `resolvedAt` to measure between.
 */
export interface LoopHealth {
  open: number;
  applied: number;
  verified: number;
  rejected: number;
  /** Σ(before−after) $/day over verified learnings whose verification metric is `costPerDayUsd`; null when none carry it. */
  verifiedCostSavingsPerDay: number | null;
  /** Mean days from appliedAt→resolvedAt across verified learnings that have both; null when none do. */
  cycleTimeDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function loopHealth(learnings: readonly Learning[]): LoopHealth {
  const counts = { open: 0, applied: 0, verified: 0, rejected: 0 };
  let savings = 0;
  let savingsCount = 0;
  let cycleTotalMs = 0;
  let cycleCount = 0;

  for (const l of learnings) {
    counts[l.status] += 1;
    if (l.status !== "verified") continue;
    if (l.verification !== undefined && l.verification.metric === "costPerDayUsd") {
      savings += l.verification.before - l.verification.after;
      savingsCount += 1;
    }
    if (l.appliedAt !== undefined && l.resolvedAt !== undefined) {
      const appliedMs = Date.parse(l.appliedAt);
      const resolvedMs = Date.parse(l.resolvedAt);
      if (!Number.isNaN(appliedMs) && !Number.isNaN(resolvedMs) && resolvedMs >= appliedMs) {
        cycleTotalMs += resolvedMs - appliedMs;
        cycleCount += 1;
      }
    }
  }

  return {
    ...counts,
    verifiedCostSavingsPerDay: savingsCount > 0 ? savings : null,
    cycleTimeDays: cycleCount > 0 ? cycleTotalMs / cycleCount / DAY_MS : null,
  };
}
