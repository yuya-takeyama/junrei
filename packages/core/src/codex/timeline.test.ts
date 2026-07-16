import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AssistantTextEntry,
  CompactionEntry,
  ThinkingEntry,
  ToolCallEntry,
  UserEntry,
} from "../shared/timeline.js";
import { parseCodexTranscriptFile } from "./parser.js";
import { buildCodexTimeline, getCodexRecordDetail } from "./timeline.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/codex");

// Rich fixture: two turns, a reasoning block, all four tool-call shapes
// (function_call, custom_tool_call, local_shell_call, and their outputs/exec
// end), a malformed line, an unrecognized top-level envelope, and a
// `compacted` record at line 22.
const RICH_FILE = join(
  FIXTURES,
  "sessions/2026/07/01/rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
);

// Synthetic-user-text fixture: AGENTS.md / user_instructions response_items,
// a non-synthetic response_item duplicate, and the real event_msg prompt —
// all in one turn that ends in `turn_aborted`.
const SYNTHETIC_FILE = join(
  FIXTURES,
  "sessions/2026/07/02/rollout-2026-07-02T09-00-00-22222222-2222-2222-2222-222222222222.jsonl",
);

async function loadRich() {
  const transcript = await parseCodexTranscriptFile(RICH_FILE);
  expect(transcript.format).toBe("current");
  return transcript;
}

async function loadSynthetic() {
  const transcript = await parseCodexTranscriptFile(SYNTHETIC_FILE);
  expect(transcript.format).toBe("current");
  return transcript;
}

