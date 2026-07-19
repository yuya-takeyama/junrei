/**
 * `buildWhatIf` — deterministic what-if cost simulator. Turns the study's two
 * cheapest open verification questions (docs/cost-playbook.md D1 & D5) into a
 * pure, re-runnable computation over a session's already-loaded context series:
 *
 *  - **D1 "compaction policy"** (`compaction-policy`): would compacting once
 *    whenever context crosses a threshold have halved the tail? We reset the
 *    counterfactual context to a baseline whenever it would exceed `T` and
 *    reprice the whole session's input side.
 *  - **D5 "evict heavy results"** (`evict-heavy-results`): would dropping the
 *    largest tool results a few turns after they appeared (verify-then-evict,
 *    R8/B4) have saved the re-read cost? We subtract each heavy result's token
 *    share from the context series after its eviction turn and reprice.
 *
 * HONESTY CONTRACT (mirrors the codebase's `costIsComplete`/`estUsd?`
 * conventions): every result is a MODEL-BASED COUNTERFACTUAL, not a billed
 * amount. Each carries `basis: "counterfactual-model"` and an `assumptions[]`
 * list stating the approximation, a DETERMINISTIC `estSavedTokens` (no pricing
 * dependency — exact), and a PRICED projection (`estSavedUsd`/
 * `baselineModelCostUsd`) that is present only when the model priced and marked
 * with `pricingComplete`. The two sides of every delta use the same
 * approximation (input-side context priced at the cache-read rate), so the
 * DELTA cancels most of the approximation error even though neither absolute is
 * the billed cost. A scenario whose inputs are missing is returned as a
 * `skipped` entry with a `reason`, never silently dropped.
 *
 * The cost model, stated explicitly:
 *   perMessageCost(ctx, model) = ctx * cacheReadRatePerToken(model, ctx)
 *   sessionCost               = Σ over messages perMessageCost(ctx_i, model_i)
 *   estSavedUsd               = sessionCost(real series) − sessionCost(cf series)
 * Approximations: (1) input-side only — output tokens and cache WRITES are
 * ignored (the study found cost mostly accrues as turns × context re-read);
 * (2) each message priced at the cache-read tier its OWN context size selects
 * (so a compaction that drops a request below the 200k tier is rewarded);
 * (3) per-message model attribution isn't on the context timeline, so points
 * without a model are priced at the caller's `fallbackModel` (the session's
 * dominant model) — accurate for single-model sessions, approximate across a
 * mid-session model switch.
 */
import { cacheReadRatePerToken } from "../shared/pricing/pricing.js";

/** One message on the context series — the effective request context and (where derivable) its model + source line. */
export interface WhatIfTimelinePoint {
  /** input + cache_read + cache_creation at this message (`ContextPoint.contextTokens`). */
  contextTokens: number;
  /** Owning model, when derivable; else the builder's `fallbackModel` prices this point. */
  model?: string;
  /** 1-based source line — anchors where a heavy result appeared on the series (scenario 2). */
  line?: number;
}

/** One heavy tool result eligible for eviction — its size and where on the transcript it was produced. */
export interface WhatIfHeavyResult {
  /** Stable identifier for display (e.g. a tool-use id). */
  id: string;
  /** Tool name, when known (e.g. `"Bash"`, `"Read"`). */
  tool?: string;
  /** Captured result size in characters. */
  resultChars: number;
  /** 1-based source line where the result was produced — mapped onto the context series. */
  line: number;
}

export interface WhatIfInput {
  /** The per-message context series, in transcript order. */
  timeline: readonly WhatIfTimelinePoint[];
  /** Prices any point whose own model is unknown — the session's dominant model. */
  fallbackModel?: string;
  /** Candidate heavy results for the eviction scenario (filtered by `heavyResultMinChars`). */
  heavyResults?: readonly WhatIfHeavyResult[];
  /** Context threshold that triggers a counterfactual compaction (tokens). Default 200_000. */
  compactionThresholdTokens?: number;
  /**
   * Baseline the counterfactual context resets to on a compaction (tokens).
   * Default: the context right after the session's first user turn (system +
   * tools + first prompt), i.e. `timeline[0].contextTokens` — a compaction can
   * never shed the immutable system/tools prefix, so that first request is the
   * honest floor a reset returns to.
   */
  compactionBaselineTokens?: number;
  /** Turns after a heavy result appears before it's assumed evicted (verify-then-evict). Default 3. */
  evictAfterTurns?: number;
  /** Only results larger than this (chars) are considered heavy. Default 100_000. */
  heavyResultMinChars?: number;
}

