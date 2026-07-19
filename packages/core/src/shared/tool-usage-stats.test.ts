import { describe, expect, it } from "vitest";
import { computeToolUsageStats, type NeutralToolThread } from "./tool-usage-stats.js";

/**
 * Direct unit tests for the harness-neutral cross-tool engine, exercising it
 * with plain `NeutralToolThread` fixtures (much cheaper than real
 * `SessionData`/`CodexTranscript`). This is the layer both
 * `claude/tool-usage-stats.ts` and `codex/tool-usage-stats.ts` delegate to.
 *
 * `claude-fable-5` / `claude-haiku-4-5` are real snapshot entries in
 * `./pricing/prices.json` (`input_cost_per_token` 0.00001 / 0.000001) — the
 * same stand-in models the Bash engine's tests use.
 */
const FABLE_INPUT_RATE = 0.00001;
const HAIKU_INPUT_RATE = 0.000001;

describe("computeToolUsageStats (shared engine)", () => {
  it("returns empty rollups for an empty session (no threads, or threads with no calls)", () => {
    expect(computeToolUsageStats([])).toEqual({
      totals: { calls: 0, errors: 0, resultChars: 0, estimatedTokens: 0 },
      byTool: [],
      byThread: [],
      heavyHitters: [],
    });
    const emptyThread = computeToolUsageStats([{ thread: "main", calls: [] }]);
    expect(emptyThread.totals.calls).toBe(0);
    expect(emptyThread.byTool).toEqual([]);
    expect(emptyThread.byThread).toEqual([]);
  });

  it("aggregates totals across every thread's calls (result chars only, no inputChars)", () => {
    const threads: NeutralToolThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [
          { id: "m1", line: 1, tool: "Read", resultChars: 20 },
          { id: "m2", line: 2, tool: "Bash", resultChars: 40, isError: true },
        ],
      },
      {
        thread: "sub1",
        model: "claude-haiku-4-5",
        calls: [{ id: "s1", line: 1, tool: "Read", resultChars: 100 }],
      },
    ];
    const stats = computeToolUsageStats(threads);
    expect(stats.totals).toMatchObject({
      calls: 3,
      errors: 1,
      resultChars: 160,
      estimatedTokens: Math.ceil(160 / 4),
    });
    // Partial $ sum: main's two calls at fable + sub1's one at haiku.
    expect(stats.totals.estUsd).toBeCloseTo(
      (Math.ceil(20 / 4) + Math.ceil(40 / 4)) * FABLE_INPUT_RATE +
        Math.ceil(100 / 4) * HAIKU_INPUT_RATE,
      12,
    );
    // No inputChars field on totals.
    expect(stats.totals).not.toHaveProperty("inputChars");
  });

  it("groups byTool with a per-category error tally that sums to the tool's error count", () => {
    const threads: NeutralToolThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [
          {
            id: "b1",
            line: 1,
            tool: "Bash",
            resultChars: 10,
            isError: true,
            errorCategory: "command-failed",
          },
          {
            id: "b2",
            line: 2,
            tool: "Bash",
            resultChars: 10,
            isError: true,
            errorCategory: "command-failed",
          },
          {
            id: "b3",
            line: 3,
            tool: "Bash",
            resultChars: 10,
            isError: true,
            errorCategory: "timeout",
          },
          { id: "b4", line: 4, tool: "Bash", resultChars: 10 },
          {
            id: "e1",
            line: 5,
            tool: "Edit",
            resultChars: 10,
            isError: true,
            errorCategory: "string-not-found",
          },
          // Errored but no category → tallies under "other".
          { id: "e2", line: 6, tool: "Edit", resultChars: 10, isError: true },
        ],
      },
    ];
    const stats = computeToolUsageStats(threads);
    const bash = stats.byTool.find((t) => t.name === "Bash");
    const edit = stats.byTool.find((t) => t.name === "Edit");
    expect(bash).toMatchObject({ calls: 4, errors: 3 });
    expect(bash?.errorCategories).toEqual({ "command-failed": 2, timeout: 1 });
    // Values sum to the tool's error count.
    expect(Object.values(bash?.errorCategories ?? {}).reduce((a, b) => a + b, 0)).toBe(
      bash?.errors,
    );
    expect(edit).toMatchObject({ calls: 2, errors: 2 });
    expect(edit?.errorCategories).toEqual({ "string-not-found": 1, other: 1 });
  });

  it("sorts byTool by estUsd desc, with sharePct that sums to ~100 across priced+unpriced tools", () => {
    const threads: NeutralToolThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [
          { id: "r1", line: 1, tool: "Read", resultChars: 100 },
          { id: "w1", line: 2, tool: "WebFetch", resultChars: 300 },
          { id: "g1", line: 3, tool: "Grep", resultChars: 100 },
        ],
      },
    ];
    const stats = computeToolUsageStats(threads);
    // WebFetch (300 chars) is the most expensive → first; Read/Grep tie on
    // chars (100) → name asc (Grep before Read).
    expect(stats.byTool.map((t) => t.name)).toEqual(["WebFetch", "Grep", "Read"]);
    const shareSum = stats.byTool.reduce((sum, t) => sum + t.sharePct, 0);
    expect(shareSum).toBeCloseTo(100, 6);
    expect(stats.byTool[0]).toMatchObject({ name: "WebFetch", sharePct: 60 });
  });

  it("computes byTool.orchestratorSharePct as the share of a tool's chars that sat in the main thread", () => {
    const threads: NeutralToolThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [{ id: "m1", line: 1, tool: "Read", resultChars: 30 }],
      },
      {
        thread: "sub1",
        model: "claude-haiku-4-5",
        calls: [{ id: "s1", line: 1, tool: "Read", resultChars: 70 }],
      },
    ];
    const stats = computeToolUsageStats(threads);
    const read = stats.byTool.find((t) => t.name === "Read");
    // 30 of 100 Read chars sat in main.
    expect(read?.orchestratorSharePct).toBe(30);
  });

  it("builds byThread with the BashThreadGroup shape (inputChars always 0), summing shares to ~100", () => {
    const threads: NeutralToolThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [{ id: "m1", line: 1, tool: "Read", resultChars: 20 }],
      },
      {
        thread: "sub1",
        model: "claude-haiku-4-5",
        calls: [{ id: "s1", line: 1, tool: "Read", resultChars: 980 }],
      },
    ];
    const stats = computeToolUsageStats(threads);
    // Ranked by resultChars desc → sub1 first.
    expect(stats.byThread.map((t) => t.thread)).toEqual(["sub1", "main"]);
    for (const row of stats.byThread) {
      expect(row.inputChars).toBe(0);
      // estimatedTokens is result-chars only (inputChars 0).
      expect(row.estimatedTokens).toBe(Math.ceil(row.resultChars / 4));
    }
    const charsShareSum = stats.byThread.reduce((s, t) => s + t.charsSharePct, 0);
    expect(charsShareSum).toBeCloseTo(100, 6);
    const usdShareSum = stats.byThread.reduce((s, t) => s + (t.usdSharePct ?? 0), 0);
    expect(usdShareSum).toBeCloseTo(100, 6);
  });

  it("ranks heavyHitters across every tool and thread, carrying tool/thread/model/line/id provenance", () => {
    const threads: NeutralToolThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [{ id: "m1", line: 7, tool: "Read", resultChars: 5 }],
      },
      {
        thread: "sub1",
        model: "claude-haiku-4-5",
        calls: [{ id: "s1", line: 3, tool: "WebFetch", resultChars: 500 }],
      },
    ];
    const stats = computeToolUsageStats(threads);
    expect(stats.heavyHitters[0]).toEqual({
      tool: "WebFetch",
      thread: "sub1",
      model: "claude-haiku-4-5",
      resultChars: 500,
      estimatedTokens: Math.ceil(500 / 4),
      estUsd: Math.ceil(500 / 4) * HAIKU_INPUT_RATE,
      line: 3,
      id: "s1",
    });
    expect(stats.heavyHitters[1]?.tool).toBe("Read");
  });

  it("caps heavyHitters at 10 across all tools", () => {
    const calls = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`,
      line: i + 1,
      tool: i % 2 === 0 ? "Read" : "Grep",
      resultChars: (15 - i) * 10,
    }));
    const stats = computeToolUsageStats([{ thread: "main", model: "claude-fable-5", calls }]);
    expect(stats.heavyHitters).toHaveLength(10);
    // Sorted by resultChars desc → the first call (150 chars) leads.
    expect(stats.heavyHitters[0]?.resultChars).toBe(150);
  });

  it("leaves estUsd absent (never 0) for an unknown/missing model, and sinks unpriced tools last in byTool", () => {
    const noModel = computeToolUsageStats([
      { thread: "main", calls: [{ id: "c1", line: 1, tool: "Read", resultChars: 400 }] },
    ]);
    expect(noModel.totals.estUsd).toBeUndefined();
    expect(noModel.totals).not.toHaveProperty("estUsd");
    expect(noModel.byTool[0]).not.toHaveProperty("estUsd");
    expect(noModel.heavyHitters[0]).not.toHaveProperty("estUsd");
    expect(noModel.byThread[0]).not.toHaveProperty("estUsd");

    const unknown = computeToolUsageStats([
      {
        thread: "main",
        model: "totally-unpriced-model-xyz",
        calls: [{ id: "c1", line: 1, tool: "Read", resultChars: 400 }],
      },
    ]);
    expect(unknown.totals.estUsd).toBeUndefined();

    // A priced tool ranks above an unpriced one even with fewer chars.
    const mixed = computeToolUsageStats([
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [{ id: "r1", line: 1, tool: "Read", resultChars: 10 }],
      },
      {
        thread: "sub-unpriced",
        model: "totally-unpriced-model-xyz",
        calls: [{ id: "w1", line: 1, tool: "WebFetch", resultChars: 9999 }],
      },
    ]);
    expect(mixed.byTool[0]?.name).toBe("Read");
    expect(mixed.byTool[1]?.name).toBe("WebFetch");
  });

  it("excludes a placeholder-result call from estUsd sums but keeps its chars and marks the entry", () => {
    const stats = computeToolUsageStats([
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [
          { id: "c1", line: 1, tool: "shell", resultChars: 18, resultIsPlaceholder: true },
          { id: "c2", line: 2, tool: "Read", resultChars: 80 },
        ],
      },
    ]);
    // Placeholder chars still count in totals/byTool.
    expect(stats.totals.resultChars).toBe(98);
    // But only Read's chars are priced.
    expect(stats.totals.estUsd).toBeCloseTo(Math.ceil(80 / 4) * FABLE_INPUT_RATE, 12);
    const shell = stats.byTool.find((t) => t.name === "shell");
    expect(shell).not.toHaveProperty("estUsd");
    const placeholderHit = stats.heavyHitters.find((h) => h.id === "c1");
    expect(placeholderHit?.resultIsPlaceholder).toBe(true);
    expect(placeholderHit).not.toHaveProperty("estUsd");
  });
});
