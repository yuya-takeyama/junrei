import { describe, expect, it } from "vitest";
import { formatCostPair, formatDurationCompact } from "./format.js";

describe("formatDurationCompact", () => {
  it("formats dense durations", () => {
    expect(formatDurationCompact(58_000)).toBe("58s");
    expect(formatDurationCompact(4 * 60_000 + 2_000)).toBe("4m02s");
    expect(formatDurationCompact(2 * 3_600_000 + 14 * 60_000)).toBe("2h14m");
  });
});

describe("formatCostPair", () => {
  it("formats self and total costs as USD", () => {
    expect(formatCostPair(0.12, 0.25)).toBe("$0.12/$0.25");
    expect(formatCostPair(19.71, 20.45)).toBe("$19.71/$20.45");
  });
});
