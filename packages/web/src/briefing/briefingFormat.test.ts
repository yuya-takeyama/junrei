import type { BriefingDailyCost } from "@junrei/core";
import { describe, expect, it } from "vitest";
import { costBars, formatDeltaPct, formatDeltaPts, formatRate } from "./briefingFormat.js";

describe("formatRate", () => {
  it("rounds a 0-1 fraction to an integer percent", () => {
    expect(formatRate(0.96)).toBe("96%");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(1)).toBe("100%");
  });

  it("renders an em dash when the server had no denominator (null)", () => {
    expect(formatRate(null)).toBe("—");
  });
});

describe("formatDeltaPct", () => {
  it("prefixes a direction arrow and drops the sign, keeping one decimal", () => {
    expect(formatDeltaPct(-25)).toBe("↓25%");
    expect(formatDeltaPct(12.34)).toBe("↑12.3%");
    expect(formatDeltaPct(0)).toBe("→0%");
  });

  it("renders an em dash for a missing previous window", () => {
    expect(formatDeltaPct(null)).toBe("—");
  });
});

describe("formatDeltaPts", () => {
  it("formats a points delta with a direction arrow", () => {
    expect(formatDeltaPts(10)).toBe("↑10pts");
    expect(formatDeltaPts(-3.5)).toBe("↓3.5pts");
    expect(formatDeltaPts(null)).toBe("—");
  });
});

describe("costBars", () => {
  const series: BriefingDailyCost[] = [
    { date: "2026-07-17", costUsd: 10 },
    { date: "2026-07-18", costUsd: 20 },
    { date: "2026-07-19", costUsd: 5 },
  ];

  it("scales each bar to the window's costliest day and flags the latest bar", () => {
    const bars = costBars(series);
    expect(bars.map((b) => Math.round(b.heightPct))).toEqual([50, 100, 25]);
    expect(bars.map((b) => b.isLast)).toEqual([false, false, true]);
    expect(bars.at(-1)?.date).toBe("2026-07-19");
  });

  it("yields all-zero heights for an all-zero window without dividing by zero", () => {
    const bars = costBars([
      { date: "a", costUsd: 0 },
      { date: "b", costUsd: 0 },
    ]);
    expect(bars.every((b) => b.heightPct === 0)).toBe(true);
    expect(bars.at(-1)?.isLast).toBe(true);
  });

  it("returns an empty array for an empty series", () => {
    expect(costBars([])).toEqual([]);
  });
});
