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

// Bedrock-style ids prefix the plain model id with an optional region
// (`us.`, `eu.`, `apac.`, `global.`) followed by `anthropic.`, e.g.
// `us.anthropic.claude-sonnet-4-5-20250929-v1:0`. Bedrock also uses
// non-regional ids (bare `anthropic.` with no region), hence the region
// group being optional.
const BEDROCK_ID_PREFIX = /^(?:us\.|eu\.|apac\.|global\.)?anthropic\.(.+)$/;
// Bedrock model ids carry a trailing revision suffix like `-v1:0` or `-v2:1`
// that has no counterpart in prices.json's plain model-id keys.
const BEDROCK_VERSION_SUFFIX = /-v\d+:\d+$/;

/**
 * Normalize a Bedrock-style model id (`(region.)?anthropic.<id>[-v<N>:<M>]`)
 * down to the plain id used as a prices.json key. Ids that don't start with
 * the Bedrock `anthropic.` prefix are returned unchanged.
 */
function normalizeBedrockModelId(model: string): string {
  const match = model.match(BEDROCK_ID_PREFIX);
  const captured = match?.[1];
  if (captured === undefined) return model;
  return captured.replace(BEDROCK_VERSION_SUFFIX, "");
}

/**
 * Find pricing for a model id. Lookup order:
 * 0. normalize a Bedrock-style id (region/anthropic prefix + `-v<N>:<M>`
 *    suffix stripped) down to the plain id — a no-op for non-Bedrock ids,
 * 1. exact match,
 * 2. exact match after stripping a trailing `-YYYYMMDD` date suffix,
 * 3. longest snapshot key that prefixes the model id (date/revision variants).
 */
export function findModelPricing(model: string): ModelPricing | undefined {
  const models = snapshot.models;
  const normalized = normalizeBedrockModelId(model);

  const exact = models[normalized];
  if (exact !== undefined) return exact;

  const dateless = normalized.replace(/-\d{8}$/, "");
  const datelessHit = models[dateless];
  if (datelessHit !== undefined) return datelessHit;

  let best: { key: string; pricing: ModelPricing } | undefined;
  for (const [key, pricing] of Object.entries(models)) {
    if (normalized.startsWith(key) && (best === undefined || key.length > best.key.length)) {
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
  // Zero tokens cost exactly $0 no matter what — even for a model with no
  // pricing entry (e.g. Claude Code's "<synthetic>" harness stub messages,
  // which carry no real usage). Short-circuit before the pricing lookup so
  // callers see a priced, exact $0 instead of "unpriced" and don't flip
  // costIsComplete false over a cost that provably doesn't exist.
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheCreationTokens === 0
  ) {
    return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 0 };
  }

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
