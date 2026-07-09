import { describe, expect, it } from "vitest";
import { dayBars, formatUtcDayLabel, topModelShare } from "./repoOverviewHelpers.js";

describe("topModelShare", () => {
  it("picks the costliest priced model and its share of total cost", () => {
    const result = topModelShare({
      totalCostUsd: 100,
      byModel: [
        {
          model: "cheap",
          costUsd: 10,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          model: "pricey",
          costUsd: 63,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result).toEqual({ model: "pricey", shortLabel: "pricey", costUsd: 63, pct: 63 });
  });

  it("resolves a known model family to its short label", () => {
    const result = topModelShare({
      totalCostUsd: 10,
      byModel: [
        {
          model: "claude-fable-5",
          costUsd: 10,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result?.shortLabel).toBe("fable");
  });

  it("ignores unpriced models when picking the top one", () => {
    const result = topModelShare({
      totalCostUsd: 5,
      byModel: [
        {
          model: "unpriced",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          model: "priced",
          costUsd: 5,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result?.model).toBe("priced");
  });

  it("returns undefined when there's no priced usage at all", () => {
    const result = topModelShare({
      totalCostUsd: 0,
      byModel: [
        {
          model: "unpriced",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty byModel list", () => {
    expect(topModelShare({ totalCostUsd: 0, byModel: [] })).toBeUndefined();
  });
});

describe("dayBars", () => {
  it("scales each day's bar height relative to the window's costliest day", () => {
    const bars = dayBars([
      { date: "2026-07-08", costUsd: 50, sessionCount: 2 },
      { date: "2026-07-09", costUsd: 100, sessionCount: 3 },
      { date: "2026-07-10", costUsd: 25, sessionCount: 1 },
    ]);
    expect(bars).toEqual([
      { date: "2026-07-08", costUsd: 50, sessionCount: 2, heightPct: 50 },
      { date: "2026-07-09", costUsd: 100, sessionCount: 3, heightPct: 100 },
      { date: "2026-07-10", costUsd: 25, sessionCount: 1, heightPct: 25 },
    ]);
  });

  it("returns 0% heights (not NaN/Infinity) when every day is $0", () => {
    const bars = dayBars([{ date: "2026-07-08", costUsd: 0, sessionCount: 1 }]);
    expect(bars).toEqual([{ date: "2026-07-08", costUsd: 0, sessionCount: 1, heightPct: 0 }]);
  });

  it("returns [] for an empty window", () => {
    expect(dayBars([])).toEqual([]);
  });
});

describe("formatUtcDayLabel", () => {
  it("formats a YYYY-MM-DD key as a short UTC month/day label", () => {
    expect(formatUtcDayLabel("2026-07-09")).toBe("Jul 9");
  });

  it("stays anchored to UTC regardless of local timezone (no off-by-one date drift)", () => {
    // Dec 31 / Jan 1 boundary — the case most likely to shift under a
    // timezone-naive implementation.
    expect(formatUtcDayLabel("2025-12-31")).toBe("Dec 31");
    expect(formatUtcDayLabel("2026-01-01")).toBe("Jan 1");
  });

  it("returns the raw key unchanged for a malformed input", () => {
    expect(formatUtcDayLabel("not-a-date")).toBe("not-a-date");
  });
});
