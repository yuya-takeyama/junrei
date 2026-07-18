import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeCodexBashEntries, computeCodexBashStats } from "./bash-stats.js";
import { parseCodexTranscriptFile } from "./parser.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/codex/bash-stats",
);

/**
 * `main.jsonl` (see the fixture itself) exercises every shell-call wire
 * surface `tool-calls.ts`'s module doc comment documents, in call-id order:
 *
 *  - call-1: `function_call` "shell", plain argv `["git","status"]` — no
 *    quoting needed.
 *  - call-2: `function_call` "exec_command", `cmd` STRING form.
 *  - call-3/4: `function_call` "exec_command", `["bash","-lc","pnpm test"]`
 *    wrapper argv — unwraps to "pnpm test". call-3 errors
 *    (`{success:false}`); call-4 (identical command, immediately after) is
 *    the credited rerun-after-error.
 *  - call-5: `function_call` "shell", plain argv WITH a space-containing arg
 *    (`["git","commit","-m","fix bug"]`) — reassembled with quoting.
 *  - call-6: `local_shell_call` + `exec_command_end` pairing (command only
 *    recoverable from the event; exit_code 1 -> isError, synthesized
 *    "exited with code 1" result text since Codex records no real output for
 *    this surface).
 *  - call-7: large result (20000 chars) -> heavyHitters #1 + largeResults.
 *  - call-8: single-segment `cat foo.log` -> bashAsRead.
 *  - call-9: 0.144+ unified exec (`custom_tool_call` "exec") embedding TWO
 *    `tools.exec_command` calls, joined "pwd && ls -la".
 *  - call-10: `custom_tool_call` "apply_patch" — NOT a shell call, must be
 *    excluded entirely.
 */
describe("computeCodexBashEntries / computeCodexBashStats", () => {
  it("extracts exactly the 9 genuine shell calls, excluding apply_patch", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    expect(entries).toHaveLength(9);
    expect(entries.map((e) => e.id)).toEqual([
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
      "call-6",
      "call-7",
      "call-8",
      "call-9",
    ]);
  });

  it("unwraps a bash -lc wrapper argv to the inner command string", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    const call3 = entries.find((e) => e.id === "call-3");
    const call4 = entries.find((e) => e.id === "call-4");
    expect(call3?.command).toBe("pnpm test");
    expect(call4?.command).toBe("pnpm test");
  });

  it("reassembles a plain argv, quoting an argument that contains a space", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    const call5 = entries.find((e) => e.id === "call-5");
    expect(call5?.command).toBe("git commit -m 'fix bug'");
  });

  it("passes a plain argv through unquoted when no argument needs it", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    expect(entries.find((e) => e.id === "call-1")?.command).toBe("git status");
  });

  it("uses the cmd string form as-is (no reassembly)", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    expect(entries.find((e) => e.id === "call-2")?.command).toBe("pnpm test");
  });

  it("recovers a local_shell_call's command from its paired exec_command_end event, and maps a nonzero exit_code to isError", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    const call6 = entries.find((e) => e.id === "call-6");
    expect(call6?.command).toBe("pytest tests/");
    expect(call6?.isError).toBe(true);
    // No real output text exists for this wire surface — resultChars is the
    // synthesized "exited with code 1" placeholder's length, not a real
    // stdout/stderr size. See tool-calls.ts's module doc comment.
    expect(call6?.resultChars).toBe("exited with code 1".length);
  });

  it("maps a structured {success:false} output to isError", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    expect(entries.find((e) => e.id === "call-3")?.isError).toBe(true);
    expect(entries.find((e) => e.id === "call-4")?.isError).toBeFalsy();
  });

  it("joins a 0.144+ unified-exec program's embedded exec_command calls with && ", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexBashEntries(transcript);
    expect(entries.find((e) => e.id === "call-9")?.command).toBe("pwd && ls -la");
  });

  it("computes exact totals across all 9 calls", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexBashStats(transcript);
    expect(stats.totals).toEqual({
      calls: 9,
      errors: 2,
      inputChars: 119,
      resultChars: 20_055,
      estimatedTokens: Math.ceil((119 + 20_055) / 4),
    });
  });

  it("ranks the large-result pnpm run call as heavyHitters[0] and waste.largeResults[0], family resolved via primaryCommand", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexBashStats(transcript);
    expect(stats.heavyHitters[0]).toEqual({
      command: "pnpm run build:verbose",
      family: "pnpm",
      resultChars: 20_000,
      line: 15,
      toolUseId: "call-7",
      thread: "main",
    });
    expect(stats.waste.largeResults).toEqual([
      {
        command: "pnpm run build:verbose",
        resultChars: 20_000,
        line: 15,
        thread: "main",
        truncatedByHarness: false,
      },
    ]);
    const pnpmRun = stats.byCommand.find((g) => g.family === "pnpm" && g.subcommand === "run");
    expect(pnpmRun).toMatchObject({ calls: 1, totalResultChars: 20_000, sharePct: 99.7 });
  });

  it("credits exactly one rerun-after-error for the immediate pnpm test retry (wrapper-unwrapped commands normalize identically)", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexBashStats(transcript);
    expect(stats.waste.rerunAfterError).toEqual([
      {
        pattern: "pnpm test",
        count: 1,
        occurrences: [{ thread: "main", errorLine: 7, rerunLine: 9 }],
      },
    ]);
  });

  it("groups all 3 pnpm-test-normalized calls (cmd-string + 2 wrapper-unwrapped) as a near-duplicate", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexBashStats(transcript);
    const pnpmTest = stats.waste.nearDuplicates.find((g) => g.pattern === "pnpm test");
    expect(pnpmTest).toMatchObject({ pattern: "pnpm test", count: 3 });
  });

  it("flags the single-segment cat call as bashAsRead", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexBashStats(transcript);
    expect(stats.waste.bashAsRead).toEqual([
      { command: "cat foo.log", resultChars: "hello".length, line: 17, thread: "main" },
    ]);
  });

  it("computes stats main-thread-only, with background always empty (Codex has no run_in_background concept)", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexBashStats(transcript);
    expect(stats.background).toEqual([]);
    expect(stats.heavyHitters.every((h) => h.thread === "main")).toBe(true);
  });

  it("returns empty entries for a transcript with no shell calls", async () => {
    const transcript = await parseCodexTranscriptFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../test/fixtures/codex/empty/rollout-2025-03-01T00-00-00-66666666-6666-6666-6666-666666666666.jsonl",
      ),
    );
    expect(computeCodexBashEntries(transcript)).toEqual([]);
  });
});
