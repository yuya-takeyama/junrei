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
import { isOpusClassModel } from "../shared/model-class.js";
import type { SessionSource } from "../shared/session-analysis.js";
import {
  classifyArchetype,
  isContextLifetimeWarning,
  type SessionArchetype,
  TURN_OUTLIER_THRESHOLD,
  TURN_WATCH_THRESHOLD,
} from "./archetype.js";
import { buildMeta } from "./meta.js";
import type { Detail, InsightMeta, LearningSource, TruncatedField, WasteItem } from "./types.js";
import {
  OVERSIZED_RETURN_CHARS,
  type OversizedReturn,
  opportunitiesToWaste,
  oversizedReturnsToWaste,
  rankWaste,
} from "./waste.js";

/**
 * One subagent's turn-budget material — the minimum a session insight needs
 * to flag the long-implementer tail the study's A5/R4 lever is about
 * (`toolCallCount`), plus enough identity to name an outlier in fix text.
 * Kept separate from `OversizedReturn` (which is about return SIZE, a
 * different lever) so a caller can supply either, both, or neither.
 */
export interface InsightSubagent {
  agentId: string;
  /** Preferred display name (a workflow label), when the harness has one — else the caller falls back to `agentId`. */
  label?: string;
  model?: string;
  toolCallCount: number;
}

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
  /**
   * Per-subagent turn-budget material (Claude) — feeds `delegation.turnBudget`.
   * Kept pure: the server flattens its subagent forest into this before
   * calling, the same "declare only the fields I read" contract as everything
   * else here.
   */
  subagents?: InsightSubagent[];
  /**
   * Max effective request context over the session's context timeline, and how
   * many compactions fired — the two inputs to `contextLifetime`. Kept as plain
   * numbers (not the raw `contextTimeline`/`compactions` arrays) so the builder
   * stays pure over already-reduced figures, exactly like `totalCostUsd`.
   */
  ctxMaxTokens?: number;
  compactionCount?: number;
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
  /** Cost-share archetype (study §1) — see `SessionArchetype`. */
  archetype: SessionArchetype;
  /**
   * The main-loop cost share the archetype was computed from
   * (`delegation.main.costUsd / totalCostUsd`), 0-1, null when unpriced.
   * Exposed alongside `archetype` so the classification is auditable — a
   * `null` share means `archetype` fell back to `mixed` (can't be placed).
   */
  mainCostShare: number | null;
}

/**
 * Context-lifetime read — the study's single biggest lever (R1/A1). Both
 * inputs come in already reduced (`ctxMaxTokens` = the max over the session's
 * context timeline, `compactionCount` = how many compactions fired); `warning`
 * fires when the session ran past the 200K alarm with zero compactions to
 * relieve it (the never-compacted-marathon pattern the study found in every
 * corpus session).
 */
export interface ContextLifetime {
  ctxMaxTokens: number;
  compactionCount: number;
  warning: boolean;
}

/** One subagent that blew past the turn-budget outlier threshold — named for fix text. */
export interface TurnBudgetOutlier {
  agentId: string;
  label?: string;
  toolCallCount: number;
}

/**
 * Subagent turn-budget distribution (study A5/R4: "cacheRead scales with
 * TURNS, not token price"). `watch` counts subagents past the ~60-tool-call
 * budget; `outliers` names the ones past 150 ("treat >150 as a design
 * failure"), the material the fan-out recommendation's cap suggestion cites.
 */
