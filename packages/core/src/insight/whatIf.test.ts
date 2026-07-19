import { describe, expect, it } from "vitest";
import {
  buildWhatIf,
  type WhatIfCompaction,
  type WhatIfEviction,
  type WhatIfSkipped,
  type WhatIfTimelinePoint,
} from "./whatIf.js";

// A model with a FLAT cache-read rate (no `above_200k` tier in prices.json) so
// the arithmetic below is hand-computable at any context size: every token is
// priced at exactly this rate regardless of the request's size.
const MODEL = "claude-opus-4-1-20250805";
const RATE = 1.5e-6; // claude-opus-4-1 cache_read_input_token_cost

function compaction(results: ReturnType<typeof buildWhatIf>): WhatIfCompaction {
  const s = results.find((r) => r.scenario === "compaction-policy");
  if (s === undefined || "skipped" in s || s.scenario !== "compaction-policy") {
    throw new Error("expected a computed compaction scenario");
  }
  return s;
}
function eviction(results: ReturnType<typeof buildWhatIf>): WhatIfEviction {
  const s = results.find((r) => r.scenario === "evict-heavy-results");
  if (s === undefined || "skipped" in s || s.scenario !== "evict-heavy-results") {
    throw new Error("expected a computed eviction scenario");
  }
  return s;
}
function skipped(results: ReturnType<typeof buildWhatIf>, scenario: string): WhatIfSkipped {
  const s = results.find((r) => r.scenario === scenario);
  if (s === undefined || !("skipped" in s)) throw new Error(`expected ${scenario} skipped`);
  return s;
}

describe("buildWhatIf — compaction policy (D1)", () => {
  it("flat series below threshold → zero savings, zero resets", () => {
    const timeline = [10, 20, 30].map((t) => ({ contextTokens: t, model: MODEL }));
    const c = compaction(buildWhatIf({ timeline }));
    expect(c.resetCount).toBe(0);
    expect(c.estSavedTokens).toBe(0);
    expect(c.estSavedUsd).toBeCloseTo(0, 12);
    expect(c.estSavedPct).toBe(0); // 0 saved / 60 total, not null
    expect(c.pricingComplete).toBe(true);
    expect(c.basis).toBe("counterfactual-model");
  });

  it("series crossing the threshold twice → exact delta and reset count", () => {
    // T=100, B=10. Real: [10,50,110,150,210,250]. CF resets at i2 and i4:
    // cf = [10,50,10,50,10,50] → saved tokens = 600, resets = 2.
    const timeline = [10, 50, 110, 150, 210, 250].map((t) => ({
      contextTokens: t,
      model: MODEL,
    }));
    const c = compaction(
      buildWhatIf({ timeline, compactionThresholdTokens: 100, compactionBaselineTokens: 10 }),
    );
    expect(c.resetCount).toBe(2);
    expect(c.estSavedTokens).toBe(600);
    expect(c.thresholdTokens).toBe(100);
    expect(c.baselineTokens).toBe(10);
    expect(c.estSavedUsd).toBeCloseTo(600 * RATE, 12);
    expect(c.baselineModelCostUsd).toBeCloseTo(780 * RATE, 12);
    expect(c.estSavedPct).toBeCloseTo(600 / 780, 12);
    expect(c.pricingComplete).toBe(true);
  });

  it("sawtooth series (real compaction in the tail) never over-credits savings", () => {
    // The real contextTimeline is NOT monotonic: it climbs past T then a REAL
    // compaction drops it sharply. With a naive additive offset, `real − offset`
    // goes negative on the whole post-compaction tail and the tool claims to save
    // MORE tokens than the session ever used (estSavedPct > 1). The sawtooth guard
    // pins the counterfactual at baseline B on the drop instead.
    // Real: [15000, 150000, 210000, 30000, 60000], default B = timeline[0] = 15000.
    //   i2: 210000 > 200000 → reset to B=15000 (offset 195000), saved 195000.
    //   i3: 30000 − 195000 < B → resync, counter = min(B, 30000) = 15000, saved 15000.
    //   i4: 60000 − 15000 = 45000 (≥ B, < T), saved 15000.
    const timeline = [15_000, 150_000, 210_000, 30_000, 60_000].map((t) => ({
      contextTokens: t,
      model: MODEL,
    }));
    const c = compaction(buildWhatIf({ timeline }));
    expect(c.resetCount).toBe(1);
    expect(c.baselineTokens).toBe(15_000);
    expect(c.estSavedTokens).toBe(225_000); // 195000 + 15000 + 15000, never negative
    const totalReal = 15_000 + 150_000 + 210_000 + 30_000 + 60_000; // 465000
    expect(c.estSavedPct).toBeCloseTo(225_000 / totalReal, 12);
    expect(c.estSavedPct).toBeGreaterThanOrEqual(0);
    expect(c.estSavedPct).toBeLessThanOrEqual(1); // documented 0–1 range holds
    expect(c.estSavedTokens).toBeLessThan(totalReal); // can't save more than ever used
    expect(c.estSavedUsd).toBeCloseTo(225_000 * RATE, 9); // priced positive, no negative tail
  });

  it("defaults the baseline to the context right after the first user turn", () => {
    // No baseline override → B = timeline[0].contextTokens = 5.
    const timeline = [5, 50, 120].map((t) => ({ contextTokens: t, model: MODEL }));
    const c = compaction(buildWhatIf({ timeline, compactionThresholdTokens: 100 }));
    expect(c.baselineTokens).toBe(5);
    // i2: 120 > 100 → reset to 5. saved = 120 - 5 = 115.
    expect(c.resetCount).toBe(1);
    expect(c.estSavedTokens).toBe(115);
  });
});

