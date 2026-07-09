import { describe, expect, it } from "vitest";
import {
  interleaveTurnsAndCompactions,
  turnStackHeights,
  turnStackTotal,
} from "./timelineLayout.js";

function turn(line: number, overrides: Partial<Record<string, number>> = {}) {
  return {
    line,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    apiMessageCount: 1,
    ...overrides,
  };
}

function compaction(line: number) {
  return { line };
}

describe("interleaveTurnsAndCompactions", () => {
  it("returns just the turns, in order, when there are no compactions", () => {
    const turns = [turn(1), turn(10), turn(20)];
    const items = interleaveTurnsAndCompactions(turns, []);
    expect(items.map((i) => i.kind)).toEqual(["turn", "turn", "turn"]);
    expect(items.map((i) => (i.kind === "turn" ? i.turn.line : undefined))).toEqual([1, 10, 20]);
  });

  it("places a compaction before the first turn when its line precedes it", () => {
    const turns = [turn(10), turn(20)];
    const items = interleaveTurnsAndCompactions(turns, [compaction(5)]);
    expect(items.map((i) => i.kind)).toEqual(["compaction", "turn", "turn"]);
  });

  it("places a compaction between two turns right before the later one", () => {
    const turns = [turn(10), turn(20)];
    const items = interleaveTurnsAndCompactions(turns, [compaction(15)]);
    expect(items.map((i) => i.kind)).toEqual(["turn", "compaction", "turn"]);
    expect((items[2] as { kind: "turn"; turn: { line: number } }).turn.line).toBe(20);
  });

  it("appends a compaction after the last turn at the end", () => {
    const turns = [turn(10), turn(20)];
    const items = interleaveTurnsAndCompactions(turns, [compaction(25)]);
    expect(items.map((i) => i.kind)).toEqual(["turn", "turn", "compaction"]);
  });

  it("handles multiple compactions across all three boundary positions", () => {
    const turns = [turn(10), turn(20), turn(30)];
    const items = interleaveTurnsAndCompactions(turns, [
      compaction(25),
      compaction(5),
      compaction(15),
    ]);
    // Sorted by line regardless of input order: 5 (before), 15 (between 10 & 20),
    // 25 (between 20 & 30).
    expect(items.map((i) => i.kind)).toEqual([
      "compaction",
      "turn",
      "compaction",
      "turn",
      "compaction",
      "turn",
    ]);
  });

  it("handles a compaction landing exactly on a turn's line by placing it before that turn", () => {
    const turns = [turn(10), turn(20)];
    const items = interleaveTurnsAndCompactions(turns, [compaction(20)]);
    expect(items.map((i) => i.kind)).toEqual(["turn", "compaction", "turn"]);
  });

  it("returns only compactions when there are no turns", () => {
    const items = interleaveTurnsAndCompactions([], [compaction(5), compaction(10)]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "compaction")).toBe(true);
  });
});

describe("turnStackTotal / turnStackHeights", () => {
  it("sums all 4 stackable components", () => {
    const t = turn(1, {
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      inputTokens: 30,
      outputTokens: 10,
    });
    expect(turnStackTotal(t)).toBe(160);
  });

  it("scales the largest turn to the max stack height (110px)", () => {
    const small = turn(1, { cacheReadTokens: 50 });
    const big = turn(2, { cacheReadTokens: 100 });
    const maxTotal = Math.max(turnStackTotal(small), turnStackTotal(big));
    const heights = turnStackHeights(big, maxTotal);
    expect(heights.cacheRead).toBeCloseTo(110, 9);
  });

  it("gives every nonzero component at least 1px even when tiny", () => {
    const tiny = turn(1, { cacheReadTokens: 1 });
    const heights = turnStackHeights(tiny, 1_000_000);
    expect(heights.cacheRead).toBeGreaterThanOrEqual(1);
  });

  it("gives a zero component exactly 0px", () => {
    const t = turn(1, { cacheReadTokens: 100 });
    const heights = turnStackHeights(t, 100);
    expect(heights.cacheWrite).toBe(0);
    expect(heights.freshIn).toBe(0);
    expect(heights.output).toBe(0);
  });
});