export interface TurnBudget {
  /** Subagents with `toolCallCount` above the watch threshold (~60). */
  watch: number;
  /** Subagents past the outlier threshold (>150), worst-first. */
  outliers: TurnBudgetOutlier[];
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
  /** Subagent turn-budget distribution — see `TurnBudget` (study A5/R4). */
  turnBudget: TurnBudget;
  /**
   * Share (0-1) of subagent API messages that ran on an Opus-class model
   * (`isOpusClassModel`) — the study's R3/A4 tier lever. `null` when no
   * subagent message volume was recorded. Derived from
   * `delegation.byModel[].subagents.messageCount`, so it can't drift from the
   * delegation split it's read off.
   */
  opusMessageShare: number | null;
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
  /** Context-lifetime read (study R1/A1) — the biggest single cost lever. */
  contextLifetime: ContextLifetime;
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
  const mainCostShare = pct(input.delegation.main.costUsd, input.totalCostUsd);
  const archetype = classifyArchetype(mainCostShare);
  const sharePctText = share === null ? "unpriced" : `${Math.round(share * 100)}%`;
  const modelText = input.models.length > 0 ? input.models.join(", ") : "unknown model";
  return {
    headline: `$${input.totalCostUsd.toFixed(2)} across ${modelText}; ${sharePctText} of cost delegated to subagents (${archetype}).`,
    costUsd: input.totalCostUsd,
    costIsComplete: input.costIsComplete,
    models: input.models,
    delegationShare: share,
    archetype,
    mainCostShare,
  };
}

/** Share of subagent API messages on Opus-class models, from the per-model delegation split — null when no subagent messages were recorded. */
function opusMessageShareOf(delegation: DelegationSummary): number | null {
  let opus = 0;
  let total = 0;
  for (const m of delegation.byModel) {
    const messages = m.subagents.messageCount ?? 0;
    total += messages;
    if (isOpusClassModel(m.model)) opus += messages;
  }
  return total > 0 ? opus / total : null;
}

/** Turn-budget distribution: count of subagents past the watch bar (~60 tc), and the outliers (>150 tc), worst-first. */
function buildTurnBudget(subagents: readonly InsightSubagent[]): TurnBudget {
  const watch = subagents.filter((s) => s.toolCallCount > TURN_WATCH_THRESHOLD).length;
  const outliers = subagents
    .filter((s) => s.toolCallCount > TURN_OUTLIER_THRESHOLD)
    .sort((a, b) => b.toolCallCount - a.toolCallCount)
    .map((s) => ({
      agentId: s.agentId,
      ...(s.label !== undefined && { label: s.label }),
      toolCallCount: s.toolCallCount,
    }));
  return { watch, outliers };
}

function buildContextLifetime(input: SessionInsightInput): ContextLifetime {
  const ctxMaxTokens = input.ctxMaxTokens ?? 0;
  const compactionCount = input.compactionCount ?? 0;
  return {
    ctxMaxTokens,
    compactionCount,
    warning: isContextLifetimeWarning(ctxMaxTokens, compactionCount),
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
    turnBudget: buildTurnBudget(input.subagents ?? []),
    opusMessageShare: opusMessageShareOf(input.delegation),
  };
}

function sourceSessionsOf(input: SessionInsightInput): LearningSource[] {
  return [
    {
      source: input.source,
      sessionId: input.sessionId,
      ...(input.title !== undefined && { title: input.title }),
    },
  ];
}

/** Assemble a `Recommendation` (both the display fields and the `log_learning`-ready payload) from a finding/change/effect triple. */
function makeRecommendation(
  sourceSessions: LearningSource[],
  finding: string,
  change: string,
  expectedEffect?: string,
): Recommendation {
  return {
    finding,
    change,
    ...(expectedEffect !== undefined && { expectedEffect }),
    logLearningCall: {
      finding,
      change,
      ...(expectedEffect !== undefined && { expectedEffect }),
      sourceSessions,
    },
  };
}

/**
 * Archetype-lever recommendations (study §1) — the structural levers the raw
 * Bash/return waste can't surface: a never-compacted marathon (R1/A1) and a
 * fan-out with a turn-budget outlier (R4/A5). Prepended ahead of the
 * waste-derived recommendations because these are the higher-leverage
 * structural fixes; each carries the same `log_learning`-ready payload.
 */
