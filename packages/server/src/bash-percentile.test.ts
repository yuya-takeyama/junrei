import { describe, expect, it } from "vitest";
import { computeSessionBashPercentile } from "./bash-percentile.js";
import type { RepoOverviewBash } from "./overview.js";

function bash(overrides: Partial<RepoOverviewBash> = {}): RepoOverviewBash {
  return {
    calls: 0,
    resultChars: 0,
    distribution: { resultChars: [], estUsd: [] },
    ...overrides,
  };
}

describe("computeSessionBashPercentile", () => {
  it("is undefined when the repo has fewer than 5 sessions with bash data", () => {
    const overview = bash({ distribution: { resultChars: [10, 20, 30, 40], estUsd: [] } });
    expect(computeSessionBashPercentile({ resultChars: 50 }, overview)).toBeUndefined();
  });

  it("ranks on resultChars when the session (or the repo) has no priced estUsd", () => {
    const overview = bash({
      distribution: { resultChars: [10, 20, 30, 40, 50], estUsd: [] },
    });
    const result = computeSessionBashPercentile({ resultChars: 30 }, overview);
    // 2 strictly below (10,20), 1 tied (30) -> (2 + 0.5) / 5 * 100 = 50
    expect(result?.pct).toBe(50);
    expect(result?.sampleCount).toBe(5);
    // median of [10,20,30,40,50] is 30 -> ratio 1
    expect(result?.medianRatio).toBe(1);
  });

  it("ranks on estUsd when both the session and the repo's estUsd distribution clear the sample-count bar", () => {
    const overview = bash({
      distribution: {
        resultChars: [1, 2, 3, 4, 5],
        estUsd: [0.1, 0.2, 0.3, 0.4, 0.5],
      },
    });
    const result = computeSessionBashPercentile({ estUsd: 0.45, resultChars: 999_999 }, overview);
    // 4 strictly below (0.1..0.4), 0 tied -> (4 + 0) / 5 * 100 = 80
    expect(result?.pct).toBe(80);
    // median 0.3 -> ratio 0.45 / 0.3 = 1.5
    expect(result?.medianRatio).toBe(1.5);
  });

  it("falls back to resultChars when the session's own estUsd is known but the repo's estUsd distribution is too thin", () => {
    const overview = bash({
      distribution: {
        resultChars: [10, 20, 30, 40, 50],
        estUsd: [0.1, 0.2], // only 2 priced sessions — below the bar
      },
    });
    const result = computeSessionBashPercentile({ estUsd: 999, resultChars: 40 }, overview);
    // Ranked on resultChars=40 against [10,20,30,40,50]: 3 below, 1 tied -> 70
    expect(result?.pct).toBe(70);
  });

  it("omits medianRatio when the distribution's median is 0", () => {
    const overview = bash({ distribution: { resultChars: [0, 0, 0, 0, 10], estUsd: [] } });
    const result = computeSessionBashPercentile({ resultChars: 10 }, overview);
    expect(result?.medianRatio).toBeUndefined();
    // 4 strictly below (the four 0s), 1 tied -> (4 + 0.5) / 5 * 100 = 90
    expect(result?.pct).toBe(90);
  });

  it("rounds pct and medianRatio", () => {
    const overview = bash({
      distribution: { resultChars: [1, 2, 3, 4, 5, 6, 7], estUsd: [] },
    });
    const result = computeSessionBashPercentile({ resultChars: 3 }, overview);
    // 2 below, 1 tied -> (2 + 0.5) / 7 * 100 = 35.714... -> 35.7
    expect(result?.pct).toBe(35.7);
  });
});
