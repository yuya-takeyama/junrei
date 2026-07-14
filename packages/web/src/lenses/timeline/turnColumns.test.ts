import { describe, expect, it } from "vitest";
import { turnGridTemplate, visibleTurnColumns } from "./turnColumns.js";
import type { TurnGroup } from "./turnGroups.js";

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

describe("visibleTurnColumns", () => {
  it("always shows started/dur/input/c·read/output, even for a single minimal group", () => {
    const keys = visibleTurnColumns([group()]).map((c) => c.key);
    expect(keys).toEqual(["started", "dur", "input", "cread", "output"]);
  });

  it("hides steps/c·write/cost when absent from every group", () => {
    const groups = [group(), group({ index: 2, anchorLine: 5 })];
    const keys = visibleTurnColumns(groups).map((c) => c.key);
    expect(keys).not.toContain("steps");
    expect(keys).not.toContain("cwrite");
    expect(keys).not.toContain("cost");
  });

  it("shows steps once any group defines stepCount", () => {
    const groups = [group(), group({ index: 2, anchorLine: 5, stepCount: 3 })];
    expect(visibleTurnColumns(groups).map((c) => c.key)).toContain("steps");
  });

  it("shows c·write once any group defines cacheCreationTokens", () => {
    const groups = [group(), group({ index: 2, anchorLine: 5, cacheCreationTokens: 40 })];
    expect(visibleTurnColumns(groups).map((c) => c.key)).toContain("cwrite");
  });

  it("shows cost once any group defines costUsd", () => {
    const groups = [group(), group({ index: 2, anchorLine: 5, costUsd: 0.5 })];
    expect(visibleTurnColumns(groups).map((c) => c.key)).toContain("cost");
  });

  it("shows reasoning once any group defines reasoningTokens (Codex-only field)", () => {
    const groups = [group(), group({ index: 2, anchorLine: 5, reasoningTokens: 120 })];
    expect(visibleTurnColumns(groups).map((c) => c.key)).toContain("reasoning");
  });

  it("keeps columns in the fixed display order regardless of which are present", () => {
    const groups = [
      group({ stepCount: 1, cacheCreationTokens: 2, reasoningTokens: 3, costUsd: 4 }),
    ];
    expect(visibleTurnColumns(groups).map((c) => c.key)).toEqual([
      "started",
      "dur",
      "steps",
      "input",
      "cread",
      "cwrite",
      "output",
      "reasoning",
      "cost",
    ]);
  });
});

describe("turnGridTemplate", () => {
  it("matches the Claude-full-presence template exactly (no visual change from the prior fixed grid)", () => {
    const groups = [group({ stepCount: 1, cacheCreationTokens: 2, costUsd: 4 })];
    const template = turnGridTemplate(visibleTurnColumns(groups));
    expect(template).toBe("46px minmax(0, 1fr) 66px 58px 44px 68px 74px 68px 68px 66px");
  });

  it("derives a narrower template when steps/c·write/cost are absent", () => {
    const template = turnGridTemplate(visibleTurnColumns([group()]));
    expect(template).toBe("46px minmax(0, 1fr) 66px 58px 68px 74px 68px");
  });

  it("includes the reasoning column's width once any group defines reasoningTokens", () => {
    const groups = [group({ reasoningTokens: 10 })];
    const template = turnGridTemplate(visibleTurnColumns(groups));
    expect(template).toBe("46px minmax(0, 1fr) 66px 58px 68px 74px 68px 82px");
  });
});
