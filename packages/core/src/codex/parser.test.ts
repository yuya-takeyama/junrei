import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coerceOutputText, parseCodexTranscriptFile } from "./parser.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/codex");
const MAIN_FIXTURE = join(
  FIXTURES,
  "sessions/2026/07/01/rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
);
const LEGACY_FIXTURE = join(
  FIXTURES,
  "legacy/rollout-2025-01-01T00-00-00-44444444-4444-4444-4444-444444444444.jsonl",
);
const MALFORMED_ONLY_FIXTURE = join(
  FIXTURES,
  "malformed/rollout-2025-02-01T00-00-00-55555555-5555-5555-5555-555555555555.jsonl",
);
const EMPTY_FIXTURE = join(
  FIXTURES,
  "empty/rollout-2025-03-01T00-00-00-66666666-6666-6666-6666-666666666666.jsonl",
);
const SUBAGENT_DIR = join(FIXTURES, "sessions/2026/07/03");
const PARENT_FIXTURE = join(
  SUBAGENT_DIR,
  "rollout-2026-07-03T09-00-00-77777777-7777-7777-7777-777777777777.jsonl",
);
const CHILD_FIXTURE = join(
  SUBAGENT_DIR,
  "rollout-2026-07-03T09-00-05-88888888-8888-8888-8888-888888888888.jsonl",
);
const GRANDCHILD_FIXTURE = join(
  SUBAGENT_DIR,
  "rollout-2026-07-03T09-00-07-99999999-9999-9999-9999-999999999999.jsonl",
);
const REVIEW_SUBAGENT_FIXTURE = join(
  SUBAGENT_DIR,
  "rollout-2026-07-03T09-00-09-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
);
const TOP_LEVEL_ONLY_FIXTURE = join(
  SUBAGENT_DIR,
  "rollout-2026-07-03T09-00-11-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
);
const OBJECT_BASE_INSTRUCTIONS_FIXTURE = join(
  SUBAGENT_DIR,
  "rollout-2026-07-03T09-00-13-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl",
);

