import { describe, expect, it } from "vitest";
import type { ClaudeSessionListItem, CodexSessionListItem } from "./api.js";
import {
  computeFilteredOverview,
  dayBars,
  formatUtcDayLabel,
  topModelShare,
} from "./repoOverviewHelpers.js";

const claudeItem: ClaudeSessionListItem = {
  source: "claude-code",
  sessionId: "s1",
  projectDirName: "-Users-me-proj",
  subagentCount: 0,
  userTurnCount: 5,
  models: ["claude-fable-5"],
  totalCostUsd: 10,
  costIsComplete: true,
  totalTokens: 1000,
  cacheReadTokens: 200,
  compactionCount: 0,
  toolCallCount: 4,
  toolErrorCount: 0,
  sizeBytes: 4096,
  startedAt: "2026-07-09T10:00:00.000Z",
  modelMix: [],
  usageByModel: [
    {
      model: "claude-fable-5",
      costUsd: 8,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    },
  ],
  delegation: { main: { tokens: 800, costUsd: 8 }, subagents: { tokens: 200, costUsd: 2 } },
};

const codexItem: CodexSessionListItem = {
  source: "codex",
  sessionId: "s2",
  subagentCount: 0,
  archived: false,
  userTurnCount: 2,
  models: ["gpt-5"],
  totalCostUsd: 3,
  costIsComplete: true,
  totalTokens: 500,
  cacheReadTokens: 50,
  compactionCount: 0,
  toolCallCount: 1,
  toolErrorCount: 0,
  sizeBytes: 2048,
  startedAt: "2026-07-10T02:00:00.000Z",
  modelMix: [],
  usageByModel: [
    {
      model: "gpt-5",
      costUsd: 3,
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 4,
      cacheCreationTokens: 0,
    },
  ],
  delegation: { main: { tokens: 500, costUsd: 3 }, subagents: { tokens: 0, costUsd: 0 } },
};

