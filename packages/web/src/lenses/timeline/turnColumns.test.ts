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

  it("hides deleg when no group defines delegatedCostUsd (Codex-shaped or no-delegation Claude)", () => {
    const groups = [group(), group({ index: 2, anchorLine: 5, costUsd: 0.5 })];
    expect(visibleTurnColumns(groups).map((c) => c.key)).not.toContain("deleg");
  });

  it("shows deleg once any group defines delegatedCostUsd", () => {
    const groups = [
      group(),
      group({ index: 2, anchorLine: 5, delegatedCostUsd: 0.3, delegatedCostIncomplete: false }),
    ];
    expect(visibleTurnColumns(groups).map((c) => c.key)).toContain("deleg");
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

  it("places deleg right after cost, last in the fixed display order", () => {
    const groups = [
      group({
        stepCount: 1,
        cacheCreationTokens: 2,
        reasoningTokens: 3,
        costUsd: 4,
        delegatedCostUsd: 1,
        delegatedCostIncomplete: false,
      }),
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
      "deleg",
    ]);
  });
});

describe("reasoning column", () => {
  function reasoningColumn(groups: readonly TurnGroup[]) {
    const col = visibleTurnColumns(groups).find((c) => c.key === "reasoning");
    if (col === undefined) throw new Error("reasoning column not present");
    return col;
  }

  it("mutes the cell when reasoningTokens is exactly 0 (matches the old Codex Turns table)", () => {
    const groups = [group({ reasoningTokens: 0 })];
    expect(reasoningColumn(groups).className(groups[0] as TurnGroup, false)).toBe("stat mut");
  });

  it("does not mute a non-zero reasoning cell", () => {
    const groups = [group({ reasoningTokens: 120 })];
    expect(reasoningColumn(groups).className(groups[0] as TurnGroup, false)).toBe("stat");
  });
});

describe("deleg column", () => {
  function delegColumn(groups: readonly TurnGroup[]) {
    const col = visibleTurnColumns(groups).find((c) => c.key === "deleg");
    if (col === undefined) throw new Error("deleg column not present");
    return col;
  }

  it("renders an em-dash for a turn with no delegatedCostUsd (no launches)", () => {
    const groups = [
      group({ delegatedCostUsd: 0.5, delegatedCostIncomplete: false }),
      group({ index: 2, anchorLine: 5 }),
    ];
    expect(delegColumn(groups).render(groups[1] as TurnGroup)).toBe("—");
  });

  it("renders the formatted USD amount, no ≈ prefix, when complete", () => {
    const groups = [group({ delegatedCostUsd: 1.5, delegatedCostIncomplete: false })];
    expect(delegColumn(groups).render(groups[0] as TurnGroup)).toBe("$1.50");
  });

  it("prefixes ≈ and adds the approx class when delegatedCostIncomplete", () => {
    const groups = [group({ delegatedCostUsd: 1.5, delegatedCostIncomplete: true })];
    expect(delegColumn(groups).render(groups[0] as TurnGroup)).toBe("≈ $1.50");
    expect(delegColumn(groups).className(groups[0] as TurnGroup, false)).toBe("stat approx");
  });

  it("has no approx class when complete", () => {
    const groups = [group({ delegatedCostUsd: 1.5, delegatedCostIncomplete: false })];
    expect(delegColumn(groups).className(groups[0] as TurnGroup, false)).toBe("stat");
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

  it("appends the deleg column's width, after cost, once any group defines delegatedCostUsd", () => {
    const groups = [group({ costUsd: 4, delegatedCostUsd: 1, delegatedCostIncomplete: false })];
    const template = turnGridTemplate(visibleTurnColumns(groups));
    expect(template).toBe("46px minmax(0, 1fr) 66px 58px 68px 74px 68px 66px 74px");
  });
});