export type WhatIfBasis = "counterfactual-model";
export type WhatIfScenarioName = "compaction-policy" | "evict-heavy-results";

/** Fields every computed scenario carries (the honesty contract's shared shape). */
export interface WhatIfScenarioBase {
  scenario: WhatIfScenarioName;
  basis: WhatIfBasis;
  /** Deterministic token-side saving (Σ removed context tokens across messages) — exact, no pricing dependency. */
  estSavedTokens: number;
  /** Priced projection of the saving at cache-read rates; undefined when nothing could be priced. */
  estSavedUsd?: number;
  /** The real-series priced baseline the pct is against; undefined when unpriced. */
  baselineModelCostUsd?: number;
  /** `estSavedTokens / totalRealTokens`, 0-1; null when the real series had no tokens. Token-based (deterministic); equals the USD pct under a uniform pricing tier. */
  estSavedPct: number | null;
  /** False when some point couldn't be priced (unknown model) — same meaning as `costIsComplete`. */
  pricingComplete: boolean;
  /** Human-readable statements of the approximations behind this result. */
  assumptions: string[];
}

export interface WhatIfCompaction extends WhatIfScenarioBase {
  scenario: "compaction-policy";
  thresholdTokens: number;
  baselineTokens: number;
  /** How many counterfactual compactions the policy fired. */
  resetCount: number;
}

/** Per-result eviction saving (an independent single-eviction marginal). */
export interface WhatIfEvictedResult {
  id: string;
  tool?: string;
  line: number;
  resultChars: number;
  /** `ceil(resultChars / 4)` — the tokens this result occupied. */
  tokens: number;
  /** Number of context points from which this result was removed (turns held after the eviction turn). */
  turnsRemoved: number;
  estSavedTokens: number;
  estSavedUsd?: number;
}

export interface WhatIfEviction extends WhatIfScenarioBase {
  scenario: "evict-heavy-results";
  evictAfterTurns: number;
  minResultChars: number;
  /** Per-result savings, worst-first. Independent marginals — they sum to the total when eviction windows don't overlap into a context floor (the normal case). */
  results: WhatIfEvictedResult[];
}

/** A scenario that couldn't run — its inputs were missing. Carries a reason instead of a fabricated zero. */
export interface WhatIfSkipped {
  scenario: WhatIfScenarioName;
  skipped: true;
  reason: string;
}

export type WhatIfResult = WhatIfCompaction | WhatIfEviction | WhatIfSkipped;

const DEFAULT_THRESHOLD = 200_000;
const DEFAULT_EVICT_AFTER_TURNS = 3;
const DEFAULT_HEAVY_MIN_CHARS = 100_000;

/** `ceil(resultChars / 4)` — the same char→token estimate `tool-usage-stats.ts` uses (no real tokenizer). */
function tokensOf(resultChars: number): number {
  return Math.ceil(resultChars / 4);
}

/**
 * Price one message's context at its cache-read rate, tier chosen from that
 * message's own size (mirrors `estimateCostComponents`). Returns `undefined`
 * when the resolved model has no pricing — the caller then marks the scenario
 * partial rather than inventing a dollar figure.
 */
function priceMessage(contextTokens: number, model: string | undefined): number | undefined {
  if (model === undefined) return undefined;
  const rate = cacheReadRatePerToken(model, contextTokens);
  return rate === undefined ? undefined : contextTokens * rate;
}

/** The shared honesty-contract assumption every scenario carries. */
const BASIS_ASSUMPTION =
  "Model-based counterfactual, not a billed amount — input-side only (each message's context priced at its model's cache-read rate; output tokens and cache writes ignored). Compare deltas, not absolute dollars.";

/**
 * Assemble the priced/deterministic totals for a real vs. counterfactual
 * series. `cf[i]` is the counterfactual context at message `i` (already clamped
 * to a non-negative value by the caller — eviction floors at 0, compaction at
 * its baseline B ≥ 0, so `real − counter` is never a spurious over-credit). Both
 * sides price each message at the cache-read tier its
 * OWN size selects, so a message dropped below the 200k tier by the
 * counterfactual is repriced at the cheaper rate.
 */
