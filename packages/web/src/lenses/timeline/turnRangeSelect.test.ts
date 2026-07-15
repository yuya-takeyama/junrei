import { describe, expect, it } from "vitest";
import { computeShiftClickRange } from "./turnRangeSelect.js";

const LINES = [10, 20, 30, 40, 50];

describe("computeShiftClickRange", () => {
  it("expands the inclusive range when the shift-clicked target was collapsed", () => {
    const result = computeShiftClickRange(LINES, 10, 40, false);
    expect(result).toEqual({ affectedLines: [10, 20, 30, 40], expand: true });
  });

  it("collapses the inclusive range when the shift-clicked target was expanded", () => {
    const result = computeShiftClickRange(LINES, 10, 40, true);
    expect(result).toEqual({ affectedLines: [10, 20, 30, 40], expand: false });
  });

  it("orders the range by display position, not by which end was clicked first", () => {
    // Anchor is AFTER the target in turn order — the range must still come
    // out low-to-high, not reversed.
    const result = computeShiftClickRange(LINES, 40, 10, false);
    expect(result).toEqual({ affectedLines: [10, 20, 30, 40], expand: true });
  });

  it("is inclusive of both endpoints", () => {
    const result = computeShiftClickRange(LINES, 20, 20, false);
    expect(result?.affectedLines).toEqual([20]);
  });

  it("covers the whole list when anchor and target are the two ends", () => {
    const result = computeShiftClickRange(LINES, 10, 50, false);
    expect(result?.affectedLines).toEqual(LINES);
  });

  it("returns null when the anchor line is no longer in the ordered list", () => {
    expect(computeShiftClickRange(LINES, 999, 40, false)).toBeNull();
  });

  it("returns null when the target line is no longer in the ordered list", () => {
    expect(computeShiftClickRange(LINES, 10, 999, false)).toBeNull();
  });
});