describe("computeFilteredOverview", () => {
  it("sums cost and counts sessions per source across the given rows", () => {
    const overview = computeFilteredOverview([claudeItem, codexItem]);
    expect(overview.sessionCount).toBe(2);
    expect(overview.sourceCounts).toEqual({ "claude-code": 1, codex: 1 });
    expect(overview.totalCostUsd).toBe(13);
    expect(overview.costIsComplete).toBe(true);
  });

  it("aggregates ONLY the rows it's given — the caller's filters define the scope", () => {
    // The regression this function exists for: the band used to show the
    // repo's all-time rollup regardless of the date filter. Feeding it the
    // date-filtered subset must yield that subset's numbers, nothing more.
    const overview = computeFilteredOverview([claudeItem]);
    expect(overview.sessionCount).toBe(1);
    expect(overview.totalCostUsd).toBe(10);
    expect(overview.perDay).toEqual([{ date: "2026-07-09", costUsd: 10, sessionCount: 1 }]);
  });

  it("marks the rollup incomplete when ANY row has unpriced usage", () => {
    const overview = computeFilteredOverview([claudeItem, { ...codexItem, costIsComplete: false }]);
    expect(overview.costIsComplete).toBe(false);
  });

  it("merges per-model usage across rows and sorts cost-descending", () => {
    const secondClaude: ClaudeSessionListItem = {
      ...claudeItem,
      sessionId: "s3",
      usageByModel: [
        {
          model: "claude-fable-5",
          costUsd: 1,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheCreationTokens: 0,
        },
        {
          model: "claude-haiku-4-5",
          costUsd: 20,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    };
    const overview = computeFilteredOverview([claudeItem, secondClaude]);
    expect(overview.byModel.map((m) => m.model)).toEqual(["claude-haiku-4-5", "claude-fable-5"]);
    expect(overview.byModel[1]).toEqual({
      model: "claude-fable-5",
      costUsd: 9,
      inputTokens: 110,
      outputTokens: 55,
      cacheReadTokens: 11,
      cacheCreationTokens: 5,
    });
  });

  it("keeps a model's merged costUsd undefined-free only when priced — an unpriced model carries no costUsd key", () => {
    const unpriced: ClaudeSessionListItem = {
      ...claudeItem,
      sessionId: "s4",
      usageByModel: [
        {
          model: "mystery-model",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    };
    const overview = computeFilteredOverview([unpriced]);
    expect(overview.byModel[0]?.costUsd).toBeUndefined();
  });

  it("buckets per-day by the UTC calendar day of startedAt, date-ascending", () => {
    const lateSameDayUtc: CodexSessionListItem = {
      ...codexItem,
      sessionId: "s5",
      startedAt: "2026-07-10T23:59:59.000Z",
      totalCostUsd: 7,
    };
    const overview = computeFilteredOverview([codexItem, lateSameDayUtc, claudeItem]);
    expect(overview.perDay).toEqual([
      { date: "2026-07-09", costUsd: 10, sessionCount: 1 },
      { date: "2026-07-10", costUsd: 10, sessionCount: 2 },
    ]);
  });

  it("counts a row with no startedAt in the totals but under no day bucket", () => {
    const { startedAt: _dropped, ...rest } = claudeItem;
    const noStart: ClaudeSessionListItem = rest;
    const overview = computeFilteredOverview([noStart]);
    expect(overview.sessionCount).toBe(1);
    expect(overview.totalCostUsd).toBe(10);
    expect(overview.perDay).toEqual([]);
  });

  it("sums the delegation split, propagating an unpriced scope to undefined", () => {
    const overview = computeFilteredOverview([claudeItem, codexItem]);
    expect(overview.delegation).toEqual({
      main: { tokens: 1300, costUsd: 11 },
      subagents: { tokens: 200, costUsd: 2 },
    });

    const unpricedMain: CodexSessionListItem = {
      ...codexItem,
      sessionId: "s6",
      delegation: { main: { tokens: 100 }, subagents: { tokens: 0, costUsd: 0 } },
    };
    const withUnpriced = computeFilteredOverview([claudeItem, unpricedMain]);
    expect(withUnpriced.delegation.main).toEqual({ tokens: 900 });
    expect(withUnpriced.delegation.subagents).toEqual({ tokens: 200, costUsd: 2 });
  });

  it("returns an empty, complete rollup for zero rows (a filter that matches nothing)", () => {
    const overview = computeFilteredOverview([]);
    expect(overview).toEqual({
      sessionCount: 0,
      sourceCounts: { "claude-code": 0, codex: 0 },
      totalCostUsd: 0,
      costIsComplete: true,
      byModel: [],
      perDay: [],
      delegation: { main: { tokens: 0, costUsd: 0 }, subagents: { tokens: 0, costUsd: 0 } },
    });
  });
});

describe("topModelShare", () => {
  it("picks the costliest priced model and its share of total cost", () => {
    const result = topModelShare({
      totalCostUsd: 100,
      byModel: [
        {
          model: "cheap",
          costUsd: 10,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          model: "pricey",
          costUsd: 63,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result).toEqual({ model: "pricey", shortLabel: "pricey", costUsd: 63, pct: 63 });
  });

  it("resolves a known model family to its short label", () => {
    const result = topModelShare({
      totalCostUsd: 10,
      byModel: [
        {
          model: "claude-fable-5",
          costUsd: 10,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result?.shortLabel).toBe("fable 5");
  });

  it("ignores unpriced models when picking the top one", () => {
    const result = topModelShare({
      totalCostUsd: 5,
      byModel: [
        {
          model: "unpriced",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          model: "priced",
          costUsd: 5,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result?.model).toBe("priced");
  });

  it("returns undefined when there's no priced usage at all", () => {
    const result = topModelShare({
      totalCostUsd: 0,
      byModel: [
        {
          model: "unpriced",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty byModel list", () => {
    expect(topModelShare({ totalCostUsd: 0, byModel: [] })).toBeUndefined();
  });
});

describe("dayBars", () => {
  it("scales each day's bar height relative to the window's costliest day", () => {
    const bars = dayBars([
      { date: "2026-07-08", costUsd: 50, sessionCount: 2 },
      { date: "2026-07-09", costUsd: 100, sessionCount: 3 },
      { date: "2026-07-10", costUsd: 25, sessionCount: 1 },
    ]);
    expect(bars).toEqual([
      { date: "2026-07-08", costUsd: 50, sessionCount: 2, heightPct: 50 },
      { date: "2026-07-09", costUsd: 100, sessionCount: 3, heightPct: 100 },
      { date: "2026-07-10", costUsd: 25, sessionCount: 1, heightPct: 25 },
    ]);
  });

  it("returns 0% heights (not NaN/Infinity) when every day is $0", () => {
    const bars = dayBars([{ date: "2026-07-08", costUsd: 0, sessionCount: 1 }]);
    expect(bars).toEqual([{ date: "2026-07-08", costUsd: 0, sessionCount: 1, heightPct: 0 }]);
  });

  it("returns [] for an empty window", () => {
    expect(dayBars([])).toEqual([]);
  });
});

describe("formatUtcDayLabel", () => {
  it("formats a YYYY-MM-DD key as a short UTC month/day label", () => {
    expect(formatUtcDayLabel("2026-07-09")).toBe("Jul 9");
  });

  it("stays anchored to UTC regardless of local timezone (no off-by-one date drift)", () => {
    // Dec 31 / Jan 1 boundary — the case most likely to shift under a
    // timezone-naive implementation.
    expect(formatUtcDayLabel("2025-12-31")).toBe("Dec 31");
    expect(formatUtcDayLabel("2026-01-01")).toBe("Jan 1");
  });

  it("returns the raw key unchanged for a malformed input", () => {
    expect(formatUtcDayLabel("not-a-date")).toBe("not-a-date");
  });
});
