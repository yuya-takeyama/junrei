import type { TrendBucket } from "@junrei/core";
import { describe, expect, it } from "vitest";
import {
  approxTokensFromChars,
  avgDurationMs,
  avgSubagentReturnChars,
  cadenceBars,
  compactionsPerSession,
  dailyModelSegments,
  delegationSplitHeights,
  formatDayLabel,
  modelStackOrder,
  sparklineGeometry,
  sparklinePointsAttr,
  sparseAxisIndices,
  spikeDayLookup,
  windowMaxCost,
  windowMaxSubagentReturnChars,
} from "./trendsLayout.js";

/** Minimal zero-filled bucket, overridden per test — mirrors `computeTrends`'s own `freshBucket` shape. */
function bucket(date: string, overrides: Partial<TrendBucket> = {}): TrendBucket {
  return {
    date,
    sessionCount: 0,
    userTurnCount: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    byModel: [],
    delegation: { main: {}, subagents: {} },
    cacheHitRate: null,
    compactionCount: 0,
    subagentReturn: null,
    ...overrides,
  };
}

describe("compactionsPerSession", () => {
  it("divides compactions by sessions", () => {
    expect(compactionsPerSession({ compactionCount: 3, sessionCount: 2 })).toBe(1.5);
  });

  it("is null (not 0) on a day with zero sessions", () => {
    expect(compactionsPerSession({ compactionCount: 0, sessionCount: 0 })).toBeNull();
  });
});

describe("avgSubagentReturnChars", () => {
  it("divides total chars by return count", () => {
    expect(
      avgSubagentReturnChars({ subagentReturn: { count: 4, totalChars: 800, maxChars: 500 } }),
    ).toBe(200);
  });

  it("is null when no subagent returned anything that day", () => {
    expect(avgSubagentReturnChars({ subagentReturn: null })).toBeNull();
  });
});

describe("approxTokensFromChars", () => {
  it("divides by 4", () => {
    expect(approxTokensFromChars(4000)).toBe(1000);
  });
});

describe("windowMaxSubagentReturnChars", () => {
  it("is the max of every bucket's own maxChars (not a sum)", () => {
    const buckets = [
      bucket("2026-07-01", { subagentReturn: { count: 1, totalChars: 100, maxChars: 100 } }),
      bucket("2026-07-02", { subagentReturn: { count: 3, totalChars: 900, maxChars: 500 } }),
    ];
    expect(windowMaxSubagentReturnChars(buckets)).toBe(500);
  });

  it("is null when no bucket in the window has a subagentReturn at all", () => {
    expect(windowMaxSubagentReturnChars([bucket("2026-07-01"), bucket("2026-07-02")])).toBeNull();
  });
});

describe("formatDayLabel", () => {
  it('formats a YYYY-MM-DD key as "Jul 9"', () => {
    expect(formatDayLabel("2026-07-09")).toBe("Jul 9");
  });

  it("returns the raw key unchanged when it isn't well-formed", () => {
    expect(formatDayLabel("not-a-date")).toBe("not-a-date");
  });
});

