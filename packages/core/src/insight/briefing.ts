/**
 * `buildBriefing` — the "morning paper" for a repo: a conclusion-first roll-up
 * of a trend window into (a) a period summary with previous-window deltas,
 * (b) a dollar-ranked `waste[]` an agent should fix, (c) `wins[]` (delegation
 * patterns that are demonstrably working), (d) the current learning-ledger
 * standing, and (e) the top sessions by cost.
 *
 * Pure over injected data — it consumes an already-computed `TrendsReport`
 * (`shared/trends.ts`) plus per-session waste/delegation material and the
 * repo's current learnings, exactly the way `computeTrends` consumes
 * already-computed session-list items. The server (PR2) does the I/O and
 * hands the pieces in; nothing here reads the filesystem or a transcript.
 */

import type { BashOpportunity } from "../shared/bash-opportunities.js";
import type { SessionSource } from "../shared/session-analysis.js";
import type { TrendsReport } from "../shared/trends.js";
import { classifyArchetype, isContextLifetimeWarning } from "./archetype.js";
import { buildMeta } from "./meta.js";
import type {
  Detail,
  InsightMeta,
  Learning,
  LearningStatus,
  TruncatedField,
  WasteItem,
} from "./types.js";
import {
  type OversizedReturn,
  opportunitiesToWaste,
  oversizedReturnsToWaste,
  rankWaste,
} from "./waste.js";

/** One subagent launch's outcome — the raw material for `wins[]`. */
export interface BriefingSubagentLaunch {
  /** Model the delegated agent ran on (the delegation lever being evaluated). */
  model?: string;
  returnedChars: number;
  costUsd?: number;
  /** Completion evidence — a launch with no status is treated as not-yet-successful. */
  status?: "completed" | "failed" | "unresolved";
}

/** One subagent past the turn-budget outlier bar (>150 tc) — the material a fan-out waste entry's fix text names. */
export interface BriefingTurnOutlier {
  agentId: string;
  label?: string;
  toolCallCount: number;
}

/** Per-session material `buildBriefing` folds into waste/wins. */
export interface BriefingSessionInput {
  source: SessionSource;
  sessionId: string;
  title?: string;
  opportunities: BashOpportunity[];
  oversizedReturns?: OversizedReturn[];
  subagentLaunches?: BriefingSubagentLaunch[];
  /**
   * Archetype/context-lifetime primitives (same inputs `buildSessionInsight`
   * classifies from) — the window aggregates archetype distribution + the
   * context-lifetime warning count from these, and surfaces the worst marathon/
   * fan-out offenders into `waste[]`. All optional so a source that can't
   * supply one (a Codex list item with no priced main share) simply doesn't
   * contribute to that tally.
   */
  totalCostUsd?: number;
  /** `delegation.main.costUsd / totalCostUsd`, 0-1, null when unpriced — the archetype axis. */
  mainCostShare?: number | null;
  /** Max effective request context over the session's timeline. */
  ctxMaxTokens?: number;
  /** How many compactions fired (0 is the never-compacted marathon signal). */
  compactionCount?: number;
  /** Subagents past 150 tool calls — feeds the fan-out turn-budget waste entry. */
  turnOutliers?: BriefingTurnOutlier[];
  /** Features this session's harness doesn't expose (e.g. Codex: repetitions). */
  notAvailable?: string[];
}

export interface BuildBriefingInput {
  /** Repo key this briefing is scoped to, echoed into the output. */
  repo?: string;
  days: number;
  detail: Detail;
  trends: TrendsReport;
  sessions: BriefingSessionInput[];
  /** The repo's current learnings (already read from the ledger). */
  learnings: Learning[];
}

/**
 * One local-calendar day's total cost — the footer sparkbar's series (PR3
 * web Home). Derived verbatim from the trend window's own day buckets
 * (`TrendsReport.buckets`), so the sparkbar can never disagree with the KPI
 * strip's window cost (both trace to the same `computeTrends` output). The
 * series length is the briefing window itself (`days`), not a fixed span —
 * the caption reads "last N days" from `dailyCosts.length` rather than
 * inventing days the window never covered.
 */
export interface BriefingDailyCost {
  /** `YYYY-MM-DD` local calendar day, oldest-first. */
  date: string;
  costUsd: number;
}

/** A demonstrably-working delegation pattern. */
export interface BriefingWin {
  model: string;
  launches: number;
  /** Fraction (0-1) of launches on this model that completed. */
  successRate: number;
  avgReturnChars: number;
  /** Average priced cost across launches that were priced — undefined when none were. */
  avgCostUsd?: number;
}

