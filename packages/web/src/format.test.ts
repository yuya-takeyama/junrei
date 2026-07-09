import { describe, expect, it } from "vitest";
import { formatDelegatedShare } from "./format.js";

describe("formatDelegatedShare", () => {
  it("formats both the cost share and the token share", () => {
    // main did 55.9% of cost but only 22.6% of tokens — the dogfooding
    // inversion this string exists to surface without mental math.
    const share = formatDelegatedShare({
      main: { tokens: 2260, costUsd: 63.18 },
      subagents: { tokens: 7740, costUsd: 49.84 },
    });
    expect(share).toBe("44% of cost · 77% of tokens");
  });

  it("returns undefined when nothing was delegated (no subagent tokens)", () => {
    const share = formatDelegatedShare({
      main: { tokens: 1000, costUsd: 5 },
      subagents: { tokens: 0, costUsd: 0 },
    });
    expect(share).toBeUndefined();
  });

  it("omits the cost share (tokens-only) when either scope's cost is unpriced", () => {
    const share = formatDelegatedShare({
      main: { tokens: 1000, costUsd: undefined },
      subagents: { tokens: 500 },
    });
    expect(share).toBe("33% of tokens");
  });
});