describe("parseCodexTranscriptFile", () => {
  it("parses the current-format fixture into normalized records", async () => {
    const transcript = await parseCodexTranscriptFile(MAIN_FIXTURE);

    expect(transcript.format).toBe("current");
    expect(transcript.records).toHaveLength(23); // 24 lines, 1 malformed
    expect(transcript.warnings).toEqual([{ line: 24, reason: "malformed JSON" }]);

    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({
      type: "sessionMeta",
      line: 1,
      id: "11111111-1111-1111-1111-111111111111",
      cwd: "/Users/test/codex-proj",
      originator: "codex_cli_rs",
      cliVersion: "0.55.0",
      agentRole: "reviewer", // via the legacy `agent_type` alias
      hasBaseInstructions: false,
      git: { branch: "main", commitHash: "abc123" },
    });
    // Older payloads (this fixture: cli_version 0.55.0) carry no `session_id`.
    expect(sessionMeta).not.toHaveProperty("rootSessionId");
  });

  it("accepts the turn_started/task_complete/turn_complete wire aliases", async () => {
    const transcript = await parseCodexTranscriptFile(MAIN_FIXTURE);
    const byLine = (line: number) => transcript.records.find((r) => r.line === line);

    expect(byLine(3)).toMatchObject({
      type: "eventMsg",
      event: { kind: "taskStarted", turnId: "turn-1" },
    });
    expect(byLine(14)).toMatchObject({
      type: "eventMsg",
      event: {
        kind: "taskComplete",
        turnId: "turn-1",
        lastAgentMessage: "Fixed the flaky test.",
        durationMs: 7000,
      },
    });
    expect(byLine(16)).toMatchObject({
      type: "eventMsg",
      event: { kind: "taskStarted", turnId: "turn-2" },
    });
  });

  it("tolerates an unknown envelope type and an unknown event_msg type without warnings", async () => {
    const transcript = await parseCodexTranscriptFile(MAIN_FIXTURE);

    const worldState = transcript.records.find((r) => r.line === 23);
    expect(worldState).toEqual({
      type: "other",
      line: 23,
      timestamp: "2026-07-01T10:00:14.500Z",
      rawType: "world_state",
    });

    const agentReasoning = transcript.records.find((r) => r.line === 18);
    expect(agentReasoning).toMatchObject({
      type: "eventMsg",
      event: { kind: "other", rawType: "agent_reasoning" },
    });

    // Neither degradation produced a warning — only the truly malformed line 24 did.
    expect(transcript.warnings).toHaveLength(1);
  });

  it("links function_call/function_call_output pairs by call_id, coercing structured output to text", async () => {
    const transcript = await parseCodexTranscriptFile(MAIN_FIXTURE);

    const call = transcript.records.find((r) => r.line === 6);
    expect(call).toMatchObject({
      type: "responseItem",
      item: { kind: "functionCall", callId: "call-1", name: "shell" },
    });

    const output = transcript.records.find((r) => r.line === 7);
    expect(output).toMatchObject({
      type: "responseItem",
      item: {
        kind: "functionCallOutput",
        callId: "call-1",
        text: "process exited with code 1",
        success: false,
      },
    });
  });

  it("parses a null token_count info without crashing, and a real one with usage", async () => {
    const transcript = await parseCodexTranscriptFile(MAIN_FIXTURE);

    const nullInfo = transcript.records.find((r) => r.line === 8);
    expect(nullInfo).toEqual({
      type: "eventMsg",
      line: 8,
      timestamp: "2026-07-01T10:00:05.500Z",
      event: { kind: "tokenCount" },
    });

    const realInfo = transcript.records.find((r) => r.line === 9);
    expect(realInfo).toMatchObject({
      type: "eventMsg",
      event: {
        kind: "tokenCount",
        info: {
          totalTokenUsage: {
            inputTokens: 1000,
            cachedInputTokens: 200,
            outputTokens: 300,
            reasoningOutputTokens: 50,
            totalTokens: 1550,
          },
          lastTokenUsage: {
            inputTokens: 1000,
            cachedInputTokens: 200,
            outputTokens: 300,
            reasoningOutputTokens: 50,
            totalTokens: 1550,
          },
          modelContextWindow: 200_000,
        },
        rateLimits: { primary: { used_percent: 10 } },
      },
    });
  });

  it("detects the pre-2026-02-25 legacy format from the first parseable line", async () => {
    const transcript = await parseCodexTranscriptFile(LEGACY_FIXTURE);
    expect(transcript.format).toBe("legacy");
    expect(transcript.records).toEqual([]);
  });

  it("treats a file with only malformed lines as empty (not legacy), with a warning", async () => {
    const transcript = await parseCodexTranscriptFile(MALFORMED_ONLY_FIXTURE);
    expect(transcript.format).toBe("empty");
    expect(transcript.records).toEqual([]);
    expect(transcript.warnings).toEqual([{ line: 1, reason: "malformed JSON" }]);
  });

  it("treats a genuinely empty file as format: empty with no warnings", async () => {
    const transcript = await parseCodexTranscriptFile(EMPTY_FIXTURE);
    expect(transcript.format).toBe("empty");
    expect(transcript.records).toEqual([]);
    expect(transcript.warnings).toEqual([]);
  });
});