export interface BriefingLearnings {
  open: number;
  applied: number;
  verified: number;
  rejected: number;
  /** Headline finding text for the most recent few, newest-first. */
  recent: { id: string; finding: string; status: LearningStatus }[];
}

/** Count of window sessions in each cost-share archetype (study §1) — the briefing KPI. */
export interface BriefingArchetypeDistribution {
  marathon: number;
  fanOut: number;
  mixed: number;
}

export interface BriefingSummary {
  window: { days: number; startDate: string; endDate: string };
  costUsd: number;
  sessionCount: number;
  /**
   * How the window's sessions split across the cost-share archetypes (study
   * §1). Only sessions that supplied a `mainCostShare` are classified; an
   * unpriced one lands in `mixed` (see `classifyArchetype`).
   */
  archetypeDistribution: BriefingArchetypeDistribution;
  /**
   * How many window sessions tripped the context-lifetime warning (ran past
   * 200K context with 0 compactions — study R1/A1, the biggest lever). The KPI
   * that answers "how many marathons went un-compacted this week".
   */
  contextLifetimeWarnings: number;
  /**
   * Total recoverable waste this window — the sum of every ranked waste item's
   * known `impactUsd` (across ALL waste, not just the shown slice), or null
   * when nothing in the window could be priced. Computed here so the web KPI
   * strip and the WASTE section header both display ONE server number rather
   * than re-summing `waste[]` client-side (concept G5: no client recompute).
   */
  wasteUsd: number | null;
  /**
   * Total number of ranked waste findings this window — the length of the FULL
   * ranked list, NOT the (≤5) `concise` slice returned in `waste[]`. The web
   * masthead shows this true total ("N waste findings") rather than counting the
   * shown slice (PR3 leftover: the masthead undercounted to the slice size).
   */
  wasteCount: number;
  /** `wasteUsd` as a fraction (0-1) of `costUsd`, or null when either is unavailable. */
  wasteShareOfCost: number | null;
  /** 0-1, null when the window had no effective-input token volume. */
  cacheHitRate: number | null;
  /** Subagent share of cost, 0-1, null when unpriced / no cost. */
  delegationShare: number | null;
  /** Previous-window deltas, null when there was no comparable previous window. */
  delta: {
    costUsdPct: number | null;
    sessionCountPct: number | null;
    cacheHitRatePts: number | null;
    delegationSharePts: number | null;
  } | null;
}

export interface Briefing {
  repo?: string;
  summary: BriefingSummary;
  waste: WasteItem[];
  wins: BriefingWin[];
  learnings: BriefingLearnings;
  /** Per-day cost series over the window, oldest-first — the footer sparkbar. */
  dailyCosts: BriefingDailyCost[];
  topSessions: TrendsReport["anomalies"]["topSessions"];
  /** Features unavailable across the contributing sessions (union), if any. */
  notAvailable?: string[];
  _meta: InsightMeta;
}

/** How many waste/win entries `concise` keeps before flagging truncation. */
const CONCISE_WASTE_LIMIT = 5;
const CONCISE_WINS_LIMIT = 3;
const FULL_WASTE_LIMIT = 50;
const RECENT_LEARNINGS_LIMIT = 5;

/** Total known-dollar waste across every ranked item (null when none was priced), and its share of window cost. */
function wasteTotals(
  allWaste: readonly WasteItem[],
  costUsd: number,
): { wasteUsd: number | null; wasteShareOfCost: number | null } {
  const priced = allWaste.filter((w) => w.impactUsd !== undefined);
  if (priced.length === 0) return { wasteUsd: null, wasteShareOfCost: null };
  const wasteUsd = priced.reduce((sum, w) => sum + (w.impactUsd as number), 0);
  return { wasteUsd, wasteShareOfCost: costUsd > 0 ? wasteUsd / costUsd : null };
}

/** Classify each session (by main-cost share) and tally the archetype distribution over the window. */
function archetypeDistribution(
  sessions: readonly BriefingSessionInput[],
): BriefingArchetypeDistribution {
  const dist: BriefingArchetypeDistribution = { marathon: 0, fanOut: 0, mixed: 0 };
  for (const s of sessions) {
    const archetype = classifyArchetype(s.mainCostShare ?? null);
    if (archetype === "marathon") dist.marathon += 1;
    else if (archetype === "fan-out") dist.fanOut += 1;
    else dist.mixed += 1;
  }
  return dist;
}

/** True when this session ran past the context alarm with no compaction — study R1/A1. */
function sessionHasContextWarning(s: BriefingSessionInput): boolean {
  return isContextLifetimeWarning(s.ctxMaxTokens ?? 0, s.compactionCount ?? 0);
}

