import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeCodexSession } from "./analyze.js";
import type { CodexSessionFileRef } from "./discovery.js";
import { parseCodexTranscriptFile } from "./parser.js";

const MAIN_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/codex/sessions/2026/07/01/rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
);

const REF: CodexSessionFileRef = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  filePath: MAIN_FIXTURE,
  fileTimestamp: "2026-07-01T10-00-00",
  mtimeMs: 0,
  sizeBytes: 0,
  archived: false,
};

async function analyzeFixture() {
  const transcript = await parseCodexTranscriptFile(MAIN_FIXTURE);
  return analyzeCodexSession(REF, transcript);
}

async function analyzeFixtureAt(relativePath: string, sessionId: string) {
  const filePath = join(dirname(fileURLToPath(import.meta.url)), relativePath);
  const transcript = await parseCodexTranscriptFile(filePath);
  return analyzeCodexSession(
    { sessionId, filePath, fileTimestamp: "", mtimeMs: 0, sizeBytes: 0, archived: false },
    transcript,
  );
}

describe("analyzeCodexSession", () => {
  it("computes identity/meta fields from session_meta and the latest thread_name_updated", async () => {
    const analysis = await analyzeFixture();

    expect(analysis.source).toBe("codex");
    expect(analysis.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(analysis.cwd).toBe("/Users/test/codex-proj");
    expect(analysis.gitBranch).toBe("main");
    expect(analysis.title).toBe("Fix flaky test");
    expect(analysis.startedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(analysis.endedAt).toBe("2026-07-01T10:00:14.500Z");
    expect(analysis.durationMs).toBe(14_500);
    expect(analysis.parseWarningCount).toBe(1);

    expect(analysis.codex.originator).toBe("codex_cli_rs");
    expect(analysis.codex.cliVersion).toBe("0.55.0");
    expect(analysis.codex.agentRole).toBe("reviewer");
    expect(analysis.codex.archived).toBe(false);
  });

  it("counts user turns from user_message events and captures the first prompt", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.userTurnCount).toBe(2);
    expect(analysis.firstUserPrompt).toBe("Fix the flaky test in foo.spec.ts");
    expect(analysis.firstUserPromptLine).toBe(4);
  });

  it("prefers user_message events over earlier role:user response_items for the first prompt", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/02/rollout-2026-07-02T09-00-00-22222222-2222-2222-2222-222222222222.jsonl",
      "22222222-2222-2222-2222-222222222222",
    );
    expect(analysis.firstUserPrompt).toBe("Real prompt via event");
    expect(analysis.firstUserPromptLine).toBe(5);
    expect(analysis.userTurnCount).toBe(1);
  });

  it("skips repeated token_count emissions whose cumulative total is unchanged", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/02/rollout-2026-07-02T09-00-00-22222222-2222-2222-2222-222222222222.jsonl",
      "22222222-2222-2222-2222-222222222222",
    );
    // Line 7 repeats line 6's cumulative total and must not be double-counted;
    // line 8 advances it and must be.
    expect(analysis.totalUsage.inputTokens).toBe(130);
    expect(analysis.totalUsage.cacheReadTokens).toBe(20);
    expect(analysis.totalUsage.outputTokens).toBe(15);
    expect(analysis.contextTimeline).toHaveLength(2);
  });

  it("closes an interrupted turn from turn_aborted, keeping its duration", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/02/rollout-2026-07-02T09-00-00-22222222-2222-2222-2222-222222222222.jsonl",
      "22222222-2222-2222-2222-222222222222",
    );
    const aborted = analysis.codex.turns.at(-1);
    expect(aborted?.durationMs).toBe(1234);
    expect(aborted?.endedAt).toBe("2026-07-02T09:00:05.000Z");
  });

  it("falls back to response_items when no user_message events exist, skipping injected context", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/02/rollout-2026-07-02T09-30-00-33333333-3333-3333-3333-333333333333.jsonl",
      "33333333-3333-3333-3333-333333333333",
    );
    expect(analysis.firstUserPrompt).toBe("Fallback prompt");
    expect(analysis.firstUserPromptLine).toBe(3);
    expect(analysis.userTurnCount).toBe(1);
  });

  it("lists distinct turn_context models in order of appearance", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.models).toEqual(["claude-sonnet-4-5", "gpt-5.5"]);
  });

  it("maps last_token_usage deltas into repo TokenUsage semantics, per model", async () => {
    const analysis = await analyzeFixture();

    const sonnet = analysis.usage.byModel.find((m) => m.model === "claude-sonnet-4-5");
    expect(sonnet).toBeDefined();
    // input_tokens(1000) - cached_input_tokens(200) = 800, floored at 0.
    expect(sonnet?.inputTokens).toBe(800);
    expect(sonnet?.outputTokens).toBe(300);
    expect(sonnet?.cacheReadTokens).toBe(200);
    expect(sonnet?.cacheCreationTokens).toBe(0);
    expect(sonnet?.messageCount).toBe(1);
    // claude-sonnet-4-5 has known pricing, so this model's slice is priced.
    expect(sonnet?.costUsd).toBeGreaterThan(0);

    const gpt = analysis.usage.byModel.find((m) => m.model === "gpt-5.5");
    expect(gpt).toBeDefined();
    expect(gpt?.inputTokens).toBe(400);
    expect(gpt?.outputTokens).toBe(150);
    expect(gpt?.cacheReadTokens).toBe(100);
    // No pricing entry for "gpt-5.5" — cost is left undefined, not faked as 0.
    expect(gpt?.costUsd).toBeUndefined();

    // The session overall is NOT fully priced, because of the unpriced model.
    expect(analysis.totalUsage.costIsComplete).toBe(false);
    expect(analysis.totalUsage.inputTokens).toBe(1200);
    expect(analysis.totalUsage.outputTokens).toBe(450);
    expect(analysis.totalUsage.cacheReadTokens).toBe(300);

    expect(analysis.codex.reasoningOutputTokens).toBe(70);
  });

  it("builds per-turn usage from turn_context/task_started..task_complete pairs", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.codex.turns).toHaveLength(2);

    const [turn1, turn2] = analysis.codex.turns;
    expect(turn1).toMatchObject({
      turnId: "turn-1",
      model: "claude-sonnet-4-5",
      startedAt: "2026-07-01T10:00:01.000Z",
      endedAt: "2026-07-01T10:00:09.000Z",
      durationMs: 7000,
      inputTokens: 800,
      outputTokens: 300,
      cacheReadTokens: 200,
      reasoningOutputTokens: 50,
    });
    expect(turn2).toMatchObject({
      turnId: "turn-2",
      model: "gpt-5.5",
      startedAt: "2026-07-01T10:00:10.000Z",
      endedAt: "2026-07-01T10:00:13.000Z",
      durationMs: 3000,
      inputTokens: 400,
      outputTokens: 150,
      cacheReadTokens: 100,
      reasoningOutputTokens: 20,
    });
  });

  it("builds a contextTimeline from token_count events with usable info", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.contextTimeline).toHaveLength(2);
    expect(analysis.contextTimeline[0]).toMatchObject({
      line: 9,
      contextTokens: 1550,
      outputTokens: 300,
      timestamp: "2026-07-01T10:00:06.000Z",
    });
    expect(analysis.contextTimeline[1]).toMatchObject({
      line: 19,
      contextTokens: 3020,
      outputTokens: 150,
    });
  });

  it("records the compacted envelope as a compaction event", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.compactions).toEqual([{ line: 22, timestamp: "2026-07-01T10:00:14.000Z" }]);
  });

  it("links tool calls by call_id and flags errors via output text, structured success, and exec_command_end exit codes", async () => {
    const analysis = await analyzeFixture();
    // call-1 (function_call, errored output), call-2 (custom_tool_call, ok),
    // call-3 (local_shell_call, errored via exec_command_end) => 3 calls, 2 errors.
    expect(analysis.codex.toolCallCount).toBe(3);
    expect(analysis.codex.toolErrorCount).toBe(2);
  });

  it("carries the latest token_count rate_limits snapshot through as-is", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.codex.rateLimits).toEqual({ primary: { used_percent: 10 } });
  });
});
