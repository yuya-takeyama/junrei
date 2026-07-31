import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../types.js";
import pricesJson from "./prices.json" with { type: "json" };
import {
  cacheReadRatePerToken,
  estimateCostComponents,
  estimateCostUsd,
  findModelPricing,
  type PricingHistoryEntry,
  selectPricingEntry,
} from "./pricing.js";

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

  it("returns an exact $0 for an unpriced model when usage is entirely zero tokens", () => {
    // Zero tokens cost $0 regardless of pricing availability — e.g. Claude
    // Code's "<synthetic>" harness stub messages, which carry no real usage
    // and have no pricing entry. This must NOT be treated the same as a
    // genuinely unpriced/unknown-cost model (previous test).
    const zeroUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(estimateCostComponents("<synthetic>", zeroUsage)).toEqual({
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheCreationCost: 0,
      totalCost: 0,
    });
    expect(estimateCostUsd("<synthetic>", zeroUsage)).toBe(0);
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

describe("findModelPricing (OpenAI Codex model ids)", () => {
  it("resolves gpt-5.5 to its own exact-match entry, not a prefix match", () => {
    const pricing = findModelPricing("gpt-5.5");
    expect(pricing).toBeDefined();
    // gpt-5.5 has real, distinct pricing upstream — this is not "gpt-5"'s rate.
    expect(pricing?.input_cost_per_token).not.toBe(findModelPricing("gpt-5")?.input_cost_per_token);
  });

  it("resolves gpt-5.3-codex to its own entry, not accidentally prefix-matching plain gpt-5", () => {
    const gpt5 = findModelPricing("gpt-5");
    const codex53 = findModelPricing("gpt-5.3-codex");
    expect(codex53).toBeDefined();
    expect(gpt5).toBeDefined();
    // "gpt-5" is a prefix of "gpt-5.3-codex", so this asserts the longest-key /
    // exact-match resolution didn't fall through to gpt-5's (different) rates.
    expect(codex53?.input_cost_per_token).not.toBe(gpt5?.input_cost_per_token);
    expect(codex53?.output_cost_per_token).not.toBe(gpt5?.output_cost_per_token);
  });

  it("resolves the near-family ids used by real Codex sessions", () => {
    for (const model of ["gpt-5-codex", "gpt-5.1", "gpt-5-mini", "gpt-5.2-codex"]) {
      const pricing = findModelPricing(model);
      expect(pricing, `expected pricing for ${model}`).toBeDefined();
      expect(pricing?.input_cost_per_token).toBeGreaterThan(0);
      expect(pricing?.output_cost_per_token).toBeGreaterThan(0);
    }
  });

  it("prices codex-auto-review (Codex's auto-review turns) at gpt-5.4 rates", () => {
    // Codex rollouts stamp `turn_context.model: "codex-auto-review"` on
    // auto-review ("guardian") turns. LiteLLM has no key for that slug, so
    // update-pricing.mjs aliases it to gpt-5.4 — the model OpenAI documents
    // the feature as running (https://alignment.openai.com/auto-review/) and
    // bills API-key usage under. Without this entry those turns silently
    // summed as $0.00 with costIsComplete=false.
    const pricing = findModelPricing("codex-auto-review");
    expect(pricing).toBeDefined();
    expect(pricing).toEqual(findModelPricing("gpt-5.4"));
    expect(estimateCostUsd("codex-auto-review", USAGE)).toBeGreaterThan(0);
  });
});

describe("findModelPricing (Claude Opus 5)", () => {
  it("resolves claude-opus-5 at the official Opus-tier rates", () => {
    const pricing = findModelPricing("claude-opus-5");
    expect(pricing).toBeDefined();
    // Anthropic pricing page: $5 in / $25 out per MTok, cache write $6.25 (5m)
    // / $10 (1h), cache read $0.50 — same rates as Opus 4.8.
    expect(pricing?.input_cost_per_token).toBe(0.000005);
    expect(pricing?.output_cost_per_token).toBe(0.000025);
    expect(pricing?.cache_creation_input_token_cost).toBe(0.00000625);
    expect(pricing?.cache_read_input_token_cost).toBe(5e-7);
    expect(pricing?.cache_creation_input_token_cost_above_1hr).toBe(0.00001);
    expect(estimateCostUsd("claude-opus-5", USAGE)).toBeGreaterThan(0);
  });

  it("resolves Bedrock-style Opus 5 ids to the same entry", () => {
    expect(findModelPricing("us.anthropic.claude-opus-5")).toEqual(
      findModelPricing("claude-opus-5"),
    );
    expect(findModelPricing("global.anthropic.claude-opus-5-v1:0")).toEqual(
      findModelPricing("claude-opus-5"),
    );
  });
});

describe("findModelPricing (Bedrock-style Claude model ids)", () => {
  it.each([
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929"],
    ["eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929"],
    ["apac.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929"],
    ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929"],
    // Bedrock also uses non-regional ids: bare `anthropic.` with no region prefix.
    ["anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001"],
    // A different revision suffix shape (`-v2:1`) should strip the same way.
    ["us.anthropic.claude-haiku-4-5-20251001-v2:1", "claude-haiku-4-5-20251001"],
  ])("normalizes %s to the same pricing as %s", (bedrockId, plainId) => {
    const pricing = findModelPricing(bedrockId);
    expect(pricing).toBeDefined();
    expect(pricing).toEqual(findModelPricing(plainId));
  });

  it("combines Bedrock normalization with dateless stripping (pipeline step 2)", () => {
    // `20301231` is not a real snapshot date for claude-sonnet-4-5, so after
    // stripping the region/anthropic prefix and the `-v1:0` suffix, the
    // normalized id only resolves via the existing dateless-stripping step
    // (falling back to the bare "claude-sonnet-4-5" entry).
    const pricing = findModelPricing("us.anthropic.claude-sonnet-4-5-20301231-v1:0");
    expect(pricing).toBeDefined();
    expect(pricing).toEqual(findModelPricing("claude-sonnet-4-5"));
  });

  it("combines Bedrock normalization with longest-prefix matching (pipeline step 3)", () => {
    // Appending a non-numeric suffix after the date defeats the dateless
    // regex (which only strips a trailing 8-digit date), so this must fall
    // through to the longest-prefix step to resolve to the dated entry.
    const pricing = findModelPricing("us.anthropic.claude-opus-4-1-20250805-customvariant-v1:0");
    expect(pricing).toBeDefined();
    expect(pricing).toEqual(findModelPricing("claude-opus-4-1-20250805"));
  });

  it("leaves plain Claude ids and gpt ids unaffected (no regression)", () => {
    expect(findModelPricing("claude-sonnet-4-5-20250929")).toEqual(
      findModelPricing("claude-sonnet-4-5-20250929"),
    );
    expect(findModelPricing("claude-sonnet-4-5")).toBeDefined();
    expect(findModelPricing("gpt-5.4")).toBeDefined();
  });

  it("still returns undefined for an unknown model", () => {
    expect(findModelPricing("totally-unknown-model-xyz")).toBeUndefined();
  });

  it("does not mangle an id with 'anthropic' in the middle rather than as a prefix", () => {
    // Neither of these starts with an (region.)?anthropic. prefix, so the
    // Bedrock normalization must be a no-op and both must resolve exactly as
    // the unmodified pipeline would (i.e. undefined — these aren't real keys).
    expect(findModelPricing("claude-anthropic-experimental-4-5")).toBeUndefined();
    expect(findModelPricing("not.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBeUndefined();
  });
});

describe("selectPricingEntry", () => {
  const HISTORY: PricingHistoryEntry[] = [
    {
      valid_from: null,
      fetched_at: "2026-01-01T00:00:00.000Z",
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    },
    {
      valid_from: "2026-03-01",
      fetched_at: "2026-03-02T00:00:00.000Z",
      input_cost_per_token: 3e-6,
      output_cost_per_token: 4e-6,
    },
    {
      valid_from: "2026-06-01",
      fetched_at: "2026-06-02T00:00:00.000Z",
      input_cost_per_token: 5e-6,
      output_cost_per_token: 6e-6,
    },
  ];

  it("returns the latest entry when no timestamp is given", () => {
    expect(selectPricingEntry(HISTORY)?.input_cost_per_token).toBe(5e-6);
  });

  it("returns the null entry for a timestamp before every dated entry", () => {
    expect(selectPricingEntry(HISTORY, "2026-02-15T12:00:00.000Z")?.input_cost_per_token).toBe(
      1e-6,
    );
  });

  it("applies a dated entry from 00:00:00Z on its valid_from day (inclusive boundary)", () => {
    expect(selectPricingEntry(HISTORY, "2026-03-01T00:00:00.000Z")?.input_cost_per_token).toBe(
      3e-6,
    );
    expect(selectPricingEntry(HISTORY, "2026-02-28T23:59:59.999Z")?.input_cost_per_token).toBe(
      1e-6,
    );
  });

  it("picks the greatest applicable valid_from between entries", () => {
    expect(selectPricingEntry(HISTORY, "2026-04-10T09:00:00.000Z")?.input_cost_per_token).toBe(
      3e-6,
    );
  });

  it("uses the last entry for timestamps after every valid_from", () => {
    expect(selectPricingEntry(HISTORY, "2027-01-01T00:00:00.000Z")?.input_cost_per_token).toBe(
      5e-6,
    );
  });

  it("is order-independent — an unsorted history gives identical answers", () => {
    const shuffled = [HISTORY[2], HISTORY[0], HISTORY[1]] as PricingHistoryEntry[];
    expect(selectPricingEntry(shuffled, "2026-04-10T00:00:00.000Z")?.input_cost_per_token).toBe(
      3e-6,
    );
    expect(selectPricingEntry(shuffled)?.input_cost_per_token).toBe(5e-6);
  });

  it("returns undefined for an empty history", () => {
    expect(selectPricingEntry([])).toBeUndefined();
  });
});

describe("findModelPricing (GPT-5.6 Luna/Terra price cut, effective 2026-07-30)", () => {
  it("prices Luna at the old rates for messages before 2026-07-30", () => {
    const pricing = findModelPricing("gpt-5.6-luna", "2026-07-29T23:59:59.000Z");
    expect(pricing?.input_cost_per_token).toBe(0.000001);
    expect(pricing?.output_cost_per_token).toBe(0.000006);
  });

  it("prices Luna at the cut rates from 2026-07-30T00:00:00Z", () => {
    const pricing = findModelPricing("gpt-5.6-luna", "2026-07-30T00:00:00.000Z");
    expect(pricing?.input_cost_per_token).toBe(2e-7);
    expect(pricing?.output_cost_per_token).toBe(0.0000012);
    // Cache rates were NOT in the announcement — carried over from the prior
    // entry until LiteLLM publishes real post-cut values (see the spec).
    expect(pricing?.cache_creation_input_token_cost).toBe(0.00000125);
    expect(pricing?.cache_read_input_token_cost).toBe(1e-7);
  });

  it("prices Terra at old/new rates across the boundary", () => {
    expect(
      findModelPricing("gpt-5.6-terra", "2026-07-01T00:00:00.000Z")?.input_cost_per_token,
    ).toBe(0.0000025);
    const after = findModelPricing("gpt-5.6-terra", "2026-07-31T00:00:00.000Z");
    expect(after?.input_cost_per_token).toBe(0.000002);
    expect(after?.output_cost_per_token).toBe(0.000012);
  });

  it("uses the newest rates when no timestamp is given (undated callers)", () => {
    // "No timestamp" must mean "the newest entry" — pinned against a far-future
    // dated lookup instead of a literal rate so future appended entries don't
    // turn this test into a moving target.
    expect(findModelPricing("gpt-5.6-luna")).toEqual(
      findModelPricing("gpt-5.6-luna", "2099-01-01T00:00:00.000Z"),
    );
  });

  it("estimateCostUsd reflects the boundary end-to-end", () => {
    // USAGE = 1000 in / 500 out / 2000 cacheRead / 300 cacheCreate.
    // Old: 1000*1e-6 + 500*6e-6 + 2000*1e-7 + 300*1.25e-6 = 0.004575
    // New: 1000*2e-7 + 500*1.2e-6 + 2000*1e-7 + 300*1.25e-6 = 0.001375
    expect(estimateCostUsd("gpt-5.6-luna", USAGE, "2026-07-01T00:00:00.000Z")).toBeCloseTo(
      0.004575,
      10,
    );
    expect(estimateCostUsd("gpt-5.6-luna", USAGE, "2026-07-31T00:00:00.000Z")).toBeCloseTo(
      0.001375,
      10,
    );
  });

  it("Sol and base gpt-5.6 are unchanged by the cut (still one entry)", () => {
    expect(findModelPricing("gpt-5.6-sol", "2026-07-01T00:00:00.000Z")).toEqual(
      findModelPricing("gpt-5.6-sol", "2026-07-31T00:00:00.000Z"),
    );
  });

  it("cacheReadRatePerToken accepts a timestamp (equal values today — cache rates carried over)", () => {
    expect(cacheReadRatePerToken("gpt-5.6-luna", 1000, "2026-07-01T00:00:00.000Z")).toBe(1e-7);
    expect(cacheReadRatePerToken("gpt-5.6-luna", 1000, "2026-07-31T00:00:00.000Z")).toBe(1e-7);
  });
});

describe("prices.json structural invariants", () => {
  // The file is now machine-edited (daily sync appends); these invariants are
  // what selectPricingEntry and the migration rely on. A history that lost its
  // null entry would silently render pre-first-date sessions as unpriced.
  const snapshot = pricesJson as unknown as {
    source: string;
    models: Record<string, PricingHistoryEntry[]>;
  };

  it("every model has a non-empty history with exactly one valid_from:null entry", () => {
    for (const [model, entries] of Object.entries(snapshot.models)) {
      expect(entries.length, model).toBeGreaterThan(0);
      expect(entries.filter((e) => e.valid_from === null).length, model).toBe(1);
    }
  });

  it("valid_from values are unique YYYY-MM-DD dates (or null) and every entry is priceable", () => {
    for (const [model, entries] of Object.entries(snapshot.models)) {
      const dated = entries.filter((e) => e.valid_from !== null);
      expect(new Set(dated.map((e) => e.valid_from)).size, model).toBe(dated.length);
      for (const entry of entries) {
        if (entry.valid_from !== null)
          expect(entry.valid_from, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof entry.fetched_at, model).toBe("string");
        expect(typeof entry.input_cost_per_token, model).toBe("number");
        expect(typeof entry.output_cost_per_token, model).toBe("number");
      }
    }
  });
});
