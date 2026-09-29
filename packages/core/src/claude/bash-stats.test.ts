import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeBashStats,
  LARGE_RESULT_CHARS_THRESHOLD,
  normalizeCommandForDedup,
} from "./bash-stats.js";
import { parseClaudeTranscriptFile } from "./parser.js";
import type { SessionData, ToolCall } from "./session-data.js";
import { buildSessionData } from "./session-data.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/bash-stats",
);

async function loadData(filename: string): Promise<SessionData> {
  const transcript = await parseClaudeTranscriptFile(join(FIXTURES_DIR, filename));
  return buildSessionData(transcript);
}

/** Hand-built `SessionData` for tests that only need `toolCalls` — see `SessionData.filePath`'s doc comment on this being an expected/supported pattern. */
function makeSessionData(toolCalls: ToolCall[]): SessionData {
  return {
    records: [],
    apiMessages: [],
    toolCalls,
    userPrompts: [],
    compactions: [],
    backgroundLaunches: [],
    taskNotifications: [],
    apiErrorCount: 0,
    apiErrors: [],
    warningCount: 0,
  };
}

function bashCall(toolUseId: string, line: number, command: string): ToolCall {
  return { toolUseId, name: "Bash", input: { command }, line };
}

describe("computeBashStats", () => {
  describe("main transcript only", () => {
    it("computes totals across every Bash call", async () => {
      const data = await loadData("main.jsonl");
      const stats = computeBashStats([{ thread: "main", data }]);

      expect(stats.totals).toEqual({
        calls: 15,
        errors: 2,
        inputChars: 287,
        resultChars: 20394,
        estimatedTokens: 5171,
      });
    });

    it("groups by resolved family + subcommand, ranked by totalResultChars", async () => {
      const data = await loadData("main.jsonl");
      const stats = computeBashStats([{ thread: "main", data }]);

      // The 20005-char build:verbose call dominates every other group.
      expect(stats.byCommand[0]).toMatchObject({
        family: "pnpm",
        subcommand: "run",
        calls: 1,
        totalResultChars: 20005,
        sharePct: 98.1,
      });

      const byKey = new Map(stats.byCommand.map((g) => [`${g.family}:${g.subcommand ?? ""}`, g]));

      // 3 "pnpm test" calls (1 error, 2 success) fold into one group.
      expect(byKey.get("pnpm:test")).toMatchObject({
        calls: 3,
        errors: 1,
        totalResultChars: 120,
        avgResultChars: 40,
      });

      // Two DIFFERENT commands both primary-attribute to git/diff: the plain
      // `git diff --stat` call and the `git diff | grep -c TODO` pipeline
      // (primaryCommand picks the first non-trivial segment, i.e. the git side).
      expect(byKey.get("git:diff")).toMatchObject({
        calls: 2,
        totalResultChars: 62,
        sampleCommands: ["git diff --stat", "git diff | grep -c TODO"],
      });

      expect(byKey.get("git:status")).toMatchObject({ calls: 1, totalResultChars: 52 });

      // `sleep 30 && pnpm build` used to primary-attribute to `sleep` (the
      // first non-cd segment); `sleep` is now in NEAR_ZERO_OUTPUT_COMMANDS, so
      // attribution skips it and lands on `pnpm build` instead — value moved
      // from "sleep:" to "pnpm:build" because attribution now skips
      // near-zero-output segments (see primaryCommand's contract).
      expect(byKey.get("sleep:")).toBeUndefined();
      expect(byKey.get("pnpm:build")).toMatchObject({ calls: 1, totalResultChars: 48 });

      // cat is not a known command family, so no subcommand is extracted;
      // both the plain `cat` read and the `cat | grep` pipeline (which
      // primary-attributes to its cat side) fold into the same bucket.
      expect(byKey.get("cat:")).toMatchObject({ calls: 2, totalResultChars: 31 });
    });

    it("caps sample commands at 3 distinct entries per group", async () => {
      const data = await loadData("main.jsonl");
      const stats = computeBashStats([{ thread: "main", data }]);
      const pnpmTest = stats.byCommand.find((g) => g.family === "pnpm" && g.subcommand === "test");
      // 3 occurrences of the exact same command -> only 1 distinct sample.
      expect(pnpmTest?.sampleCommands).toEqual(["pnpm test"]);
    });

    it("counts every segment's resolved executable, including both sides of a pipeline", async () => {
      const data = await loadData("main.jsonl");
      const stats = computeBashStats([{ thread: "main", data }]);
      const byProgram = new Map(stats.programFrequency.map((p) => [p.program, p.count]));

      // pnpm: 3x "pnpm test" + "pnpm build" (2nd half of the sleep && chain)
      // + "pnpm run build:verbose" + "pnpm lint" = 6.
      expect(byProgram.get("pnpm")).toBe(6);
      // git: "git status" + "git diff --stat" + "git diff" (pipeline half) = 3.
      expect(byProgram.get("git")).toBe(3);
      // grep appears only as the SECOND half of two pipelines, never as the
      // primary command, yet still gets counted here.
      expect(byProgram.get("grep")).toBe(2);
      // `env FOO=bar node script.js` resolves through the env wrapper to
      // node — env itself is not counted as a program.
      expect(byProgram.get("env")).toBeUndefined();
      expect(byProgram.get("node")).toBe(1);
      // `find ... | xargs -I{} rm {}` resolves xargs's wrapped command to rm.
      expect(byProgram.get("find")).toBe(1);
      expect(byProgram.get("rm")).toBe(1);
      expect(byProgram.get("xargs")).toBeUndefined();
      // `nice -n 10 make build` resolves through the nice wrapper to make.
      expect(byProgram.get("make")).toBe(1);
      expect(byProgram.get("nice")).toBeUndefined();

      const total = stats.programFrequency.reduce((sum, p) => sum + p.count, 0);
      expect(total).toBe(19);
    });

    it("ranks the top 10 calls by resultChars as heavyHitters", async () => {
      const data = await loadData("main.jsonl");
      const stats = computeBashStats([{ thread: "main", data }]);

      expect(stats.heavyHitters).toHaveLength(10);
      expect(stats.heavyHitters[0]).toEqual({
        command: "pnpm run build:verbose",
        family: "pnpm",
        resultChars: 20005,
        line: 23,
        toolUseId: "toolu_large1",
        thread: "main",
      });
      // Strictly descending by resultChars.
      for (let i = 1; i < stats.heavyHitters.length; i += 1) {
        const prev = stats.heavyHitters[i - 1];
        const cur = stats.heavyHitters[i];
        expect(prev?.resultChars ?? 0).toBeGreaterThanOrEqual(cur?.resultChars ?? 0);
      }
    });

    it("joins a background Bash launch to its completion notification via taskId", async () => {
      const data = await loadData("main.jsonl");
      const stats = computeBashStats([{ thread: "main", data }]);

      expect(stats.background).toEqual([
        {
          taskId: "bg_task_1",
          command: "sleep 30 && pnpm build",
          thread: "main",
          launchLine: 21,
          completionLine: 22,
          wallClockMs: 51_000,
          status: "completed",
        },
      ]);
      // Background wallclock never leaks into ranking-like totals.
      expect(stats.totals).not.toHaveProperty("wallClockMs");
      expect(stats.byCommand.every((g) => !("wallClockMs" in g))).toBe(true);
    });

    describe("waste", () => {
      it("groups >=3 occurrences of the same normalized command as a near-duplicate", async () => {
        const data = await loadData("main.jsonl");
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.nearDuplicates).toEqual([
          {
            pattern: "pnpm test",
            count: 3,
            examples: ["pnpm test"],
            occurrences: [
              { thread: "main", line: 6, resultChars: 46, command: "pnpm test" },
              { thread: "main", line: 8, resultChars: 37, command: "pnpm test" },
              { thread: "main", line: 10, resultChars: 37, command: "pnpm test" },
            ],
          },
        ]);
      });

      it("flags calls at or above the large-result threshold", async () => {
        const data = await loadData("main.jsonl");
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.largeResults).toEqual([
          {
            command: "pnpm run build:verbose",
            resultChars: 20_005,
            line: 23,
            thread: "main",
            truncatedByHarness: false,
          },
        ]);
        expect(stats.waste.largeResults[0]?.resultChars).toBeGreaterThanOrEqual(
          LARGE_RESULT_CHARS_THRESHOLD,
        );
      });

      it("credits exactly one rerun-after-error occurrence for the immediate pnpm test retry", async () => {
        const data = await loadData("main.jsonl");
        const stats = computeBashStats([{ thread: "main", data }]);
        // The error is at line 6 (toolu_3); the very next Bash call (line 8,
        // toolu_4) is the same command and succeeds. The THIRD "pnpm test"
        // (line 10) is not separately credited — only one rerun is credited
        // per failing call.
        expect(stats.waste.rerunAfterError).toEqual([
          {
            pattern: "pnpm test",
            count: 1,
            occurrences: [{ thread: "main", errorLine: 6, rerunLine: 8, resultChars: 37 }],
          },
        ]);
      });

      it("does not credit a rerun for a trailing error with nothing after it", async () => {
        const data = await loadData("main.jsonl");
        const stats = computeBashStats([{ thread: "main", data }]);
        // `pnpm lint` errors at the very last Bash call (line 31) — no
        // subsequent call exists to look ahead into.
        const lintRerun = stats.waste.rerunAfterError.find((r) => r.pattern === "pnpm lint");
        expect(lintRerun).toBeUndefined();
      });

      it("flags single-segment cat/sed reads as bashAsRead, but not a multi-segment pipeline", async () => {
        const data = await loadData("main.jsonl");
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([
          { command: "cat /tmp/foo.log", resultChars: 21, line: 12, thread: "main" },
          {
            command: "sed -n '10,20p' /tmp/foo.log",
            resultChars: 20,
            line: 14,
            thread: "main",
          },
        ]);
        // `cat /tmp/foo.log | grep ERROR` (line 16) is 2 segments -> excluded.
        expect(stats.waste.bashAsRead.some((c) => c.line === 16)).toBe(false);
      });

      it("does not flag head -n 100 with no file arg (stdin, not a Read substitute)", () => {
        const data = makeSessionData([bashCall("toolu_h1", 1, "head -n 100")]);
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([]);
      });

      it("flags head -n 100 foo.log (a real file arg beyond the -n value)", () => {
        const data = makeSessionData([bashCall("toolu_h2", 1, "head -n 100 foo.log")]);
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([
          { command: "head -n 100 foo.log", resultChars: 0, line: 1, thread: "main" },
        ]);
      });

      it("does not flag sed -n '10,20p' with no file arg after the range (stdin)", () => {
        const data = makeSessionData([bashCall("toolu_s1", 1, "sed -n '10,20p'")]);
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([]);
      });

      it("does not flag a redirecting cat — its output never reaches the agent, even though foo.log is still read", () => {
        const data = makeSessionData([bashCall("toolu_h3", 1, "cat foo.log>out.txt")]);
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([]);
      });

      it("flags a stderr-only redirect — stdout (the file content) still reaches the agent", () => {
        const data = makeSessionData([bashCall("toolu_h4", 1, "cat foo.log 2>/dev/null")]);
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([
          { command: "cat foo.log 2>/dev/null", resultChars: 0, line: 1, thread: "main" },
        ]);
      });

      it("flags head -n100 foo.log (attached-value -n form, a real file arg beyond the flag's value)", () => {
        const data = makeSessionData([bashCall("toolu_h5", 1, "head -n100 foo.log")]);
        const stats = computeBashStats([{ thread: "main", data }]);
        expect(stats.waste.bashAsRead).toEqual([
          { command: "head -n100 foo.log", resultChars: 0, line: 1, thread: "main" },
        ]);
      });
    });
  });

  describe("main + subagent folding", () => {
    it("keeps per-thread attribution while combining totals across threads", async () => {
      const mainData = await loadData("main.jsonl");
      const subData = await loadData("subagent.jsonl");
      const stats = computeBashStats([
        { thread: "main", data: mainData },
        { thread: "sub1", data: subData },
      ]);

      expect(stats.totals.calls).toBe(17);
      expect(stats.totals.inputChars).toBe(305);
      expect(stats.totals.resultChars).toBe(20_427);

      const docker = stats.byCommand.find((g) => g.family === "docker");
      expect(docker).toMatchObject({ subcommand: "ps", calls: 1, totalResultChars: 20 });

      const dockerHeavyHitter = stats.heavyHitters.find((h) => h.family === "docker");
      // docker ps (20 chars) doesn't crack the top 10 among these fixtures.
      expect(dockerHeavyHitter).toBeUndefined();
    });

    it("folds cross-thread occurrences of the same normalized command into one near-duplicate group", async () => {
      const mainData = await loadData("main.jsonl");
      const subData = await loadData("subagent.jsonl");
      const stats = computeBashStats([
        { thread: "main", data: mainData },
        { thread: "sub1", data: subData },
      ]);

      const pnpmTest = stats.waste.nearDuplicates.find((g) => g.pattern === "pnpm test");
      // 3 from main + 1 from the subagent thread.
      expect(pnpmTest?.count).toBe(4);
      expect(pnpmTest?.occurrences).toEqual([
        { thread: "main", line: 6, resultChars: 46, command: "pnpm test" },
        { thread: "main", line: 8, resultChars: 37, command: "pnpm test" },
        { thread: "main", line: 10, resultChars: 37, command: "pnpm test" },
        { thread: "sub1", line: 2, resultChars: 13, command: "pnpm test" },
      ]);
    });

    it("does not look across threads for rerunAfterError (a subagent's own error only looks at its own next calls)", async () => {
      const mainData = await loadData("main.jsonl");
      const subData = await loadData("subagent.jsonl");
      const stats = computeBashStats([
        { thread: "main", data: mainData },
        { thread: "sub1", data: subData },
      ]);
      // Still exactly one occurrence overall — the subagent thread has no
      // errors of its own, so it contributes nothing new here.
      expect(stats.waste.rerunAfterError).toEqual([
        {
          pattern: "pnpm test",
          count: 1,
          occurrences: [{ thread: "main", errorLine: 6, rerunLine: 8, resultChars: 37 }],
        },
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
});

describe("normalizeCommandForDedup", () => {
  it("collapses a single-quoted string to a placeholder", () => {
    expect(normalizeCommandForDedup("echo 'hello world'")).toBe("echo <STR>");
  });

  it("collapses a double-quoted string to a placeholder", () => {
    expect(normalizeCommandForDedup('git commit -m "fix bug 1"')).toBe("git commit -m <STR>");
  });

  it("normalizes two commands that only differ by their quoted message identically", () => {
    const a = normalizeCommandForDedup('git commit -m "fix bug 1"');
    const b = normalizeCommandForDedup('git commit -m "fix bug 2"');
    expect(a).toBe(b);
  });

  it("collapses standalone numbers to a placeholder", () => {
    expect(normalizeCommandForDedup("sleep 30 && pnpm build")).toBe("sleep <NUM> && pnpm build");
  });

  it("collapses path-like tokens to a placeholder", () => {
    expect(normalizeCommandForDedup("cat /tmp/foo.log")).toBe("cat <PATH>");
  });

  it("normalizes two commands that only differ by a numbered path identically", () => {
    const a = normalizeCommandForDedup("cat /tmp/foo123.log");
    const b = normalizeCommandForDedup("cat /tmp/bar456.log");
    expect(a).toBe(b);
  });

  it("collapses internal whitespace after substitution", () => {
    expect(normalizeCommandForDedup("echo   'a'   'b'")).toBe("echo <STR> <STR>");
  });

  it("leaves a plain command with no quotes/numbers/paths unchanged", () => {
    expect(normalizeCommandForDedup("git status")).toBe("git status");
  });
});