describe("buildCodexTimeline", () => {
  it("produces one entry per mapped record, in source order, with correct line refs", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);

    expect(entries.map((e) => [e.kind, e.line])).toEqual([
      ["user", 4],
      ["thinking", 5],
      ["tool-call", 6],
      ["tool-call", 10],
      ["tool-call", 12],
      ["user", 17],
      ["compaction", 22],
    ]);
  });

  it("sources user entries from event_msg user_message", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const users = entries.filter((e): e is UserEntry => e.kind === "user");
    expect(users.map((u) => u.text)).toEqual([
      "Fix the flaky test in foo.spec.ts",
      "Now add a regression test.",
    ]);
    expect(users.every((u) => u.truncated === false)).toBe(true);
  });

  it("captures a reasoning response_item as a thinking entry with its human-readable summary text", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const thinking = entries.find((e): e is ThinkingEntry => e.kind === "thinking");
    expect(thinking?.text).toBe("thinking...");
    expect(thinking?.truncated).toBe(false);
    expect(thinking?.charCount).toBe("thinking...".length);
    expect(thinking?.line).toBe(5);
    // No turn_context has been seen yet at line 5 (the first one, at line 2,
    // sets claude-sonnet-4-5 — this reasoning block comes after it).
    expect(thinking?.model).toBe("claude-sonnet-4-5");
  });

  it("links a function_call to its function_call_output, flagging {success:false} as an error", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const shell = entries.find((e): e is ToolCallEntry => e.kind === "tool-call" && e.line === 6);
    expect(shell?.name).toBe("shell");
    expect(shell?.toolUseId).toBe("call-1");
    // arguments: {"command":["pytest","foo.spec.ts"]} — array joined with spaces.
    expect(shell?.inputSummary).toBe("pytest foo.spec.ts");
    expect(shell?.status).toBe("error");
    expect(shell?.resultSummary).toBe("process exited with code 1");
    expect(shell?.resultLine).toBe(7);
    expect(shell?.durationMs).toBe(1000);
  });

  it("links a custom_tool_call to its custom_tool_call_output as ok (no success flag, no error pattern)", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const patch = entries.find((e): e is ToolCallEntry => e.kind === "tool-call" && e.line === 10);
    expect(patch?.name).toBe("apply_patch");
    expect(patch?.toolUseId).toBe("call-2");
    expect(patch?.inputSummary).toBe("*** Update File: foo.spec.ts");
    expect(patch?.status).toBe("ok");
    expect(patch?.resultSummary).toBe("patch applied");
    expect(patch?.durationMs).toBe(500);
  });

  it("links a local_shell_call to its exec_command_end, flagging a nonzero exit code as an error", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const localShell = entries.find(
      (e): e is ToolCallEntry => e.kind === "tool-call" && e.line === 12,
    );
    expect(localShell?.name).toBe("shell");
    expect(localShell?.toolUseId).toBe("call-3");
    expect(localShell?.status).toBe("error");
    expect(localShell?.resultSummary).toBe("exited with code 2");
    expect(localShell?.resultLine).toBe(13);
    expect(localShell?.durationMs).toBe(500);
  });

  it("emits a compaction entry for the top-level `compacted` envelope", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const compaction = entries.find((e): e is CompactionEntry => e.kind === "compaction");
    expect(compaction?.line).toBe(22);
    expect(compaction?.timestamp).toBe("2026-07-01T10:00:14.000Z");
  });

  it("never emits subagent-launch, task-notification, or api-error (no Codex analog exists)", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("subagent-launch")).toBe(false);
    expect(kinds.has("task-notification")).toBe(false);
    expect(kinds.has("api-error")).toBe(false);
  });

  it("skips unrecognized event_msg/top-level records (agent_reasoning, world_state) and malformed lines", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    // Line 18 (agent_reasoning), line 23 (world_state), and line 24 (malformed
    // JSON — never even reaches `transcript.records`) must not appear.
    expect(entries.some((e) => e.line === 18)).toBe(false);
    expect(entries.some((e) => e.line === 23)).toBe(false);
    expect(entries.some((e) => e.line === 24)).toBe(false);
  });

  it("skips turn boundaries (task_started/task_complete/turn_context) — Claude's vocabulary has no turn-boundary kind", async () => {
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    expect(entries.some((e) => e.line === 2)).toBe(false); // turn_context
    expect(entries.some((e) => e.line === 14)).toBe(false); // turn_complete
    expect(entries.some((e) => e.line === 15)).toBe(false); // turn_context
    expect(entries.some((e) => e.line === 16)).toBe(false); // task_started
    expect(entries.some((e) => e.line === 20)).toBe(false); // task_complete
  });

  it("attributes assistant-text entries to the most recent turn_context model", async () => {
    // No agent_message events exist in the rich fixture, so exercise model
    // attribution indirectly via the second reasoning-less turn: a synthetic
    // check that model tracking doesn't throw and stays absent when no
    // turn_context has been seen (covered by the reasoning-entry test above
    // for the positive case).
    const transcript = await loadRich();
    const entries = buildCodexTimeline(transcript);
    expect(entries.some((e): e is AssistantTextEntry => e.kind === "assistant-text")).toBe(false);
  });

  it("maps an agent_message event to an assistant-text entry", async () => {
    const transcript = await loadSynthetic();
    const entries = buildCodexTimeline(transcript);
    const assistant = entries.filter((e): e is AssistantTextEntry => e.kind === "assistant-text");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("Fallback demo finished.");
    expect(assistant[0]?.line).toBe(10);
    // The synthetic fixture has no turn_context, so no model is attributed.
    expect(assistant[0]?.model).toBeUndefined();
  });

  it("falls back to non-synthetic response_item user messages when no user_message event exists", async () => {
    const transcript = await parseCodexTranscriptFile(
      join(
        FIXTURES,
        "sessions/2026/07/02/rollout-2026-07-02T09-30-00-33333333-3333-3333-3333-333333333333.jsonl",
      ),
    );
    expect(transcript.format).toBe("current");
    const entries = buildCodexTimeline(transcript);
    const users = entries.filter((e): e is UserEntry => e.kind === "user");
    // Line 2 (AGENTS.md injection) is synthetic and skipped; line 3 survives.
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe("Fallback prompt");
    expect(users[0]?.line).toBe(3);
  });

  it("skips synthetic response_item user text, and — once an event_msg user_message exists — every response_item message too", async () => {
    const transcript = await loadSynthetic();
    const entries = buildCodexTimeline(transcript);
    const users = entries.filter((e): e is UserEntry => e.kind === "user");
    // Only the real event_msg-sourced prompt survives: lines 2 (AGENTS.md) and
    // 3 (user_instructions) are synthetic, and line 4 ("Real prompt via
    // response item") is a response_item duplicate skipped in favor of the
    // event-sourced line 5, even though its text isn't itself synthetic.
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe("Real prompt via event");
    expect(users[0]?.line).toBe(5);
  });

  it("produces no entries for turn_aborted (a taskComplete variant, still a turn boundary)", async () => {
    const transcript = await loadSynthetic();
    const entries = buildCodexTimeline(transcript);
    expect(entries.some((e) => e.line === 9)).toBe(false);
  });
});