function summarize(
  timeline: readonly WhatIfTimelinePoint[],
  cf: readonly number[],
  fallbackModel: string | undefined,
): {
  estSavedTokens: number;
  totalRealTokens: number;
  estSavedUsd?: number;
  baselineModelCostUsd?: number;
  pricingComplete: boolean;
} {
  let estSavedTokens = 0;
  let totalRealTokens = 0;
  let realCost = 0;
  let cfCost = 0;
  let pricingComplete = true;
  for (let i = 0; i < timeline.length; i++) {
    const point = timeline[i];
    if (point === undefined) continue;
    const real = point.contextTokens;
    const counter = cf[i] ?? real;
    totalRealTokens += real;
    estSavedTokens += real - counter;
    const model = point.model ?? fallbackModel;
    const realPriced = priceMessage(real, model);
    const cfPriced = priceMessage(counter, model);
    if (realPriced === undefined || cfPriced === undefined) {
      pricingComplete = false;
      continue;
    }
    realCost += realPriced;
    cfCost += cfPriced;
  }
  // A priced projection is only offered when EVERY point priced — a partial
  // baseline would understate savings against a full-session real cost.
  return pricingComplete
    ? {
        estSavedTokens,
        totalRealTokens,
        estSavedUsd: realCost - cfCost,
        baselineModelCostUsd: realCost,
        pricingComplete,
      }
    : { estSavedTokens, totalRealTokens, pricingComplete };
}

function pctOf(saved: number, total: number): number | null {
  return total > 0 ? saved / total : null;
}

/**
 * Scenario 1 — compaction policy. Walk the series; whenever the counterfactual
 * context would exceed `T`, compact it down to baseline `B` for that message
 * and every message after (tracked as a running `offset` subtracted from the
 * real series). See the module doc comment for the exact recurrence.
 */
function buildCompaction(input: WhatIfInput): WhatIfCompaction | WhatIfSkipped {
  const { timeline } = input;
  if (timeline.length === 0) {
    return {
      scenario: "compaction-policy",
      skipped: true,
      reason: "no context timeline to simulate a compaction policy over",
    };
  }
  const T = input.compactionThresholdTokens ?? DEFAULT_THRESHOLD;
  const B = input.compactionBaselineTokens ?? timeline[0]?.contextTokens ?? 0;

  const cf: number[] = [];
  let offset = 0;
  let resetCount = 0;
  for (const point of timeline) {
    const real = point.contextTokens;
    let counter = real - offset;
    // Sawtooth guard. The real `contextTimeline` is not monotonic: a REAL
    // compaction or heavy eviction drops the series sharply, and a permanent
    // additive `offset` (carried from an earlier counterfactual reset) then
    // drives `real − offset` deeply negative on the whole post-compaction tail —
    // summarize() would credit impossible (>100%) savings and price negative
    // context at negative USD. Physically the counterfactual can never hold less
    // than baseline B (the immutable system/tools prefix a reset returns to), so
    // when the real series falls to/below our counterfactual floor we resync the
    // offset to pin the counterfactual at `min(B, real)` — never negative, never
    // above real. On a monotone-increasing series this branch never fires, so
    // the exact recurrence (and every existing result) is unchanged.
    if (counter < B) {
      counter = Math.min(B, real);
      offset = real - counter;
    }
    if (counter > T) {
      // Compaction fires: reset context to the baseline for this and every
      // later message by growing the offset so `real − offset === B` here.
      offset = real - B;
      counter = B;
      resetCount += 1;
    }
    cf.push(counter);
  }

  const totals = summarize(timeline, cf, input.fallbackModel);
  const assumptions = [
    `Counterfactual compaction resets context to baseline B=${B.toLocaleString()} tokens (the context right after the first user turn: system + tools + first prompt) whenever it would exceed T=${T.toLocaleString()} tokens.`,
    BASIS_ASSUMPTION,
  ];
  if (!totals.pricingComplete) {
    assumptions.push(
      "Some messages had no priceable model — USD projection omitted; token saving is still exact.",
    );
  }
  return {
    scenario: "compaction-policy",
    basis: "counterfactual-model",
    thresholdTokens: T,
    baselineTokens: B,
    resetCount,
    estSavedTokens: totals.estSavedTokens,
    ...(totals.estSavedUsd !== undefined && { estSavedUsd: totals.estSavedUsd }),
    ...(totals.baselineModelCostUsd !== undefined && {
      baselineModelCostUsd: totals.baselineModelCostUsd,
    }),
    estSavedPct: pctOf(totals.estSavedTokens, totals.totalRealTokens),
    pricingComplete: totals.pricingComplete,
    assumptions,
  };
}

/** First timeline index whose source line is >= the result's line (where the result entered context); -1 when it appeared after the last measured point. */
function appearIndexOf(timeline: readonly WhatIfTimelinePoint[], line: number): number {
  for (let i = 0; i < timeline.length; i++) {
    const pLine = timeline[i]?.line;
    if (pLine !== undefined && pLine >= line) return i;
  }
  return -1;
}

