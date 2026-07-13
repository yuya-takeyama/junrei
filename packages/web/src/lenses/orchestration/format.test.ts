import { describe, expect, it } from "vitest";
import { formatCostCell, formatDurationCompact, formatPctShare } from "./format.js";

describe("formatDurationCompact", () => {
  it("formats dense durations", () => {
    expect(formatDurationCompact(58_000)).toBe("58s");
    expect(formatDurationCompact(4 * 60_000 + 2_000)).toBe("4m02s");
    expect(formatDurationCompact(2 * 3_600_000 + 14 * 60_000)).toBe("2h14m");
  });
});

describe("formatCostCell", () => {
  it("always keeps 2 decimals, unlike the shared formatUsd", () => {
    expect(formatCostCell(0.12)).toBe("$0.12");
    expect(formatCostCell(19.71)).toBe("$19.71");
    expect(formatCostCell(123.4)).toBe("$123.40");
  });
});

describe("formatPctShare", () => {
  it("renders — for an undefined share (no priced session total)", () => {
    expect(formatPctShare(undefined)).toBe("—");
  });

  it("floors a nonzero-but-sub-1% share to <1% rather than a misleading 0%", () => {
    expect(formatPctShare(0.001)).toBe("<1%");
    expect(formatPctShare(0.0001)).toBe("<1%");
  });

  it("renders an exact 0 share as 0% (genuinely no cost, not just tiny)", () => {
    expect(formatPctShare(0)).toBe("0%");
  });

  it("rounds to the nearest whole percent", () => {
    expect(formatPctShare(0.336)).toBe("34%");
    expect(formatPctShare(0.5)).toBe("50%");
  });

  it("renders a full share as 100%", () => {
    expect(formatPctShare(1)).toBe("100%");
  });
});
