import { describe, expect, it } from "vitest";
import {
  computeBashStats,
  LARGE_RESULT_CHARS_THRESHOLD,
  type NeutralBashThread,
  normalizeCommandForDedup,
} from "./bash-stats.js";

/**
 * Direct unit tests for the harness-neutral engine, exercising it with plain
 * `NeutralBashThread` fixtures instead of a real transcript — much cheaper to
 * construct than `SessionData`/`CodexTranscript` fixtures, and this is
 * exactly the layer both `claude/bash-stats.ts` and `codex/bash-stats.ts`
 * delegate to. Most of these cases mirror `claude/bash-stats.test.ts` (which
 * exercises the SAME logic end-to-end through the Claude adapter, and keeps
 * passing unmodified — see that file) so the engine's ranking/waste-detection
 * contract is pinned independently of either adapter.
 */
describe("computeBashStats (shared engine)", () => {
  it("computes totals across every thread's calls", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [
          { id: "c1", line: 1, command: "git status", resultChars: 20 },
          { id: "c2", line: 2, command: "pnpm test", resultChars: 40, isError: true },
        ],
      },
    ];
    const stats = computeBashStats(threads);
    expect(stats.totals).toEqual({
      calls: 2,
      errors: 1,
      inputChars: "git status".length + "pnpm test".length,
      resultChars: 60,
      estimatedTokens: Math.ceil((19 + 60) / 4),
    });
  });

  it("groups by resolved family + subcommand, ranked by totalResultChars desc, with sharePct", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [
          { id: "c1", line: 1, command: "git status", resultChars: 10 },
          { id: "c2", line: 2, command: "git diff --stat", resultChars: 90 },
        ],
      },
    ];
    const stats = computeBashStats(threads);
    expect(stats.byCommand[0]).toMatchObject({
      family: "git",
      subcommand: "diff",
      calls: 1,
      totalResultChars: 90,
      sharePct: 90,
    });
    expect(stats.byCommand[1]).toMatchObject({ family: "git", subcommand: "status", calls: 1 });
  });

  it("ranks heavyHitters across every thread, attributing thread + toolUseId (from NeutralBashCall.id)", () => {
    const threads: NeutralBashThread[] = [
      { thread: "main", calls: [{ id: "m1", line: 1, command: "cat a.log", resultChars: 5 }] },
      {
        thread: "sub1",
        calls: [{ id: "s1", line: 1, command: "cat b.log", resultChars: 500 }],
      },
    ];
    const stats = computeBashStats(threads);
    expect(stats.heavyHitters[0]).toEqual({
      command: "cat b.log",
      family: "cat",
      resultChars: 500,
      line: 1,
      toolUseId: "s1",
      thread: "sub1",
    });
  });

  it("concatenates each thread's pre-resolved background list in thread order, without recomputing it", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [],
        background: [
          {
            taskId: "bg1",
            command: "sleep 30",
            thread: "main",
            launchLine: 1,
            status: "completed",
          },
        ],
      },
      { thread: "sub1", calls: [] },
    ];
    const stats = computeBashStats(threads);
    expect(stats.background).toEqual([
      { taskId: "bg1", command: "sleep 30", thread: "main", launchLine: 1, status: "completed" },
    ]);
  });

  it("flags >=3 occurrences of the same normalized command across threads as a near-duplicate", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [
          { id: "c1", line: 1, command: "pnpm test", resultChars: 1 },
          { id: "c2", line: 2, command: "pnpm test", resultChars: 1 },
        ],
      },
      { thread: "sub1", calls: [{ id: "c3", line: 1, command: "pnpm test", resultChars: 1 }] },
    ];
    const stats = computeBashStats(threads);
    expect(stats.waste.nearDuplicates).toEqual([
      {
        pattern: "pnpm test",
        count: 3,
        examples: ["pnpm test"],
        occurrences: [
          { thread: "main", line: 1, resultChars: 1 },
          { thread: "main", line: 2, resultChars: 1 },
          { thread: "sub1", line: 1, resultChars: 1 },
        ],
      },
    ]);
  });

  it("flags calls at/above the large-result threshold, sorted desc", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [
          {
            id: "c1",
            line: 1,
            command: "pnpm run build:verbose",
            resultChars: LARGE_RESULT_CHARS_THRESHOLD,
          },
        ],
      },
    ];
    const stats = computeBashStats(threads);
    expect(stats.waste.largeResults).toEqual([
      {
        command: "pnpm run build:verbose",
        resultChars: LARGE_RESULT_CHARS_THRESHOLD,
        line: 1,
        thread: "main",
        truncatedByHarness: false,
      },
    ]);
  });

  it("credits a rerun-after-error only within the SAME thread's next 3 calls, never across threads", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [{ id: "c1", line: 5, command: "pnpm test", resultChars: 1, isError: true }],
      },
      {
        thread: "sub1",
        calls: [{ id: "c2", line: 1, command: "pnpm test", resultChars: 1 }],
      },
    ];
    const stats = computeBashStats(threads);
    expect(stats.waste.rerunAfterError).toEqual([]);
  });

  it("credits a rerun-after-error within the same thread's lookahead window", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [
          { id: "c1", line: 5, command: "pnpm test", resultChars: 1, isError: true },
          { id: "c2", line: 6, command: "pnpm test", resultChars: 1 },
        ],
      },
    ];
    const stats = computeBashStats(threads);
    expect(stats.waste.rerunAfterError).toEqual([
      {
        pattern: "pnpm test",
        count: 1,
        occurrences: [{ thread: "main", errorLine: 5, rerunLine: 6, resultChars: 1 }],
      },
    ]);
  });

  it("flags a single-segment cat/sed read as bashAsRead", () => {
    const threads: NeutralBashThread[] = [
      { thread: "main", calls: [{ id: "c1", line: 1, command: "cat foo.log", resultChars: 21 }] },
    ];
    const stats = computeBashStats(threads);
    expect(stats.waste.bashAsRead).toEqual([
      { command: "cat foo.log", resultChars: 21, line: 1, thread: "main" },
    ]);
  });

  it("returns empty stats for an empty thread list", () => {
    const stats = computeBashStats([]);
    expect(stats.totals).toEqual({
      calls: 0,
      errors: 0,
      inputChars: 0,
      resultChars: 0,
      estimatedTokens: 0,
    });
    expect(stats.byCommand).toEqual([]);
    expect(stats.byThread).toEqual([]);
    expect(stats.programFrequency).toEqual([]);
    expect(stats.heavyHitters).toEqual([]);
    expect(stats.background).toEqual([]);
    expect(stats.waste).toEqual({
      nearDuplicates: [],
      largeResults: [],
      rerunAfterError: [],
      bashAsRead: [],
    });
    expect(stats.opportunities).toEqual([]);
  });
});

