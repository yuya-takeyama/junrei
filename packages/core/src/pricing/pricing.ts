import type { TokenUsage } from "../types.js";
import pricesJson from "./prices.json" with { type: "json" };

export interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

interface PricingSnapshot {
  source: string;
  fetchedAt: string;
  models: Record<string, ModelPricing>;
}

const snapshot = pricesJson as PricingSnapshot;

const TIER_THRESHOLD = 200_000;

/**
 * Find pricing for a model id. Lookup order:
 * 1. exact match,
 * 2. exact match after stripping a trailing `-YYYYMMDD` date suffix,
 * 3. longest snapshot key that prefixes the model id (date/revision variants).
 */
export function findModelPricing(model: string): ModelPricing | undefined {
  const models = snapshot.models;
  const exact = models[model];
  if (exact !== undefined) return exact;

  const dateless = model.replace(/-\d{8}$/, "");
  const datelessHit = models[dateless];
  if (datelessHit !== undefined) return datelessHit;

  let best: { key: string; pricing: ModelPricing } | undefined;
  for (const [key, pricing] of Object.entries(models)) {
    if (model.startsWith(key) && (best === undefined || key.length > best.key.length)) {
      best = { key, pricing };
    }
  }
  return best?.pricing;
}

export interface CostComponents {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  /** The cache-creation ("cache write") portion — billed at 1.25x the input rate by default. */
  cacheCreationCost: number;
  totalCost: number;
}

/**
 * Break one API message's usage down into its rate components instead of
 * just the summed total — lets callers surface e.g. "cache-write cost"
 * without re-deriving the tiered-rate formula. `estimateCostUsd` is a thin
 * wrapper over this that keeps returning just the total (byte-identical to
 * before this was split out).
 *
 * Anthropic bills long-context requests (>200k input incl. cache) at the
 * `above_200k` tier for the entire request, so the tier is chosen from the
 * request's total input-side tokens.
 *
 * Cache-creation: 5m tokens use the standard cache-write rate; 1h tokens use
 * the dedicated 1h rate when known, otherwise 2x input rate (Anthropic's
 * documented multiplier). Without a 5m/1h breakdown the flat total is billed
 * at the 5m rate.
 */
export function estimateCostComponents(
  model: string,
  usage: TokenUsage,
): CostComponents | undefined {
  const pricing = findModelPricing(model);
  if (pricing?.input_cost_per_token === undefined || pricing.output_cost_per_token === undefined) {
    return undefined;
  }

  const contextTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const above = contextTokens > TIER_THRESHOLD;

  const inputRate =
    (above ? pricing.input_cost_per_token_above_200k_tokens : undefined) ??
    pricing.input_cost_per_token;
  const outputRate =
    (above ? pricing.output_cost_per_token_above_200k_tokens : undefined) ??
    pricing.output_cost_per_token;
  const cacheReadRate =
    (above ? pricing.cache_read_input_token_cost_above_200k_tokens : undefined) ??
    pricing.cache_read_input_token_cost ??
    pricing.input_cost_per_token * 0.1;
  const cacheCreateRate =
    (above ? pricing.cache_creation_input_token_cost_above_200k_tokens : undefined) ??
    pricing.cache_creation_input_token_cost ??
    pricing.input_cost_per_token * 1.25;
  const cacheCreate1hRate =
    pricing.cache_creation_input_token_cost_above_1hr ?? pricing.input_cost_per_token * 2;

  let cacheCreationCost: number;
  if (usage.cacheCreation5mTokens !== undefined || usage.cacheCreation1hTokens !== undefined) {
    cacheCreationCost =
      (usage.cacheCreation5mTokens ?? 0) * cacheCreateRate +
      (usage.cacheCreation1hTokens ?? 0) * cacheCreate1hRate;
  } else {
    cacheCreationCost = usage.cacheCreationTokens * cacheCreateRate;
  }

  const inputCost = usage.inputTokens * inputRate;
  const outputCost = usage.outputTokens * outputRate;
  const cacheReadCost = usage.cacheReadTokens * cacheReadRate;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheCreationCost,
  };
}

/** Estimate total USD cost for one API message's usage. See `estimateCostComponents`. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  return estimateCostComponents(model, usage)?.totalCost;
}

export function pricingSnapshotInfo(): { source: string; fetchedAt: string; modelCount: number } {
  return {
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    modelCount: Object.keys(snapshot.models).length,
  };
}
