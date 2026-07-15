import { describe, expect, it } from "vitest";
import {
  formatStepCompact,
  formatStepDetail,
  stepOverflowLabel,
  stepPreviewLines,
  type TurnStep,
} from "./StepsRow.js";

/**
 * `StepsRow.tsx` renders via real JSX (dot cluster, toggle button), so — per
 * the repo's own component-test idiom (none exist; see turnColumns.test.ts,
 * which tests its exported pure functions directly rather than rendering) —
 * coverage here targets the pure text-formatting helpers it delegates to,
 * not the component itself.
 */
function step(overrides: Partial<TurnStep> = {}): TurnStep {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe("formatStepCompact", () => {
  it("formats the collapsed preview's in/out-only line, matching the mock exactly", () => {
    expect(formatStepCompact(step({ inputTokens: 1800, outputTokens: 900 }), 1)).toBe(
      "s1 · in 1.8k · out 900",
    );
  });

  it("omits cache columns even when the step carries cache usage", () => {
    const line = formatStepCompact(
      step({
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 999_999,
        cacheCreationTokens: 999_999,
      }),
      2,
    );
    expect(line).not.toContain("c·r");
    expect(line).not.toContain("c·w");
  });
});

describe("formatStepDetail", () => {
  it("formats the expanded list's full breakdown line, matching the spec's example", () => {
    const line = formatStepDetail(
      step({
        inputTokens: 41_900,
        cacheReadTokens: 896_900,
        cacheCreationTokens: 12_100,
        outputTokens: 5_400,
      }),
      3,
    );
    expect(line).toBe("s3 · in 41.9k · c·r 896.9k · c·w 12.1k · out 5.4k");
  });
});

describe("stepPreviewLines", () => {
  it("returns at most the first two steps, 1-indexed", () => {
    const steps = [
      step({ inputTokens: 1800, outputTokens: 900 }),
      step({ inputTokens: 200, outputTokens: 1400 }),
      step({ inputTokens: 5, outputTokens: 5 }),
    ];
    expect(stepPreviewLines(steps)).toEqual(["s1 · in 1.8k · out 900", "s2 · in 200 · out 1.4k"]);
  });

  it("returns fewer than two lines when there are fewer than two steps", () => {
    expect(stepPreviewLines([step({ inputTokens: 1, outputTokens: 1 })])).toHaveLength(1);
    expect(stepPreviewLines([])).toEqual([]);
  });
});

describe("stepOverflowLabel", () => {
  it("is undefined at exactly two steps — nothing is elided yet", () => {
    expect(stepOverflowLabel([step(), step()])).toBeUndefined();
  });

  it("reads '… sN' once more than two steps exist, N = total step count", () => {
    expect(stepOverflowLabel([step(), step(), step(), step(), step(), step()])).toBe("… s6");
  });
});