/**
 * `claude-fable-5` / `claude-haiku-4-5` are real snapshot entries in
 * `./pricing/prices.json` (`input_cost_per_token` 0.00001 / 0.000001 — see
 * `pricing.test.ts` for other tests that lean on the same fixtures) — used
 * here as stand-ins for "a model this engine can price", not because either
 * name is significant.
 */
describe("$ weighting (v2 PR A)", () => {
  const FABLE_INPUT_RATE = 0.00001;
  const HAIKU_INPUT_RATE = 0.000001;

  it("prices a call's resultChars at its thread's model input rate", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [{ id: "c1", line: 1, command: "cat a.log", resultChars: 400 }],
      },
    ];
    const stats = computeBashStats(threads);
    // 400 chars -> ceil(400/4) = 100 tokens -> 100 * 0.00001.
    const expected = 100 * FABLE_INPUT_RATE;
    expect(stats.totals.estUsd).toBe(expected);
    expect(stats.heavyHitters[0]?.estUsd).toBe(expected);
    expect(stats.byCommand[0]?.estUsd).toBe(expected);
  });

  it("leaves estUsd absent (never 0) when the thread has no model, or the model has no known pricing", () => {
    const noModel: NeutralBashThread[] = [
      { thread: "main", calls: [{ id: "c1", line: 1, command: "cat a.log", resultChars: 400 }] },
    ];
    const noModelStats = computeBashStats(noModel);
    expect(noModelStats.totals.estUsd).toBeUndefined();
    expect(noModelStats.totals).not.toHaveProperty("estUsd");
    expect(noModelStats.heavyHitters[0]).not.toHaveProperty("estUsd");
    expect(noModelStats.byCommand[0]).not.toHaveProperty("estUsd");

    const unknownModel: NeutralBashThread[] = [
      {
        thread: "main",
        model: "totally-unpriced-model-xyz",
        calls: [{ id: "c1", line: 1, command: "cat a.log", resultChars: 400 }],
      },
    ];
    const unknownStats = computeBashStats(unknownModel);
    expect(unknownStats.totals.estUsd).toBeUndefined();
    expect(unknownStats.heavyHitters[0]).not.toHaveProperty("estUsd");
  });

  it("builds a per-thread rollup (byThread), ranked by resultChars desc, with charsSharePct/usdSharePct", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [
          { id: "m1", line: 1, command: "git status", resultChars: 40 },
          { id: "m2", line: 2, command: "pnpm test", resultChars: 40, isError: true },
        ],
      },
      {
        thread: "sub1",
        model: "claude-haiku-4-5",
        calls: [{ id: "s1", line: 1, command: "cat b.log", resultChars: 4000 }],
      },
    ];
    const stats = computeBashStats(threads);

    expect(stats.byThread).toEqual([
      {
        thread: "sub1",
        model: "claude-haiku-4-5",
        calls: 1,
        errors: 0,
        inputChars: "cat b.log".length,
        resultChars: 4000,
        estimatedTokens: Math.ceil(("cat b.log".length + 4000) / 4),
        estUsd: 1000 * HAIKU_INPUT_RATE,
        charsSharePct: 98,
        usdSharePct: 83.3,
      },
      {
        thread: "main",
        model: "claude-fable-5",
        calls: 2,
        errors: 1,
        inputChars: "git status".length + "pnpm test".length,
        resultChars: 80,
        estimatedTokens: Math.ceil(("git status".length + "pnpm test".length + 80) / 4),
        estUsd: 20 * FABLE_INPUT_RATE,
        charsSharePct: 2,
        usdSharePct: 16.7,
      },
    ]);
  });

  it("computes byCommand.orchestratorSharePct as the group's share of chars that sat in the main thread", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        calls: [{ id: "m1", line: 1, command: "git diff --stat", resultChars: 30 }],
      },
      {
        thread: "sub1",
        calls: [{ id: "s1", line: 1, command: "git diff --stat", resultChars: 70 }],
      },
    ];
    const stats = computeBashStats(threads);
    const group = stats.byCommand.find((g) => g.family === "git" && g.subcommand === "diff");
    expect(group?.orchestratorSharePct).toBe(30);

    const mainOnly = computeBashStats([
      { thread: "main", calls: [{ id: "m1", line: 1, command: "pnpm lint", resultChars: 10 }] },
    ]);
    expect(mainOnly.byCommand[0]?.orchestratorSharePct).toBe(100);

    const subOnly = computeBashStats([
      { thread: "sub1", calls: [{ id: "s1", line: 1, command: "pnpm lint", resultChars: 10 }] },
    ]);
    expect(subOnly.byCommand[0]?.orchestratorSharePct).toBe(0);
  });

  it("excludes a placeholder-result call from estUsd sums, but keeps its chars in totals/heavyHitters and marks the entry", () => {
    const threads: NeutralBashThread[] = [
      {
        thread: "main",
        model: "claude-fable-5",
        calls: [
          {
            id: "c1",
            line: 1,
            command: "pytest tests/",
            resultChars: 19,
            isError: true,
            resultIsPlaceholder: true,
          },
          { id: "c2", line: 2, command: "cat a.log", resultChars: 400 },
        ],
      },
    ];
    const stats = computeBashStats(threads);

    // Chars are unaffected by the placeholder flag — still counted normally.
    expect(stats.totals.resultChars).toBe(419);
    // Only c2 (400 chars -> 100 tokens) is priced; c1's 19 chars are excluded.
    expect(stats.totals.estUsd).toBe(100 * FABLE_INPUT_RATE);

    const c1 = stats.heavyHitters.find((h) => h.toolUseId === "c1");
    expect(c1).toMatchObject({ resultChars: 19, resultIsPlaceholder: true });
    expect(c1).not.toHaveProperty("estUsd");

    const c2 = stats.heavyHitters.find((h) => h.toolUseId === "c2");
    expect(c2?.estUsd).toBe(100 * FABLE_INPUT_RATE);
    expect(c2).not.toHaveProperty("resultIsPlaceholder");
  });
});

describe("normalizeCommandForDedup", () => {
  it("collapses a quoted string, a number, and a path to placeholders", () => {
    expect(normalizeCommandForDedup('git commit -m "fix bug 1"')).toBe("git commit -m <STR>");
    expect(normalizeCommandForDedup("sleep 30 && pnpm build")).toBe("sleep <NUM> && pnpm build");
    expect(normalizeCommandForDedup("cat /tmp/foo.log")).toBe("cat <PATH>");
  });
});
