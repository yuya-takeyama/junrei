/**
 * `buildSessionInsight` — the conclusion-first read of ONE session: a headline
 * summary, the cost drivers (which threads/models spent the money), the same
 * dollar-ranked `waste[]` shape the briefing uses, a delegation-health read,
 * and `recommendations[]` — each carrying a ready-to-submit `logLearningCall`
 * template so acting on a recommendation is one `log_learning` call away.
 *
 * Pure over an injected structural subset of a `SessionAnalysis` (the same
 * "declare only the fields I read" approach `TrendSessionItem` takes over the
 * server's list item) — no transcript re-read, no I/O.
 */
import type { BashOpportunity } from "../shared/bash-opportunities.js";
import type { BashThreadGroup } from "../shared/bash-stats.js";
import type { DelegationSummary } from "../shared/delegation.js";
import type { SessionSource } from "../shared/session-analysis.js";
import { buildMeta } from "./meta.js";
import type { Detail, InsightMeta, LearningSource, WasteItem } from "./types.js";
import {
  OVERSIZED_RETURN_CHARS,
  type OversizedReturn,
  opportunitiesToWaste,
  oversizedReturnsToWaste,
  rankWaste,
} from "./waste.js";

/** The subset of a session analysis `buildSessionInsight` reads. */
export interface SessionInsightInput {
  source: SessionSource;
  sessionId: string;
  title?: string;
  detail: Detail;
  totalCostUsd: number;
  costIsComplete: boolean;
  models: string[];
  delegation: DelegationSummary;
  /** From `bashStats` — the waste opportunities and the per-thread $ rollup. */
  opportunities: BashOpportunity[];
  byThread: BashThreadGroup[];
  /** Subagent returns (Claude) — feeds oversized-return waste and delegation health. */
  subagentReturns?: OversizedReturn[];
  subagentCount?: number;
  /** Features this harness doesn't expose (e.g. Codex: repetitions/taskExecutions). */
  notAvailable?: string[];
}

export interface SessionInsightSummary {
  headline: string;
  costUsd: number;
  costIsComplete: boolean;
  models: string[];
  /** Subagent share of cost, 0-1, null when unpriced / no cost. */
  delegationShare: number | null;
}

/** One cost driver — a thread (main or a subagent) ranked by its priced spend. */
export interface CostDriver {
  thread: string;
  model?: string;
  estUsd?: number;
  resultChars: number;
  /** This thread's share of total Bash result chars, 0-100 (from `BashThreadGroup`). */
  charsSharePct: number;
}

export interface DelegationHealth {
  mainCostShare: number | null;
  subagentCostShare: number | null;
  subagentCount: number;
  /** Distinct models seen across the delegation split. */
  models: string[];
  /** Count of subagent returns large enough to be flagged as oversized. */
  oversizedReturnCount: number;
}

/**
 * A recommendation carries a `logLearningCall` — the exact argument object to
 * pass to `log_learning` — so the loop from "insight" to "recorded learning"
 * is a single call with nothing to hand-author.
 */
export interface Recommendation {
  finding: string;
  change: string;
  expectedEffect?: string;
  impactUsd?: number;
  logLearningCall: {
    finding: string;
    change: string;
    expectedEffect?: string;
    sourceSessions: LearningSource[];
  };
}

export interface SessionInsight {
  sessionId: string;
  source: SessionSource;
  summary: SessionInsightSummary;
  costDrivers: CostDriver[];
  waste: WasteItem[];
  delegation: DelegationHealth;
  recommendations: Recommendation[];
  notAvailable?: string[];
  _meta: InsightMeta;
}

const CONCISE_WASTE_LIMIT = 5;
const CONCISE_DRIVERS_LIMIT = 3;
const FULL_DRIVERS_LIMIT = 10;
const RECOMMENDATION_LIMIT = 5;

function pct(part: number | undefined, whole: number): number | null {
  if (part === undefined || whole <= 0) return null;
  return part / whole;
}

function buildSummary(input: SessionInsightInput): SessionInsightSummary {
  const share = pct(input.delegation.subagents.costUsd, input.totalCostUsd);
  const sharePctText = share === null ? "unpriced" : `${Math.round(share * 100)}%`;
  const modelText = input.models.length > 0 ? input.models.join(", ") : "unknown model";
  return {
    headline: `$${input.totalCostUsd.toFixed(2)} across ${modelText}; ${sharePctText} of cost delegated to subagents.`,
    costUsd: input.totalCostUsd,
    costIsComplete: input.costIsComplete,
    models: input.models,
    delegationShare: share,
  };
}