/**
 * Scenario 2 — evict heavy results. Each result larger than `minResultChars`
 * is assumed to stop occupying context `N` turns after it appeared; its token
 * share is subtracted from every context point from that eviction turn onward.
 * Per-result savings are independent single-eviction marginals; the total is
 * the joint counterfactual (all evictions applied at once).
 */
function buildEviction(input: WhatIfInput): WhatIfEviction | WhatIfSkipped {
  const { timeline } = input;
  const N = input.evictAfterTurns ?? DEFAULT_EVICT_AFTER_TURNS;
  const minChars = input.heavyResultMinChars ?? DEFAULT_HEAVY_MIN_CHARS;
  if (timeline.length === 0) {
    return {
      scenario: "evict-heavy-results",
      skipped: true,
      reason: "no context timeline to place heavy results against",
    };
  }
  const heavy = (input.heavyResults ?? []).filter((r) => r.resultChars > minChars);
  if (heavy.length === 0) {
    return {
      scenario: "evict-heavy-results",
      skipped: true,
      reason: `no tool result larger than ${minChars.toLocaleString()} chars to evict`,
    };
  }

  // Per-result eviction turns; a result appearing after the last measured
  // point (appearIdx === -1) can't be placed, so it evicts nowhere.
  const perResult = heavy.map((r) => {
    const appearIdx = appearIndexOf(timeline, r.line);
    const evictIdx = appearIdx === -1 ? timeline.length : appearIdx + N;
    return { result: r, tokens: tokensOf(r.resultChars), evictIdx };
  });

  // Joint counterfactual: subtract every active eviction from each point.
  const combined: number[] = timeline.map((point, i) => {
    let removed = 0;
    for (const pr of perResult) if (i >= pr.evictIdx) removed += pr.tokens;
    return Math.max(0, point.contextTokens - removed);
  });
  const totals = summarize(timeline, combined, input.fallbackModel);

  // Per-result marginals: each computed as if it were the only eviction.
  const results: WhatIfEvictedResult[] = perResult
    .map((pr) => {
      const single = timeline.map((point, i) =>
        i >= pr.evictIdx ? Math.max(0, point.contextTokens - pr.tokens) : point.contextTokens,
      );
      const rt = summarize(timeline, single, input.fallbackModel);
      const turnsRemoved = Math.max(0, timeline.length - pr.evictIdx);
      return {
        id: pr.result.id,
        ...(pr.result.tool !== undefined && { tool: pr.result.tool }),
        line: pr.result.line,
        resultChars: pr.result.resultChars,
        tokens: pr.tokens,
        turnsRemoved,
        estSavedTokens: rt.estSavedTokens,
        ...(rt.estSavedUsd !== undefined && { estSavedUsd: rt.estSavedUsd }),
      };
    })
    .sort((a, b) => b.estSavedTokens - a.estSavedTokens);

  const assumptions = [
    `Each heavy tool result (> ${minChars.toLocaleString()} chars) is assumed to stop occupying context ${String(N)} turns after it appeared (verify-then-evict, R8/B4).`,
    "A result's context position is located by its source line on the timeline — precision is one context point.",
    BASIS_ASSUMPTION,
  ];
  if (!totals.pricingComplete) {
    assumptions.push(
      "Some messages had no priceable model — USD projection omitted; token saving is still exact.",
    );
  }
  return {
    scenario: "evict-heavy-results",
    basis: "counterfactual-model",
    evictAfterTurns: N,
    minResultChars: minChars,
    results,
    estSavedTokens: totals.estSavedTokens,
    ...(totals.estSavedUsd !== undefined && { estSavedUsd: totals.estSavedUsd }),
    ...(totals.baselineModelCostUsd !== undefined && {
      baselineModelCostUsd: totals.baselineModelCostUsd,
    }),
    estSavedPct: pctOf(totals.estSavedTokens, totals.totalRealTokens),
    pricingComplete: totals.pricingComplete,
    assumptions,
  };
}

/**
 * Build both what-if scenarios from a session's context series (D1 & D5). Pure
 * — no I/O, no transcript re-read. A scenario whose inputs are missing comes
 * back as a `WhatIfSkipped` entry (with a reason), so the array always has one
 * entry per scenario and a caller can render every scenario's state honestly.
 */
export function buildWhatIf(input: WhatIfInput): WhatIfResult[] {
  return [buildCompaction(input), buildEviction(input)];
}