describe("buildWhatIf — evict heavy results (D5)", () => {
  const timeline: WhatIfTimelinePoint[] = [1, 2, 3, 4, 5].map((line) => ({
    contextTokens: 500_000,
    model: MODEL,
    line,
  }));

  it("evicts one known-size result N turns after it appeared → exact delta", () => {
    // result at line 2 → appears at index 1; N=1 → evictIdx=2; removed from
    // indices 2,3,4 (3 points). tokens = ceil(400000/4) = 100000.
    const e = eviction(
      buildWhatIf({
        timeline,
        heavyResults: [{ id: "r1", tool: "Bash", resultChars: 400_000, line: 2 }],
        evictAfterTurns: 1,
      }),
    );
    expect(e.results).toHaveLength(1);
    const r = e.results[0];
    expect(r?.tokens).toBe(100_000);
    expect(r?.turnsRemoved).toBe(3);
    expect(r?.estSavedTokens).toBe(300_000);
    expect(r?.estSavedUsd).toBeCloseTo(300_000 * RATE, 9);
    expect(e.estSavedTokens).toBe(300_000);
    expect(e.estSavedUsd).toBeCloseTo(300_000 * RATE, 9);
    expect(e.estSavedPct).toBeCloseTo(300_000 / 2_500_000, 12);
    expect(e.pricingComplete).toBe(true);
  });

  it("skips a result at or below the size threshold", () => {
    const s = skipped(
      buildWhatIf({
        timeline,
        heavyResults: [{ id: "small", resultChars: 100_000, line: 2 }],
      }),
      "evict-heavy-results",
    );
    expect(s.reason).toContain("larger than");
  });
});

describe("buildWhatIf — honesty contract", () => {
  it("unknown model → deterministic tokens, no USD, pricingComplete false", () => {
    // No per-point model and no fallbackModel: token math still exact, USD omitted.
    const timeline = [10, 50, 110, 150].map((t) => ({ contextTokens: t }));
    const c = compaction(
      buildWhatIf({ timeline, compactionThresholdTokens: 100, compactionBaselineTokens: 10 }),
    );
    expect(c.pricingComplete).toBe(false);
    expect(c.estSavedUsd).toBeUndefined();
    expect(c.baselineModelCostUsd).toBeUndefined();
    expect(c.estSavedTokens).toBe(200); // (110-10) + (150-50)
    expect(c.estSavedPct).toBeCloseTo(200 / 320, 12);
    expect(c.assumptions.some((a) => a.includes("no priceable model"))).toBe(true);
  });

  it("no timeline → both scenarios skipped with a reason", () => {
    const results = buildWhatIf({ timeline: [] });
    expect(skipped(results, "compaction-policy").reason).toContain("no context timeline");
    expect(skipped(results, "evict-heavy-results").reason).toContain("no context timeline");
  });

  it("every computed scenario carries the counterfactual basis and assumptions", () => {
    const timeline = [1, 2].map((line) => ({ contextTokens: 300_000, model: MODEL, line }));
    const results = buildWhatIf({
      timeline,
      heavyResults: [{ id: "r", resultChars: 200_000, line: 1 }],
      evictAfterTurns: 0,
    });
    for (const s of results) {
      if ("skipped" in s) continue;
      expect(s.basis).toBe("counterfactual-model");
      expect(s.assumptions.length).toBeGreaterThan(0);
      expect(s.assumptions.some((a) => a.includes("not a billed amount"))).toBe(true);
    }
  });
});