function summarize(input: BuildBriefingInput, allWaste: readonly WasteItem[]): BriefingSummary {
  const { window, summary } = input.trends;
  const { current, delta } = summary;
  const { wasteUsd, wasteShareOfCost } = wasteTotals(allWaste, current.totalCostUsd);
  return {
    window: { days: window.days, startDate: window.startDate, endDate: window.endDate },
    costUsd: current.totalCostUsd,
    sessionCount: current.sessionCount,
    archetypeDistribution: archetypeDistribution(input.sessions),
    contextLifetimeWarnings: input.sessions.filter(sessionHasContextWarning).length,
    wasteUsd,
    wasteCount: allWaste.length,
    wasteShareOfCost,
    cacheHitRate: current.cacheHitRate,
    delegationShare: current.subagentCostShare,
    delta:
      delta === null
        ? null
        : {
            costUsdPct: delta.totalCostUsdPct,
            sessionCountPct: delta.sessionCountPct,
            cacheHitRatePts: delta.cacheHitRatePts,
            delegationSharePts: delta.subagentCostSharePts,
          },
  };
}

/**
 * Archetype-lever waste offenders for the window — a `marathon-context` entry
 * per never-compacted marathon and a `fan-out-turn-budget` entry per fan-out
 * with a turn-budget outlier. Deliberately UNPRICED (`impactUsd` omitted): the
 * study's dollar attributions for these levers are JUDGED, not measured (e.g.
 * pair-c "~50% of cost"), and the insight layer never invents a dollar figure.
 * Returned worst-cost-first so that, since `rankWaste` sorts unpriced items
 * after priced ones but keeps their order, the most expensive offender leads
 * among the unpriced entries.
 */
function collectArchetypeWaste(sessions: readonly BriefingSessionInput[]): WasteItem[] {
  const withCost: { costUsd: number; item: WasteItem }[] = [];
  for (const s of sessions) {
    const provenance = {
      source: s.source,
      sessionId: s.sessionId,
      ...(s.title !== undefined && { title: s.title }),
    };
    const cost = s.totalCostUsd ?? 0;
    const archetype = classifyArchetype(s.mainCostShare ?? null);
    if (archetype === "marathon" && sessionHasContextWarning(s)) {
      withCost.push({
        costUsd: cost,
        item: {
          class: "marathon-context",
          title: `Marathon session ran to ${(s.ctxMaxTokens ?? 0).toLocaleString()} context tokens with 0 compactions`,
          fix: "Split multi-PR work into one session per PR and compact once per PR; alarm above 200K context (R1).",
          provenance,
        },
      });
    }
    const outliers = s.turnOutliers ?? [];
    if (archetype === "fan-out" && outliers.length > 0) {
      const worst = [...outliers].sort((a, b) => b.toolCallCount - a.toolCallCount)[0];
      const worstLabel = worst?.label ?? worst?.agentId ?? "a subagent";
      withCost.push({
        costUsd: cost,
        item: {
          class: "fan-out-turn-budget",
          title: `Fan-out session with ${outliers.length} subagent(s) past 150 tool calls (worst: ${worstLabel} at ${worst?.toolCallCount ?? 0})`,
          fix: "Cap subagent turn budgets at ~60 tool calls in every spawn prompt; treat >150 as a design failure (R4).",
          provenance,
        },
      });
    }
  }
  return withCost.sort((a, b) => b.costUsd - a.costUsd).map((x) => x.item);
}

function collectWaste(sessions: readonly BriefingSessionInput[]): WasteItem[] {
  const items: WasteItem[] = [];
  for (const s of sessions) {
    const provenance = {
      source: s.source,
      sessionId: s.sessionId,
      ...(s.title !== undefined && { title: s.title }),
    };
    items.push(...opportunitiesToWaste(s.opportunities, provenance));
    if (s.oversizedReturns !== undefined) {
      items.push(...oversizedReturnsToWaste(s.oversizedReturns, provenance));
    }
  }
  // Archetype offenders lead the pre-rank list so they head the UNPRICED tail
  // after `rankWaste` floats priced Bash/return findings to the top.
  return rankWaste([...collectArchetypeWaste(sessions), ...items]);
}

/**
 * `wins[]` — group every subagent launch by model and report each model's
 * completion rate, mean return size, and mean priced cost. A "win" is a
 * delegation pattern working well (high success, small returns); the agent
 * reads it as "keep doing this", the mirror of `waste`'s "stop doing this".
 * Ranked by launch count (the patterns with the most evidence first).
 */