describe("sub-agent linkage (session_meta.source.subagent.thread_spawn)", () => {
  it("does NOT mark a plain (non-subagent) session_meta as a sub-agent source", async () => {
    const transcript = await parseCodexTranscriptFile(PARENT_FIXTURE);
    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({
      type: "sessionMeta",
      isSubagentSource: false,
      // A root session's `session_id` is its own id.
      rootSessionId: "77777777-7777-7777-7777-777777777777",
    });
    expect(sessionMeta).not.toHaveProperty("parentThreadId");
    expect(sessionMeta).not.toHaveProperty("subagentDepth");
  });

  it("extracts parent_thread_id/depth/agent_nickname/agent_role from source.subagent.thread_spawn", async () => {
    const transcript = await parseCodexTranscriptFile(CHILD_FIXTURE);
    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({
      type: "sessionMeta",
      // `id` stays this thread's OWN id even though the wire payload also
      // carries `session_id` = the root's id (kept as rootSessionId) —
      // conflating them collapsed every thread of a conversation into one
      // sessionId (duplicate session-list rows on real ~/.codex data).
      id: "88888888-8888-8888-8888-888888888888",
      rootSessionId: "77777777-7777-7777-7777-777777777777",
      isSubagentSource: true,
      parentThreadId: "77777777-7777-7777-7777-777777777777",
      subagentDepth: 1,
      agentNickname: "Aquinas",
      agentRole: "explorer",
    });
  });

  it("leaves subagentDepth undefined when thread_spawn omits it (grandchild fixture)", async () => {
    const transcript = await parseCodexTranscriptFile(GRANDCHILD_FIXTURE);
    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({
      isSubagentSource: true,
      parentThreadId: "88888888-8888-8888-8888-888888888888",
      agentNickname: "Scout",
      agentRole: "searcher",
    });
    expect(sessionMeta).not.toHaveProperty("subagentDepth");
  });

  it("marks a source.subagent.review thread as a sub-agent source with no parent id (SubAgentSource variant without thread_spawn)", async () => {
    const transcript = await parseCodexTranscriptFile(REVIEW_SUBAGENT_FIXTURE);
    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({ isSubagentSource: true });
    expect(sessionMeta).not.toHaveProperty("parentThreadId");
  });

  it("reads top-level parent_thread_id/agent_nickname/agent_role when source carries no subagent object (other schema versions)", async () => {
    const transcript = await parseCodexTranscriptFile(TOP_LEVEL_ONLY_FIXTURE);
    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({
      isSubagentSource: false,
      parentThreadId: "77777777-7777-7777-7777-777777777777",
      agentNickname: "TopLevelOnly",
      agentRole: "reviewer",
    });
  });

  // Regression test — observed on real ~/.codex data (Codex Desktop
  // 0.128.0-alpha.1): base_instructions can be `{text: "..."}`, not a bare
  // string. A strict `z.string()` for that field used to fail validation for
  // the WHOLE session_meta payload, degrading it to a generic `other` record
  // and silently losing every field on the line — including the sub-agent
  // linkage this whole PR is about. See `base_instructions` in schema.ts.
  it("still parses session_meta (and its sub-agent linkage) when base_instructions is an object, not a string", async () => {
    const transcript = await parseCodexTranscriptFile(OBJECT_BASE_INSTRUCTIONS_FIXTURE);
    const sessionMeta = transcript.records[0];
    expect(sessionMeta).toMatchObject({
      type: "sessionMeta",
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      isSubagentSource: true,
      parentThreadId: "77777777-7777-7777-7777-777777777777",
      agentNickname: "ObjectInstructions",
      agentRole: "explorer",
      hasBaseInstructions: true,
    });
  });
});

describe("collab_agent_spawn_end event", () => {
  it("normalizes collab_agent_spawn_end into a collabSpawnEnd event", async () => {
    const transcript = await parseCodexTranscriptFile(PARENT_FIXTURE);
    const spawnEnd = transcript.records.find((r) => r.line === 6);
    expect(spawnEnd).toMatchObject({
      type: "eventMsg",
      event: {
        kind: "collabSpawnEnd",
        callId: "call_spawn_child",
        newThreadId: "88888888-8888-8888-8888-888888888888",
        newAgentNickname: "Aquinas",
        newAgentRole: "explorer",
      },
    });
  });

  it("tolerates the other collab_* / sub_agent_activity event types generically", async () => {
    const transcript = await parseCodexTranscriptFile(PARENT_FIXTURE);
    const spawnBegin = transcript.records.find((r) => r.line === 5);
    const waitingBegin = transcript.records.find((r) => r.line === 7);
    const waitingEnd = transcript.records.find((r) => r.line === 8);
    expect(spawnBegin).toMatchObject({
      type: "eventMsg",
      event: { kind: "other", rawType: "collab_agent_spawn_begin" },
    });
    expect(waitingBegin).toMatchObject({
      type: "eventMsg",
      event: { kind: "other", rawType: "collab_waiting_begin" },
    });
    expect(waitingEnd).toMatchObject({
      type: "eventMsg",
      event: { kind: "other", rawType: "collab_waiting_end" },
    });
  });
});

describe("coerceOutputText", () => {
  it("returns strings as-is", () => {
    expect(coerceOutputText("hello")).toBe("hello");
  });

  it("unwraps a {content} structured output", () => {
    expect(coerceOutputText({ content: "unwrapped", success: true })).toBe("unwrapped");
  });

  it("JSON-stringifies other object/array shapes", () => {
    expect(coerceOutputText({ foo: "bar" })).toBe('{"foo":"bar"}');
    expect(coerceOutputText([1, 2, 3])).toBe("[1,2,3]");
  });

  it("returns an empty string for null/undefined", () => {
    expect(coerceOutputText(null)).toBe("");
    expect(coerceOutputText(undefined)).toBe("");
  });
});