describe("sparseAxisIndices", () => {
  it("labels every index when count is at or below maxLabels", () => {
    expect(sparseAxisIndices(5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("always includes the first and last index for a window wider than maxLabels", () => {
    const indices = sparseAxisIndices(30, 6);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(29);
    expect(indices.length).toBeLessThanOrEqual(6);
  });

  it("is empty for a zero-length window", () => {
    expect(sparseAxisIndices(0)).toEqual([]);
  });
});

describe("avgDurationMs", () => {
  it("divides total duration by session count", () => {
    expect(avgDurationMs({ totalDurationMs: 9000, sessionCount: 3 })).toBe(3000);
  });

  it("is null (not 0) on a day with zero sessions", () => {
    expect(avgDurationMs({ totalDurationMs: 0, sessionCount: 0 })).toBeNull();
  });
});

describe("cadenceBars", () => {
  it("scales bar height relative to the window's busiest day", () => {
    const buckets = [
      bucket("2026-07-01", { sessionCount: 2 }),
      bucket("2026-07-02", { sessionCount: 4 }),
    ];
    const bars = cadenceBars(buckets);
    expect(bars.map((b) => b.heightPct)).toEqual([50, 100]);
  });

  it("every bar is 0% height when the whole window is empty", () => {
    const bars = cadenceBars([bucket("2026-07-01"), bucket("2026-07-02")]);
    expect(bars.every((b) => b.heightPct === 0)).toBe(true);
  });
});

describe("spikeDayLookup", () => {
  it("indexes spike days by date", () => {
    const lookup = spikeDayLookup([{ date: "2026-07-05", costUsd: 40, mean: 8, stddev: 5 }]);
    expect(lookup.get("2026-07-05")?.costUsd).toBe(40);
    expect(lookup.get("2026-07-06")).toBeUndefined();
  });
});

describe("modelStackOrder", () => {
  it("orders models by total cost across the whole window, descending", () => {
    const buckets = [
      bucket("2026-07-01", {
        byModel: [
          { model: "sonnet", costUsd: 2, inputTokens: 0, outputTokens: 0 },
          { model: "opus", costUsd: 10, inputTokens: 0, outputTokens: 0 },
        ],
      }),
      bucket("2026-07-02", {
        byModel: [{ model: "sonnet", costUsd: 9, inputTokens: 0, outputTokens: 0 }],
      }),
    ];
    // sonnet: 2 + 9 = 11, opus: 10 — sonnet edges out opus once both days are summed.
    expect(modelStackOrder(buckets)).toEqual(["sonnet", "opus"]);
  });

  it("treats an unpriced model (costUsd undefined) as contributing 0", () => {
    const buckets = [
      bucket("2026-07-01", {
        byModel: [{ model: "mystery", inputTokens: 1, outputTokens: 1 }],
      }),
    ];
    expect(modelStackOrder(buckets)).toEqual(["mystery"]);
  });
});

describe("dailyModelSegments", () => {
  it("scales each model's segment against the window max (half the max cost -> half the 110px stack) and drops zero-cost models", () => {
    const b = bucket("2026-07-01", {
      byModel: [
        { model: "sonnet", costUsd: 5, inputTokens: 0, outputTokens: 0 },
        { model: "haiku", costUsd: 0, inputTokens: 10, outputTokens: 10 },
      ],
    });
    const segments = dailyModelSegments(b, ["sonnet", "haiku"], 10);
    expect(segments).toEqual([{ model: "sonnet", costUsd: 5, heightPx: 55 }]);
  });

  it("is empty when the day has none of the window's models", () => {
    const b = bucket("2026-07-01");
    expect(dailyModelSegments(b, ["sonnet"], 10)).toEqual([]);
  });
});

describe("windowMaxCost", () => {
  it("is the costliest single day", () => {
    const buckets = [bucket("d1", { totalCostUsd: 3 }), bucket("d2", { totalCostUsd: 7 })];
    expect(windowMaxCost(buckets)).toBe(7);
  });

  it("is 0 for an all-empty window", () => {
    expect(windowMaxCost([bucket("d1"), bucket("d2")])).toBe(0);
  });
});

describe("delegationSplitHeights", () => {
  it("scales main/subagent segments against the window max (110px stack)", () => {
    const b = bucket("2026-07-01", {
      delegation: { main: { costUsd: 3 }, subagents: { costUsd: 1 } },
    });
    const heights = delegationSplitHeights(b, 4);
    expect(heights).toEqual({
      mainCostUsd: 3,
      subCostUsd: 1,
      mainHeightPx: 82.5,
      subHeightPx: 27.5,
      unpriced: false,
    });
  });

  it("marks the day unpriced and draws a 0px segment when a scope's cost is undefined", () => {
    const b = bucket("2026-07-01", { delegation: { main: { costUsd: 3 }, subagents: {} } });
    const heights = delegationSplitHeights(b, 4);
    expect(heights.unpriced).toBe(true);
    expect(heights.subHeightPx).toBe(0);
    expect(heights.subCostUsd).toBeUndefined();
  });
});

describe("sparklineGeometry", () => {
  it("breaks the polyline into separate segments at each null gap", () => {
    const geometry = sparklineGeometry([1, null, 2, 3], 100, 10);
    expect(geometry.segments).toHaveLength(2);
    expect(geometry.segments[0]?.map((p) => p.index)).toEqual([0]);
    expect(geometry.segments[1]?.map((p) => p.index)).toEqual([2, 3]);
  });

  it("centers a flat (all-equal) series on the vertical mid-line instead of dividing by zero", () => {
    const geometry = sparklineGeometry([5, 5, 5], 100, 10);
    expect(geometry.segments[0]?.every((p) => p.y === 5)).toBe(true);
  });

  it("is empty (no segments) when every value is null", () => {
    const geometry = sparklineGeometry([null, null], 100, 10);
    expect(geometry.segments).toEqual([]);
  });

  it("zero-anchors a fixed domain instead of auto-scaling to the data's own min/max — a stable near-ceiling series renders near the top, not stretched into a cliff", () => {
    const auto = sparklineGeometry([0.95, 0.96, 0.97, 0.98], 100, 10);
    const fixed = sparklineGeometry([0.95, 0.96, 0.97, 0.98], 100, 10, {
      domain: { min: 0, max: 1 },
    });
    expect(auto.min).toBeCloseTo(0.95);
    expect(fixed.min).toBe(0);
    expect(fixed.max).toBe(1);
    // Every point sits in the top 5% of the fixed 0..1 domain (near y=0 — SVG y grows downward).
    for (const segment of fixed.segments) {
      for (const p of segment) expect(p.y).toBeLessThan(1);
    }
  });

  it("extends the auto domain to include a reference band that falls outside the data, and reports its pixel y-range", () => {
    const geometry = sparklineGeometry([10, 12], 100, 10, { referenceBand: { min: 0, max: 100 } });
    expect(geometry.min).toBe(0);
    expect(geometry.max).toBe(100);
    expect(geometry.referenceBandY).toBeDefined();
    expect(geometry.referenceBandY?.top).toBeLessThan(geometry.referenceBandY?.bottom ?? 0);
  });

  it("still draws the reference band against a fixed domain, but the band no longer widens the domain itself (domain wins)", () => {
    const geometry = sparklineGeometry([0.5], 100, 10, {
      domain: { min: 0, max: 1 },
      referenceBand: { min: 0.2, max: 0.4 },
    });
    // The band's own [0.2, 0.4] range didn't extend the fixed [0, 1] domain.
    expect(geometry.min).toBe(0);
    expect(geometry.max).toBe(1);
    expect(geometry.referenceBandY).toBeDefined();
  });
});

describe("sparklinePointsAttr", () => {
  it("renders an SVG polyline points string", () => {
    const geometry = sparklineGeometry([0, 10], 100, 10);
    const segment = geometry.segments[0];
    expect(segment).toBeDefined();
    expect(sparklinePointsAttr(segment as NonNullable<typeof segment>)).toBe("0.0,10.0 100.0,0.0");
  });
});