function collectWins(sessions: readonly BriefingSessionInput[]): BriefingWin[] {
  interface Acc {
    launches: number;
    completed: number;
    returnCharsTotal: number;
    costTotal: number;
    pricedCount: number;
  }
  const byModel = new Map<string, Acc>();
  for (const s of sessions) {
    for (const launch of s.subagentLaunches ?? []) {
      const model = launch.model ?? "(unknown model)";
      const acc = byModel.get(model) ?? {
        launches: 0,
        completed: 0,
        returnCharsTotal: 0,
        costTotal: 0,
        pricedCount: 0,
      };
      acc.launches += 1;
      if (launch.status === "completed") acc.completed += 1;
      acc.returnCharsTotal += launch.returnedChars;
      if (launch.costUsd !== undefined) {
        acc.costTotal += launch.costUsd;
        acc.pricedCount += 1;
      }
      byModel.set(model, acc);
    }
  }
  return [...byModel.entries()]
    .map(([model, acc]) => ({
      model,
      launches: acc.launches,
      successRate: acc.completed / acc.launches,
      avgReturnChars: Math.round(acc.returnCharsTotal / acc.launches),
      ...(acc.pricedCount > 0 && { avgCostUsd: acc.costTotal / acc.pricedCount }),
    }))
    .filter((w) => w.successRate > 0)
    .sort((a, b) => b.launches - a.launches);
}

/** Project the trend window's day buckets onto the sparkbar's `{date, costUsd}` series (oldest-first, as `computeTrends` already orders them). */
function collectDailyCosts(trends: TrendsReport): BriefingDailyCost[] {
  return trends.buckets.map((b) => ({ date: b.date, costUsd: b.totalCostUsd }));
}

function summarizeLearnings(learnings: readonly Learning[]): BriefingLearnings {
  const counts: Record<LearningStatus, number> = { open: 0, applied: 0, verified: 0, rejected: 0 };
  for (const l of learnings) counts[l.status] += 1;
  const recent = [...learnings]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_LEARNINGS_LIMIT)
    .map((l) => ({ id: l.id, finding: l.finding, status: l.status }));
  return { ...counts, recent };
}

function collectNotAvailable(sessions: readonly BriefingSessionInput[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) for (const n of s.notAvailable ?? []) set.add(n);
  return [...set];
}

function briefingNextSteps(summary: BriefingSummary, waste: WasteItem[]): string[] {
  if (summary.sessionCount === 0) {
    return [
      "No sessions in this window — widen `days` or check the `repo` filter.",
      "Call `find_patterns` with a broader window to locate recent activity.",
    ];
  }
  const steps: string[] = [];
  if (waste.length > 0) {
    const topSessionId = waste[0]?.provenance.sessionId ?? "";
    steps.push(
      `Call analyze_session on the top waste item's session (${topSessionId}) for the full breakdown.`,
    );
    steps.push("Once you act on a finding, record it with log_learning.");
  } else {
    steps.push(
      "No ranked waste this window — call find_patterns (kind: 'delegation') to review delegation shape.",
    );
  }
  return steps;
}

/** Build a repo briefing from an already-computed trend window plus per-session material. */
export function buildBriefing(input: BuildBriefingInput): Briefing {
  const allWaste = collectWaste(input.sessions);
  const summary = summarize(input, allWaste);
  const wins = collectWins(input.sessions);
  const learnings = summarizeLearnings(input.learnings);
  const notAvailable = collectNotAvailable(input.sessions);

  const wasteLimit = input.detail === "concise" ? CONCISE_WASTE_LIMIT : FULL_WASTE_LIMIT;
  const winsLimit = input.detail === "concise" ? CONCISE_WINS_LIMIT : wins.length;
  const waste = allWaste.slice(0, wasteLimit);
  const shownWins = wins.slice(0, winsLimit);

  const truncatedFields: TruncatedField[] = [];
  if (waste.length < allWaste.length) {
    truncatedFields.push({ path: "waste", shown: waste.length, total: allWaste.length });
  }
  if (shownWins.length < wins.length) {
    truncatedFields.push({ path: "wins", shown: shownWins.length, total: wins.length });
  }
  if (learnings.recent.length < input.learnings.length) {
    truncatedFields.push({
      path: "learnings.recent",
      shown: learnings.recent.length,
      total: input.learnings.length,
    });
  }

  const payload: Omit<Briefing, "_meta"> = {
    ...(input.repo !== undefined && { repo: input.repo }),
    summary,
    waste,
    wins: shownWins,
    learnings,
    dailyCosts: collectDailyCosts(input.trends),
    topSessions: input.trends.anomalies.topSessions,
    ...(notAvailable.length > 0 && { notAvailable }),
  };

  return {
    ...payload,
    _meta: buildMeta(payload, {
      ...(truncatedFields.length > 0 && { truncatedFields }),
      nextSteps: briefingNextSteps(summary, allWaste),
    }),
  };
}