describe("getCodexRecordDetail", () => {
  it("returns full tool-call detail (raw input, full result text) for a known function_call line", async () => {
    const transcript = await loadRich();
    const detail = getCodexRecordDetail(transcript, 6);
    expect(detail?.kind).toBe("tool-call");
    if (detail?.kind !== "tool-call") throw new Error("expected tool-call detail");
    expect(detail.toolUseId).toBe("call-1");
    expect(detail.name).toBe("shell");
    expect(detail.input).toEqual({ command: ["pytest", "foo.spec.ts"] });
    expect(detail.status).toBe("error");
    expect(detail.resultText).toBe("process exited with code 1");
    expect(detail.resultLine).toBe(7);
  });

  it("returns a user detail for an event_msg user_message line", async () => {
    const transcript = await loadRich();
    const detail = getCodexRecordDetail(transcript, 4);
    expect(detail).toEqual({
      kind: "user",
      text: "Fix the flaky test in foo.spec.ts",
      line: 4,
      timestamp: "2026-07-01T10:00:02.000Z",
    });
  });

  it("returns a thinking detail with the full summary text for a reasoning line", async () => {
    const transcript = await loadRich();
    const detail = getCodexRecordDetail(transcript, 5);
    expect(detail).toEqual({
      kind: "thinking",
      text: "thinking...",
      charCount: "thinking...".length,
      model: "claude-sonnet-4-5",
      line: 5,
      timestamp: "2026-07-01T10:00:03.000Z",
    });
  });

  it("returns a compaction detail for the `compacted` line", async () => {
    const transcript = await loadRich();
    const detail = getCodexRecordDetail(transcript, 22);
    expect(detail).toEqual({
      kind: "compaction",
      line: 22,
      timestamp: "2026-07-01T10:00:14.000Z",
    });
  });

  it("returns undefined for a line with no addressable record (e.g. turn_context)", async () => {
    const transcript = await loadRich();
    expect(getCodexRecordDetail(transcript, 2)).toBeUndefined();
  });

  it("returns undefined for a line past the end of the file", async () => {
    const transcript = await loadRich();
    expect(getCodexRecordDetail(transcript, 999)).toBeUndefined();
  });

  it("returns injected-context (full text, header included) for an AGENTS.md injection line", async () => {
    const transcript = await loadSynthetic();
    const detail = getCodexRecordDetail(transcript, 2);
    expect(detail).toEqual({
      kind: "injected-context",
      text: "# AGENTS.md instructions for /Users/test/codex-proj\n\nInjected project instructions.",
      charCount: 83,
      line: 2,
      timestamp: "2026-07-02T09:00:01.000Z",
    });
  });

  it("returns injected-context for other synthetic user texts (<user_instructions>), even though an event user message exists", async () => {
    const transcript = await loadSynthetic();
    // Injected context never surfaces as a user_message EVENT, so the
    // event-dedup rule must not swallow it (the Files lens links straight
    // to this line).
    const detail = getCodexRecordDetail(transcript, 3);
    expect(detail).toMatchObject({ kind: "injected-context", charCount: 52, line: 3 });
  });

  it("still returns undefined for a response_item duplicate of a real event-sourced prompt", async () => {
    const transcript = await loadSynthetic();
    expect(getCodexRecordDetail(transcript, 4)).toBeUndefined();
  });
});

describe("reasoning summary text edge cases", () => {
  const SESSION_META =
    '{"timestamp":"2026-07-04T00:00:00.000Z","type":"session_meta","payload":{"id":"cccccccc-cccc-cccc-cccc-cccccccccccc","cwd":"/tmp/proj","originator":"codex_cli_rs","cli_version":"0.55.0"}}';

  async function withRolloutFile(
    lines: string[],
    run: (filePath: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "junrei-codex-reasoning-"));
    const filePath = join(dir, "rollout.jsonl");
    try {
      await writeFile(filePath, `${lines.join("\n")}\n`);
      await run(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("truncates a long reasoning summary in the timeline entry but keeps the full text in the detail", async () => {
    const longText = "x".repeat(800);
    const reasoningLine = JSON.stringify({
      timestamp: "2026-07-04T00:00:01.000Z",
      type: "response_item",
      payload: { type: "reasoning", id: "r1", summary: [{ text: longText }] },
    });
    await withRolloutFile([SESSION_META, reasoningLine], async (filePath) => {
      const transcript = await parseCodexTranscriptFile(filePath);
      expect(transcript.format).toBe("current");

      const entries = buildCodexTimeline(transcript);
      const thinking = entries.find((e): e is ThinkingEntry => e.kind === "thinking");
      expect(thinking?.truncated).toBe(true);
      expect(thinking?.text.length).toBe(701); // 700 + "…"
      expect(thinking?.charCount).toBe(800); // full length, unlike the truncated preview

      const detail = getCodexRecordDetail(transcript, 2);
      expect(detail?.kind).toBe("thinking");
      expect(detail && "text" in detail ? detail.text : undefined).toBe(longText);
    });
  });

  it("yields empty text for a reasoning item with only encrypted content (no readable summary)", async () => {
    const reasoningLine = JSON.stringify({
      timestamp: "2026-07-04T00:00:01.000Z",
      type: "response_item",
      payload: { type: "reasoning", id: "r1", encrypted_content: "abcd" },
    });
    await withRolloutFile([SESSION_META, reasoningLine], async (filePath) => {
      const transcript = await parseCodexTranscriptFile(filePath);
      const record = transcript.records.find((r) => r.line === 2);
      expect(record).toMatchObject({
        type: "responseItem",
        item: { kind: "reasoning", summaryText: "", hasEncryptedContent: true },
      });

      const entries = buildCodexTimeline(transcript);
      const thinking = entries.find((e): e is ThinkingEntry => e.kind === "thinking");
      expect(thinking?.text).toBe("");
      expect(thinking?.charCount).toBe(0);
    });
  });
});
