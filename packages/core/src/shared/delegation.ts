import type { ModelUsageSummary, TokenTotals, UsageSummary } from "./metrics.js";

/**
 * One scope's (main thread, or every subagent combined) share of a metric —
 * both the raw token volume and, when priced, the dollar cost. Deliberately
 * numbers only, no grades or judgments (project principle): this is the raw
 * material for a "was work delegated off the expensive model?" read, not a
 * verdict on whether it should have been.
 */
export interface DelegationScopeSlice {
  tokens: number;
  outputTokens: number;
  /** undefined only when this scope's usage includes a model with no known pricing. */
  costUsd?: number;
  messageCount?: number;
}

/** One model's main-vs-subagents split — see `DelegationSummary.byModel`. */
export interface DelegationModelSlice {
  model: string;
  main: DelegationScopeSlice;
  subagents: DelegationScopeSlice;
}

/**
 * First-class delegation split: how much of a session's volume (tokens) and
 * spend (cost) ran on the main thread vs. was pushed off to subagents,
 * overall and per model. `main` and `subagents` always reconstruct the
 * session totals for every field — `subagents` is `total − main` throughout,
 * there's no independently-measured "subagent-only" input.
 *
 * This is the fix for the mental math the Overview/Orchestration lenses used
 * to require: a session can spend most of its DOLLARS on the orchestrator
 * while most of its TOKENS ran on cheap delegated models (or vice versa) —
 * `main.costUsd` vs `main.tokens` (as shares of the session total) makes that
 * inversion directly readable instead of requiring a second lens and mental
 * subtraction.
 */
export interface DelegationSummary {
  main: DelegationScopeSlice;
  subagents: DelegationScopeSlice;
  byModel: DelegationModelSlice[];
  costIsComplete: boolean;
}

/**
 * Total tokens moved through a request: input + output + cache-read +
 * cache-creation. This — not cost — is the volume measure used for
 * share-of-work throughout `DelegationSummary`, since cost weights by
 * (varying, sometimes unknown) model price while tokens count the actual
 * work moved between main and subagents.
 */
function tokensMoved(totals: TokenTotals): number {
  return (
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  );
}

/** Clamp a token-side subtraction's tiny negative rounding artifacts to 0 (never a real deficit). */
function clampNonNegative(value: number): number {
  return value < 0 ? 0 : value;
}

/**
 * Derive the first-class delegation summary from a session's already-computed
 * usage figures:
 *  - `main` — main-thread-only `UsageSummary` (`ClaudeSessionAnalysis.usage` /
 *    Codex's own-thread `usage`).
 *  - `total` — main + every subagent, recursively (`totalUsage`).
 *  - `totalByModel` — the same rollup, per model (`totalUsageByModel`).
 *
 * `subagents` is derived as `total − main` throughout — mirrors how
 * `totalUsage` itself is built (main transcript + subagent totals summed),
 * just inverted back into a delegated-only view.
 */
export function computeDelegationSummary(
  main: UsageSummary,
  total: TokenTotals & { costUsd: number; costIsComplete: boolean },
  totalByModel: readonly ModelUsageSummary[],
): DelegationSummary {
  const mainTokens = tokensMoved(main.total);
  const mainOutputTokens = main.total.outputTokens;
  const mainMessageCount = main.byModel.reduce((sum, m) => sum + m.messageCount, 0);
  const totalTokens = tokensMoved(total);
  const totalMessageCount = totalByModel.reduce((sum, m) => sum + m.messageCount, 0);

  const mainByModel = new Map(main.byModel.map((m) => [m.model, m]));
  const byModel: DelegationModelSlice[] = totalByModel.map((t) => {
    // Absent from `mainByModel` means this model never ran on the main
    // thread — that's a known, real 0, not "unpriced" (undefined).
    const m = mainByModel.get(t.model);
    const mTokens = m !== undefined ? tokensMoved(m) : 0;
    const mOutputTokens = m?.outputTokens ?? 0;
    const mMessageCount = m?.messageCount ?? 0;
    const mCost = m === undefined ? 0 : m.costUsd;
    const subCost = mCost !== undefined && t.costUsd !== undefined ? t.costUsd - mCost : undefined;

    // `exactOptionalPropertyTypes` means an undefined `costUsd` must be
    // omitted, not assigned — conditional spread rather than `costUsd: mCost`.
    return {
      model: t.model,
      main: {
        tokens: mTokens,
        outputTokens: mOutputTokens,
        messageCount: mMessageCount,
        ...(mCost !== undefined && { costUsd: mCost }),
      },
      subagents: {
        tokens: clampNonNegative(tokensMoved(t) - mTokens),
        outputTokens: clampNonNegative(t.outputTokens - mOutputTokens),
        messageCount: clampNonNegative(t.messageCount - mMessageCount),
        ...(subCost !== undefined && { costUsd: subCost }),
      },
    };
  });

  return {
    main: {
      tokens: mainTokens,
      outputTokens: mainOutputTokens,
      costUsd: main.total.costUsd,
      messageCount: mainMessageCount,
    },
    subagents: {
      tokens: clampNonNegative(totalTokens - mainTokens),
      outputTokens: clampNonNegative(total.outputTokens - mainOutputTokens),
      costUsd: total.costUsd - main.total.costUsd,
      messageCount: clampNonNegative(totalMessageCount - mainMessageCount),
    },
    byModel,
    costIsComplete: total.costIsComplete,
  };
}