/** Cost drivers = per-thread Bash rollup, priced-desc (unpriced threads sort last). */
function buildCostDrivers(byThread: readonly BashThreadGroup[], limit: number): CostDriver[] {
  return [...byThread]
    .sort((a, b) => {
      if (a.estUsd === undefined && b.estUsd === undefined) return b.resultChars - a.resultChars;
      if (a.estUsd === undefined) return 1;
      if (b.estUsd === undefined) return -1;
      return b.estUsd - a.estUsd;
    })
    .slice(0, limit)
    .map((t) => ({
      thread: t.thread,
      ...(t.model !== undefined && { model: t.model }),
      ...(t.estUsd !== undefined && { estUsd: t.estUsd }),
      resultChars: t.resultChars,
      charsSharePct: t.charsSharePct,
    }));
}

function buildDelegationHealth(input: SessionInsightInput): DelegationHealth {
  const oversized = (input.subagentReturns ?? []).filter(
    (r) => r.returnedChars >= OVERSIZED_RETURN_CHARS,
  ).length;
  return {
    mainCostShare: pct(input.delegation.main.costUsd, input.totalCostUsd),
    subagentCostShare: pct(input.delegation.subagents.costUsd, input.totalCostUsd),
    subagentCount: input.subagentCount ?? 0,
    models: input.delegation.byModel.map((m) => m.model),
    oversizedReturnCount: oversized,
  };
}

/** Turn each top waste finding into a `log_learning`-ready recommendation. */
function buildRecommendations(
  input: SessionInsightInput,
  rankedWaste: readonly WasteItem[],
): Recommendation[] {
  const sourceSessions: LearningSource[] = [
    {
      source: input.source,
      sessionId: input.sessionId,
      ...(input.title !== undefined && { title: input.title }),
    },
  ];
  return rankedWaste.slice(0, RECOMMENDATION_LIMIT).map((w) => {
    const expectedEffect =
      w.impactUsd !== undefined
        ? `Save ~$${w.impactUsd.toFixed(2)} of avoidable spend.`
        : undefined;
    return {
      finding: w.title,
      change: w.fix,
      ...(expectedEffect !== undefined && { expectedEffect }),
      ...(w.impactUsd !== undefined && { impactUsd: w.impactUsd }),
      logLearningCall: {
        finding: w.title,
        change: w.fix,
        ...(expectedEffect !== undefined && { expectedEffect }),
        sourceSessions,
      },
    };
  });
}

function sessionInsightNextSteps(waste: readonly WasteItem[]): string[] {
  if (waste.length === 0) {
    return [
      "No ranked waste in this session — call get_evidence to inspect specific tool calls if you suspect a problem.",
    ];
  }
  return [
    "Submit a recommendation's `logLearningCall` to log_learning to record it.",
    "Call get_evidence (select.type: 'tool_call') to see the underlying call for any finding.",
  ];
}

/** Build the single-session insight from an injected analysis subset. */
export function buildSessionInsight(input: SessionInsightInput): SessionInsight {
  const provenance = {
    source: input.source,
    sessionId: input.sessionId,
    ...(input.title !== undefined && { title: input.title }),
  };
  const allWaste = rankWaste([
    ...opportunitiesToWaste(input.opportunities, provenance),
    ...oversizedReturnsToWaste(input.subagentReturns ?? [], provenance),
  ]);

  const wasteLimit = input.detail === "concise" ? CONCISE_WASTE_LIMIT : allWaste.length;
  const driversLimit = input.detail === "concise" ? CONCISE_DRIVERS_LIMIT : FULL_DRIVERS_LIMIT;
  const waste = allWaste.slice(0, wasteLimit);

  const summary = buildSummary(input);
  const costDrivers = buildCostDrivers(input.byThread, driversLimit);
  const delegation = buildDelegationHealth(input);
  const recommendations = buildRecommendations(input, allWaste);
  const truncated = waste.length < allWaste.length || costDrivers.length < input.byThread.length;

  const payload: Omit<SessionInsight, "_meta"> = {
    sessionId: input.sessionId,
    source: input.source,
    summary,
    costDrivers,
    waste,
    delegation,
    recommendations,
    ...(input.notAvailable !== undefined &&
      input.notAvailable.length > 0 && {
        notAvailable: input.notAvailable,
      }),
  };

  return {
    ...payload,
    _meta: buildMeta(payload, {
      ...(truncated && { truncated: true }),
      nextSteps: sessionInsightNextSteps(allWaste),
    }),
  };
}
