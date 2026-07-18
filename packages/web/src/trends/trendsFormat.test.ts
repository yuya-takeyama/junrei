import { describe, expect, it } from "vitest";
import { formatDeltaPct, formatDeltaPts, formatRatePct } from "./trendsFormat.js";

describe("formatDeltaPct", () => {
  it("renders an em dash for a null delta", () => {
    expect(formatDeltaPct(null)).toBe("—");
  });

  it("signs positive and negative values, one decimal place", () => {
    expect(formatDeltaPct(12.34)).toBe("+12.3%");
    expect(formatDeltaPct(-8.05)).toBe("-8.1%");
  });

  it("renders zero with no sign", () => {
    expect(formatDeltaPct(0)).toBe("0.0%");
  });
});

describe("formatDeltaPts", () => {
  it("renders an em dash for a null delta and signs otherwise", () => {
    expect(formatDeltaPts(null)).toBe("—");
    expect(formatDeltaPts(3.2)).toBe("+3.2pts");
    expect(formatDeltaPts(-1)).toBe("-1.0pts");
  });
});

describe("formatRatePct", () => {
  it("renders an em dash for null (no effective-input volume), distinct from a real 0%", () => {
    expect(formatRatePct(null)).toBe("—");
    expect(formatRatePct(0)).toBe("0%");
  });

  it("rounds to a whole percent", () => {
    expect(formatRatePct(0.618)).toBe("62%");
  });
});
