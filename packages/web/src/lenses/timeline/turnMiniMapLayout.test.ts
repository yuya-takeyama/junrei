import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../api.js";
import { formatTime } from "../../format.js";
import type { TurnGroup } from "./turnGroups.js";
import {
  deriveTurnBandFlags,
  layoutTurnBandHeights,
  MIN_TURN_BAND_HEIGHT_PX,
  turnTooltipLabel,
} from "./turnMiniMapLayout.js";

function toolCall(line: number, status: "ok" | "error" = "ok"): TimelineEntry {
  return {
    kind: "tool-call",
    line,
    toolUseId: `t${String(line)}`,
    name: "Bash",
    inputSummary: "x",
    status,
  };
}

function apiError(line: number): TimelineEntry {
  return { kind: "api-error", line };
}

function compaction(line: number): TimelineEntry {
  return { kind: "compaction", line };
}

/** Minimal literal `TurnGroup` — only the fields a given test cares about need overriding. */
function group(overrides: Partial<TurnGroup> = {}): TurnGroup {
  return {
    index: 1,
    entries: [],
    models: [],
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costIncomplete: false,
    toolErrorCount: 0,
    anchorLine: 1,
    ...overrides,
  };
}

describe("layoutTurnBandHeights", () => {
  it("returns an empty array for no turns", () => {
    expect(layoutTurnBandHeights([], 400)).toEqual([]);
  });

  it("splits proportionally to entry count when every band clears the floor", () => {
    const heights = layoutTurnBandHeights([10, 30, 60], 400);
    expect(heights[0]).toBeCloseTo(40, 5);
    expect(heights[1]).toBeCloseTo(120, 5);
    expect(heights[2]).toBeCloseTo(240, 5);
  });

  it("always sums to the track height, proportional or clamped", () => {
    const cases: Array<[number[], number]> = [
      [[10, 30, 60], 400],
      [[1, 1, 1, 1000], 200],
      [[0, 0, 5], 90],
      [[1, 1, 1, 1], 17],
      [[7], 50],
    ];
    for (const [counts, trackHeight] of cases) {
      const heights = layoutTurnBandHeights(counts, trackHeight);
      const sum = heights.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(trackHeight, 5);
    }
  });

  it("clamps a tiny turn to the minimum instead of starving it to near-zero", () => {
    const heights = layoutTurnBandHeights([1, 1, 1000], 200);
    expect(heights[0]).toBe(MIN_TURN_BAND_HEIGHT_PX);
    expect(heights[1]).toBe(MIN_TURN_BAND_HEIGHT_PX);
    // The big turn absorbs whatever the floor-clamped turns didn't need.
    expect(heights[2]).toBeCloseTo(200 - 2 * MIN_TURN_BAND_HEIGHT_PX, 5);
  });

  it("never returns a band below the minimum, even under heavy skew", () => {
    const heights = layoutTurnBandHeights([1, 1, 1, 1_000_000], 17, 4);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(4 - 1e-9);
  });

  it("falls back to an even split when the floor alone would exceed the track height", () => {
    const heights = layoutTurnBandHeights([100, 1, 1, 1], 10, 4);
    expect(heights).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it("treats an all-zero-entry turn set as an even split", () => {
    const heights = layoutTurnBandHeights([0, 0, 0, 0], 40);
    expect(heights).toEqual([10, 10, 10, 10]);
  });

  it("returns all-zero heights for a non-positive track height", () => {
    expect(layoutTurnBandHeights([1, 2, 3], 0)).toEqual([0, 0, 0]);
  });
});

describe("turnTooltipLabel", () => {
  it("includes the formatted time when startedAt is present", () => {
    const iso = "2026-07-15T14:52:00Z";
    expect(turnTooltipLabel(7, iso)).toBe(`#7 · ${formatTime(iso)}`);
  });

  it("omits the time part when startedAt is undefined", () => {
    expect(turnTooltipLabel(3, undefined)).toBe("#3");
  });
});

describe("deriveTurnBandFlags", () => {
  it("flags no accents for a plain turn", () => {
    const g = group({ costUsd: 0.1, entries: [toolCall(1)] });
    expect(deriveTurnBandFlags(g, 10)).toEqual({
      isOutlier: false,
      hasError: false,
      hasCompaction: false,
    });
  });

  it("flags outlier via the same rule as the `.trg` row tint", () => {
    const g = group({ costUsd: 5, entries: [] });
    expect(deriveTurnBandFlags(g, 10).isOutlier).toBe(true);
  });

  it("flags a tool-call error", () => {
    const g = group({ entries: [toolCall(1, "error")] });
    expect(deriveTurnBandFlags(g, 10).hasError).toBe(true);
  });

  it("flags an api-error entry as an error too", () => {
    const g = group({ entries: [apiError(1)] });
    expect(deriveTurnBandFlags(g, 10).hasError).toBe(true);
  });

  it("does not flag an error for an ok tool call", () => {
    const g = group({ entries: [toolCall(1, "ok")] });
    expect(deriveTurnBandFlags(g, 10).hasError).toBe(false);
  });

  it("flags a compaction entry", () => {
    const g = group({ entries: [compaction(1)] });
    expect(deriveTurnBandFlags(g, 10).hasCompaction).toBe(true);
  });

  it("combines all three flags independently", () => {
    const g = group({
      costUsd: 5,
      entries: [toolCall(1, "error"), compaction(2)],
    });
    expect(deriveTurnBandFlags(g, 10)).toEqual({
      isOutlier: true,
      hasError: true,
      hasCompaction: true,
    });
  });
});
