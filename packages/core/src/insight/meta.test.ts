import { describe, expect, it } from "vitest";
import { approxTokens, buildMeta } from "./meta.js";

describe("approxTokens", () => {
  it("estimates ceil(JSON length / 4)", () => {
    const value = { a: 1 };
    const expected = Math.ceil(JSON.stringify(value).length / 4);
    expect(approxTokens(value)).toBe(expected);
  });

  it("returns 0 for a value with a cycle rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(approxTokens(cyclic)).toBe(0);
  });
});

describe("buildMeta", () => {
  it("carries only approxTokens when no options are given", () => {
    const meta = buildMeta({ x: 1 });
    expect(meta.approxTokens).toBeGreaterThan(0);
    expect("truncated" in meta).toBe(false);
    expect("nextSteps" in meta).toBe(false);
  });

  it("includes truncated only when true", () => {
    expect("truncated" in buildMeta({}, { truncated: false })).toBe(false);
    expect(buildMeta({}, { truncated: true }).truncated).toBe(true);
  });

  it("includes nextSteps only when non-empty", () => {
    expect("nextSteps" in buildMeta({}, { nextSteps: [] })).toBe(false);
    expect(buildMeta({}, { nextSteps: ["do x"] }).nextSteps).toEqual(["do x"]);
  });
});
