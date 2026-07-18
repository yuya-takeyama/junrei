import { describe, expect, it } from "vitest";
import { percentileRank } from "./percentile.js";

describe("percentileRank", () => {
  it("returns undefined for an empty distribution", () => {
    expect(percentileRank([], 5)).toBeUndefined();
  });

  it("ranks a value strictly below every entry as 0", () => {
    expect(percentileRank([10, 20, 30, 40], 1)).toBe(0);
  });

  it("ranks a value strictly above every entry as 100", () => {
    expect(percentileRank([10, 20, 30, 40], 100)).toBe(100);
  });

  it("gives a value tied with every entry the midpoint (50)", () => {
    expect(percentileRank([5, 5, 5, 5], 5)).toBe(50);
  });

  it("counts entries strictly below as full points, ties as half points — [10,20,30,40,50] at 30", () => {
    // 2 strictly below (10, 20), 1 tied (30) -> (2 + 0.5) / 5 * 100 = 50
    expect(percentileRank([10, 20, 30, 40, 50], 30)).toBe(50);
  });

  it("matches the worked P88-style example — 100 samples, value beats 87 outright and ties none", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i); // 0..99
    // value 88 has entries 0..87 (88 of them) strictly below, itself is the
    // one tie -> (88 + 0.5) / 100 * 100 = 88.5
    expect(percentileRank(sorted, 88)).toBe(88.5);
  });

  it("handles a value between two distinct entries (no exact tie)", () => {
    // 25 is strictly greater than 10 and 20, strictly less than 30 and 40 ->
    // 2 below, 0 equal -> (2 + 0) / 4 * 100 = 50
    expect(percentileRank([10, 20, 30, 40], 25)).toBe(50);
  });

  it("handles a single-entry distribution", () => {
    expect(percentileRank([42], 42)).toBe(50);
    expect(percentileRank([42], 100)).toBe(100);
    expect(percentileRank([42], 0)).toBe(0);
  });

  it("handles duplicate entries correctly when value falls among them", () => {
    // [1,2,2,2,3] at value 2: 1 below, 3 equal -> (1 + 1.5) / 5 * 100 = 50
    expect(percentileRank([1, 2, 2, 2, 3], 2)).toBe(50);
  });
});