function buildArchetypeRecommendations(
  input: SessionInsightInput,
  summary: SessionInsightSummary,
  contextLifetime: ContextLifetime,
  turnBudget: TurnBudget,
): Recommendation[] {
  const sourceSessions = sourceSessionsOf(input);
  const recs: Recommendation[] = [];

  if (summary.archetype === "marathon" && contextLifetime.warning) {
    const sharePct =
      summary.mainCostShare === null
        ? "the majority"
        : `${Math.round(summary.mainCostShare * 100)}%`;
    recs.push(
      makeRecommendation(
        sourceSessions,
        `Marathon session — ${sharePct} of cost on the main loop, which ran to ${contextLifetime.ctxMaxTokens.toLocaleString()} context tokens with 0 compactions.`,
        "Split multi-PR work into one session per PR and compact once per PR; alarm above 200K context.",
        "Cap the orchestrator's context lifetime (R1) — the study's single biggest cost lever.",
      ),
    );
  }

  if (summary.archetype === "fan-out" && turnBudget.outliers.length > 0) {
    const worst = turnBudget.outliers[0];
    const worstLabel = worst?.label ?? worst?.agentId ?? "a subagent";
    recs.push(
      makeRecommendation(
        sourceSessions,
        `Fan-out session with ${turnBudget.outliers.length} subagent(s) past 150 tool calls (worst: ${worstLabel} at ${worst?.toolCallCount ?? 0}).`,
        "Cap subagent turn budgets at ~60 tool calls in every spawn prompt; treat >150 as a design failure to revisit.",
        "Bound the subagent turn tail (R4) — cacheRead scales with turns, not token price.",
      ),
    );
  }

  return recs;
}

/** Turn each top waste finding into a `log_learning`-ready recommendation. */
function buildWasteRecommendations(
  input: SessionInsightInput,
  rankedWaste: readonly WasteItem[],
): Recommendation[] {
  const sourceSessions = sourceSessionsOf(input);
  return rankedWaste.map((w) => {
    const expectedEffect =
      w.impactUsd !== undefined
        ? `Save ~$${w.impactUsd.toFixed(2)} of avoidable spend.`
        : undefined;
    const rec = makeRecommendation(sourceSessions, w.title, w.fix, expectedEffect);
    return w.impactUsd !== undefined ? { ...rec, impactUsd: w.impactUsd } : rec;
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
  const contextLifetime = buildContextLifetime(input);

  // Structural archetype levers rank ahead of the per-finding waste fixes:
  // splitting a never-compacted marathon or capping a runaway subagent is a
  // bigger lever than any single Bash/return finding.
  const allRecommendations = [
    ...buildArchetypeRecommendations(input, summary, contextLifetime, delegation.turnBudget),
    ...buildWasteRecommendations(input, allWaste),
  ];
  const recommendations = allRecommendations.slice(0, RECOMMENDATION_LIMIT);

  const truncatedFields: TruncatedField[] = [];
  if (waste.length < allWaste.length) {
    truncatedFields.push({ path: "waste", shown: waste.length, total: allWaste.length });
  }
  if (costDrivers.length < input.byThread.length) {
    truncatedFields.push({
      path: "costDrivers",
      shown: costDrivers.length,
      total: input.byThread.length,
    });
  }
  if (recommendations.length < allRecommendations.length) {
    truncatedFields.push({
      path: "recommendations",
      shown: recommendations.length,
      total: allRecommendations.length,
    });
  }

  const payload: Omit<SessionInsight, "_meta"> = {
    sessionId: input.sessionId,
    source: input.source,
    summary,
    costDrivers,
    waste,
    delegation,
    contextLifetime,
    recommendations,
    ...(input.notAvailable !== undefined &&
      input.notAvailable.length > 0 && {
        notAvailable: input.notAvailable,
      }),
  };

  return {
    ...payload,
    _meta: buildMeta(payload, {
      ...(truncatedFields.length > 0 && { truncatedFields }),
      nextSteps: sessionInsightNextSteps(allWaste),
    }),
  };
}
