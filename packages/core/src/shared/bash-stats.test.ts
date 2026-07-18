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
          { thread: "main", line: 1 },
          { thread: "main", line: 2 },
          { thread: "sub1", line: 1 },
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
        occurrences: [{ thread: "main", errorLine: 5, rerunLine: 6 }],
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
    expect(stats.programFrequency).toEqual([]);
    expect(stats.heavyHitters).toEqual([]);
    expect(stats.background).toEqual([]);
    expect(stats.waste).toEqual({
      nearDuplicates: [],
      largeResults: [],
      rerunAfterError: [],
      bashAsRead: [],
    });
  });
});

describe("normalizeCommandForDedup", () => {
  it("collapses a quoted string, a number, and a path to placeholders", () => {
    expect(normalizeCommandForDedup('git commit -m "fix bug 1"')).toBe("git commit -m <STR>");
    expect(normalizeCommandForDedup("sleep 30 && pnpm build")).toBe("sleep <NUM> && pnpm build");
    expect(normalizeCommandForDedup("cat /tmp/foo.log")).toBe("cat <PATH>");
  });
});
