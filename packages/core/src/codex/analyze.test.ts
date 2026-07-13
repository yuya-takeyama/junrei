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
    // "gpt-5.5" has known pricing (added alongside the OpenAI snapshot for
    // Codex support — see prices.json), so this model's slice is priced too.
    expect(gpt?.costUsd).toBeGreaterThan(0);

    // Both models are now priced, so the session total is fully priced.
    expect(analysis.totalUsage.costIsComplete).toBe(true);
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
    expect(analysis.toolCallCount).toBe(3);
    expect(analysis.toolErrorCount).toBe(2);
  });

  it("carries the latest token_count rate_limits snapshot through as-is", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.codex.rateLimits).toEqual({ primary: { used_percent: 10 } });
  });

  it("attaches this session's own fileAccess (deterministic apply_patch edit), threads 'main' since no sub-agent has been merged in yet", async () => {
    const analysis = await analyzeFixture();
    // Line 10's "*** Update File: foo.spec.ts" — the only file-touching call
    // in this fixture (line 6's "shell pytest foo.spec.ts" isn't a
    // recognized read command). No skill markers appear in either
    // user_message here, so skillInvocations is empty.
    expect(analysis.fileAccess).toEqual([
      {
        path: "/Users/test/codex-proj/foo.spec.ts",
        reads: 0,
        edits: 1,
        firstTouchTimestamp: "2026-07-01T10:00:06.500Z",
        firstTouchLine: 10,
        threads: "main",
      },
    ]);
    expect(analysis.fileAccessTruncated).toBe(false);
    expect(analysis.skillInvocations).toEqual([]);
  });
});

describe("analyzeCodexSession — sub-agent orchestration", () => {
  it("marks a plain (non-subagent) session as isSubagent: false, with no spawnedThreadIds", async () => {
    const analysis = await analyzeFixture();
    expect(analysis.codex.isSubagent).toBe(false);
    expect(analysis.codex.parentThreadId).toBeUndefined();
    expect(analysis.codex.spawnedThreadIds).toEqual([]);
  });

  it("collects collab_agent_spawn_end events into spawnedThreadIds (the parent's own rollout)", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/03/rollout-2026-07-03T09-00-00-77777777-7777-7777-7777-777777777777.jsonl",
      "77777777-7777-7777-7777-777777777777",
    );
    expect(analysis.codex.isSubagent).toBe(false);
    expect(analysis.codex.spawnedThreadIds).toEqual([
      {
        threadId: "88888888-8888-8888-8888-888888888888",
        callId: "call_spawn_child",
        nickname: "Aquinas",
        role: "explorer",
        line: 6,
        timestamp: "2026-07-03T09:00:05.000Z",
      },
    ]);
  });

  it("marks a sub-agent thread as isSubagent: true, with parentThreadId/agentRole/agentNickname/subagentDepth from source.subagent.thread_spawn", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/03/rollout-2026-07-03T09-00-05-88888888-8888-8888-8888-888888888888.jsonl",
      "88888888-8888-8888-8888-888888888888",
    );
    // Identity regression: the fixture's session_meta carries `session_id` =
    // the ROOT session's id (77777777…, as real Codex Desktop writes it);
    // preferring it over the thread's own `id` made every thread of one
    // conversation claim the root's sessionId — duplicate session-list rows
    // and an unbuildable sub-agent forest.
    expect(analysis.sessionId).toBe("88888888-8888-8888-8888-888888888888");
    expect(analysis.codex.isSubagent).toBe(true);
    expect(analysis.codex.parentThreadId).toBe("77777777-7777-7777-7777-777777777777");
    expect(analysis.codex.subagentDepth).toBe(1);
    expect(analysis.codex.agentNickname).toBe("Aquinas");
    expect(analysis.codex.agentRole).toBe("explorer");
    // This child is itself a parent to the grandchild fixture.
    expect(analysis.codex.spawnedThreadIds).toEqual([
      {
        threadId: "99999999-9999-9999-9999-999999999999",
        callId: "call_spawn_grandchild",
        nickname: "Scout",
        role: "searcher",
        line: 4,
        timestamp: "2026-07-03T09:00:07.000Z",
      },
    ]);
  });

  it("leaves subagentDepth undefined when the wire payload didn't carry one (grandchild fixture)", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/03/rollout-2026-07-03T09-00-07-99999999-9999-9999-9999-999999999999.jsonl",
      "99999999-9999-9999-9999-999999999999",
    );
    expect(analysis.codex.isSubagent).toBe(true);
    expect(analysis.codex.parentThreadId).toBe("88888888-8888-8888-8888-888888888888");
    expect(analysis.codex.subagentDepth).toBeUndefined();
  });

  it("marks a source.subagent.review thread as isSubagent: true even with no parentThreadId", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/03/rollout-2026-07-03T09-00-09-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(analysis.codex.isSubagent).toBe(true);
    expect(analysis.codex.parentThreadId).toBeUndefined();
  });

  it("treats a top-level-only parentThreadId (no source.subagent object) as isSubagent: true", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/sessions/2026/07/03/rollout-2026-07-03T09-00-11-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(analysis.codex.isSubagent).toBe(true);
    expect(analysis.codex.parentThreadId).toBe("77777777-7777-7777-7777-777777777777");
  });
});
