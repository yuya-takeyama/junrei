import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../types.js";
import { estimateCostComponents, estimateCostUsd } from "./pricing.js";

const USAGE: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 2000,
  cacheCreationTokens: 300,
};

describe("estimateCostComponents / estimateCostUsd", () => {
  it("estimateCostUsd's total is byte-identical to summing the components", () => {
    const components = estimateCostComponents("claude-fable-5", USAGE);
    expect(components).toBeDefined();
    const summed =
      (components?.inputCost ?? 0) +
      (components?.outputCost ?? 0) +
      (components?.cacheReadCost ?? 0) +
      (components?.cacheCreationCost ?? 0);
    // Exact equality (not toBeCloseTo): `estimateCostUsd` is now a thin
    // wrapper returning `estimateCostComponents(...)?.totalCost`, computed by
    // summing the same components in the same order — this is the "prove
    // estimateCostUsd is byte-identical to before the refactor" assertion.
    expect(estimateCostUsd("claude-fable-5", USAGE)).toBe(summed);
    expect(estimateCostUsd("claude-fable-5", USAGE)).toBe(components?.totalCost);
  });

  it("cacheCreationCost is the 1.25x-rate cache-write slice, less than the total", () => {
    const components = estimateCostComponents("claude-fable-5", USAGE);
    expect(components).toBeDefined();
    // prices.json: input 1e-5, cache_creation 1.25e-5 per token.
    expect(components?.cacheCreationCost).toBeCloseTo(300 * 1.25e-5, 10);
    expect(components?.cacheCreationCost).toBeLessThan(components?.totalCost ?? 0);
    expect(components?.cacheCreationCost).toBeGreaterThan(0);
  });

  it("returns undefined for both functions when the model has no known pricing", () => {
    expect(estimateCostComponents("totally-unknown-model-xyz", USAGE)).toBeUndefined();
    expect(estimateCostUsd("totally-unknown-model-xyz", USAGE)).toBeUndefined();
  });

  it("splits ephemeral 5m/1h cache-creation tokens at their respective rates", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 300,
      cacheCreation5mTokens: 200,
      cacheCreation1hTokens: 100,
    };
    const components = estimateCostComponents("claude-fable-5", usage);
    // prices.json: cache_creation_input_token_cost 1.25e-5, above_1hr 2e-5.
    expect(components?.cacheCreationCost).toBeCloseTo(200 * 1.25e-5 + 100 * 2e-5, 10);
  });
});
