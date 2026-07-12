import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscriptFile } from "./parser.js";
import type { SessionData } from "./session-data.js";
import { buildSessionData } from "./session-data.js";
import { loadSubagentSessionData } from "./subagents.js";
import type {
  ApiErrorEntry,
  AssistantTextEntry,
  CompactionEntry,
  SubagentLaunchEntry,
  TaskNotificationEntry,
  ThinkingEntry,
  ToolCallEntry,
  UserEntry,
} from "./timeline.js";
import { buildTimeline, getRecordDetail } from "./timeline.js";

const FIXTURE_PROJECTS = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/projects");
const SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);
const OUT_OF_ORDER_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/22222222-2222-2222-2222-222222222222.jsonl",
);
const AGENT_ID = "aaaa111122223333f";

async function loadMainData(): Promise<SessionData> {
  const transcript = await parseClaudeTranscriptFile(SESSION_FILE);
  return buildSessionData(transcript);
}

describe("buildTimeline", () => {
  it("produces one entry per record/block, in source order, without a mainFilePath", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);

    // First entry is the human prompt.
    const first = entries[0] as UserEntry;
    expect(first.kind).toBe("user");
    expect(first.text).toBe("Fix the bug in foo.ts");
    expect(first.truncated).toBe(false);
    expect(first.line).toBe(1);

    // Kinds appear in the same order as the underlying records.
    const kinds = entries.map((e) => e.kind);
    expect(kinds[0]).toBe("user");
    expect(kinds[1]).toBe("thinking");
    expect(kinds[2]).toBe("tool-call"); // Read

    // tool-result-carrier records do NOT become their own entries.
    expect(entries.some((e) => e.line === 4)).toBe(false);
  });

  it("distinguishes plain user prompts from tool-result carriers", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const userEntries = entries.filter((e): e is UserEntry => e.kind === "user");
    // 3 genuine human turns (the 3rd being a slash-command record, whose raw
    // `<command-name>...</command-name>` text is a real user record with
    // `promptText` set — the parser makes no special case for it); tool_result-only
    // user records are excluded.
    expect(userEntries).toHaveLength(3);
    expect(userEntries[1]?.text).toBe("continue please");
    expect(userEntries[2]?.text).toContain(
      "<command-name>/cost-efficient-delegation</command-name>",
    );
  });

  it("captures thinking blocks with the full retained text", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const thinking = entries.find((e): e is ThinkingEntry => e.kind === "thinking");
    expect(thinking?.text).toBe("let me look");
    expect(thinking?.truncated).toBe(false);
    expect(thinking?.charCount).toBe("let me look".length);
    expect(thinking?.model).toBe("claude-fable-5");
    expect(thinking?.line).toBe(2);
  });

  it("builds tool-call entries with status, summaries, and duration", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const toolCalls = entries.filter((e): e is ToolCallEntry => e.kind === "tool-call");

    const read1 = toolCalls.find((c) => c.toolUseId === "toolu_read1");
    expect(read1?.name).toBe("Read");
    expect(read1?.inputSummary).toBe("/p/foo.ts");
    expect(read1?.status).toBe("ok");
    expect(read1?.resultSummary).toBe("const x = 1;");
    expect(read1?.resultLineCount).toBe(1);
    expect(read1?.resultLine).toBe(4);
    // tool_use (01:00:06) -> tool_result (01:00:07)
    expect(read1?.durationMs).toBe(1000);

    const bash1 = toolCalls.find((c) => c.toolUseId === "toolu_bash1");
    expect(bash1?.inputSummary).toBe("pnpm test");
    expect(bash1?.status).toBe("error");
    expect(bash1?.resultSummary).toBe("Exit code 1: tests failed");

    // Agent/Task tool calls never become plain tool-call entries.
    expect(toolCalls.some((c) => c.toolUseId === "toolu_agent1")).toBe(false);
  });

  it("marks a tool call with no result as missing-result", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const webfetch = entries.find(
      (e): e is ToolCallEntry => e.kind === "tool-call" && e.toolUseId === "toolu_webfetch1",
    );
    expect(webfetch?.status).toBe("missing-result");
    expect(webfetch?.resultSummary).toBeUndefined();
    expect(webfetch?.resultLine).toBeUndefined();
    expect(webfetch?.durationMs).toBeUndefined();
  });

  it("prices assistant text by the message's own usage", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const assistantTexts = entries.filter(
      (e): e is AssistantTextEntry => e.kind === "assistant-text",
    );
    // 2 now: "All done." (line 27) and "Applying delegation guidance." (line 31,
    // after the appended Skill-invocation turn).
    expect(assistantTexts).toHaveLength(2);
    const done = assistantTexts[0];
    expect(done?.text).toBe("All done.");
    expect(done?.model).toBe("claude-fable-5");
    expect(done?.outputTokens).toBe(80);
    expect(done?.costUsd).toBeGreaterThan(0);
    // No per-message duration field exists in the log — never fabricated.
    expect(done?.apiDurationMs).toBeUndefined();
  });

  it("recognizes compaction boundaries", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const compaction = entries.find((e): e is CompactionEntry => e.kind === "compaction");
    expect(compaction?.trigger).toBe("auto");
    expect(compaction?.preTokens).toBe(150000);
    expect(compaction?.postTokens).toBe(9000);
    expect(compaction?.line).toBe(19);
  });

  it("surfaces api_error records with a short message", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const apiError = entries.find((e): e is ApiErrorEntry => e.kind === "api-error");
    expect(apiError?.message).toBe("529 Overloaded");
    expect(apiError?.line).toBe(7);
  });

  it("builds task-notification entries anchored to the launching tool call", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const notifications = entries.filter(
      (e): e is TaskNotificationEntry => e.kind === "task-notification",
    );
    expect(notifications).toHaveLength(2);

    const bgBash = notifications.find((n) => n.taskId === "bgtask01");
    expect(bgBash?.name).toBe("Build in background");
    expect(bgBash?.status).toBe("completed");
    expect(bgBash?.exitCode).toBe(0);
    // Launching tool_use (01:02:40) -> notification (01:02:55).
    expect(bgBash?.durationMs).toBe(15_000);
    expect(bgBash?.startLine).toBe(23);

    const agentNotif = notifications.find((n) => n.taskId === AGENT_ID);
    expect(agentNotif?.name).toBe("Explore codebase");
    // Launching tool_use (01:02:05) -> notification (01:02:58).
    expect(agentNotif?.durationMs).toBe(53_000);
    expect(agentNotif?.startLine).toBe(21);
  });

  it("builds a subagent-launch entry from in-band data alone when mainFilePath is omitted", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data);
    const launch = entries.find(
      (e): e is SubagentLaunchEntry =>
        e.kind === "subagent-launch" && e.toolUseId === "toolu_agent1",
    );
    expect(launch).toBeDefined();
    expect(launch?.agentId).toBeUndefined();
    expect(launch?.agentType).toBe("Explore");
    expect(launch?.name).toBe("Explore codebase");
    expect(launch?.model).toBe("haiku"); // from the tool_use input, unresolved
    expect(launch?.promptPreview).toBe("explore stuff");
    expect(launch?.promptTruncated).toBe(false);
    // ASYNC launch: the tool_result ("agent done") is only the launch ack,
    // not the agent's return — returnedChars stays unresolved.
    expect(launch?.returnedChars).toBeUndefined();
    expect(launch?.resultLine).toBe(22);
    // Usage/duration are unresolved without a sidecar lookup.
    expect(launch?.outputTokens).toBeUndefined();
    expect(launch?.costUsd).toBeUndefined();
    expect(launch?.durationMs).toBeUndefined();
    // No "effort" field exists anywhere in the log.
    expect(launch?.effort).toBeUndefined();
  });

  it("resolves subagent usage/cost/duration when mainFilePath is given", async () => {
    const data = await loadMainData();
    const entries = await buildTimeline(data, { mainFilePath: SESSION_FILE });
    const launch = entries.find(
      (e): e is SubagentLaunchEntry =>
        e.kind === "subagent-launch" && e.toolUseId === "toolu_agent1",
    );
    expect(launch?.agentId).toBe(AGENT_ID);
    // Overridden by the subagent's own observed model (ground truth beats the
    // parent's requested-model alias).
    expect(launch?.model).toBe("claude-haiku-4-5-20251001");
    // 20+30+10 — includes the sidecar's 2nd Read (added for file-access merge coverage).
    expect(launch?.outputTokens).toBe(20 + 30 + 10);
    expect(launch?.costUsd).toBeGreaterThan(0);
    expect(launch?.toolCallCount).toBe(2);
    expect(launch?.toolErrorCount).toBe(0);
    // Subagent's own first -> last timestamp (01:02:32 -> 01:02:57).
    expect(launch?.durationMs).toBe(25_000);
  });

  it("keeps correct linkage when a tool_result precedes its tool_use in file order", async () => {
    const transcript = await parseClaudeTranscriptFile(OUT_OF_ORDER_FILE);
    const data = buildSessionData(transcript);
    const entries = await buildTimeline(data);
    const toolCalls = entries.filter((e): e is ToolCallEntry => e.kind === "tool-call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.every((c) => c.status === "error")).toBe(true);
  });

  it("captures returnedChars for a SYNCHRONOUS subagent launch", async () => {
    const transcript = await parseClaudeTranscriptFile(OUT_OF_ORDER_FILE);
    const data = buildSessionData(transcript);
    const entries = await buildTimeline(data);
    const launch = entries.find(
      (e): e is SubagentLaunchEntry =>
        e.kind === "subagent-launch" && e.toolUseId === "toolu_agent_sync1",
    );
    // Sync launch: the parent-side tool_result IS the agent's return.
    expect(launch?.returnedChars).toBe(
      "Both edits failed because the files were never read.".length,
    );
    expect(launch?.resultLine).toBe(7);
  });

  it("truncates long user/assistant/thinking text and marks it truncated", async () => {
    const longText = "x".repeat(800);
    const records: SessionData["records"] = [
      {
        line: 1,
        type: "user",
        toolResults: [],
        promptText: longText,
      },
      {
        line: 2,
        type: "assistant",
        model: "claude-fable-5",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        blocks: [{ kind: "text", text: longText }],
      },
      {
        line: 3,
        type: "assistant",
        model: "claude-fable-5",
        blocks: [{ kind: "thinking", text: longText, length: longText.length }],
      },
    ];
    const data: SessionData = {
      records,
      apiMessages: [],
      toolCalls: [],
      userPrompts: [],
      compactions: [],
      backgroundLaunches: [],
      taskNotifications: [],
      apiErrorCount: 0,
      apiErrors: [],
      warningCount: 0,
    };
    const entries = await buildTimeline(data);
    const user = entries.find((e): e is UserEntry => e.kind === "user");
    const assistant = entries.find((e): e is AssistantTextEntry => e.kind === "assistant-text");
    const thinking = entries.find((e): e is ThinkingEntry => e.kind === "thinking");
    expect(user?.truncated).toBe(true);
    expect(user?.text.length).toBe(701); // 700 + "…"
    expect(assistant?.truncated).toBe(true);
    expect(assistant?.text.length).toBe(701);
    expect(thinking?.truncated).toBe(true);
    expect(thinking?.text.length).toBe(701);
    expect(thinking?.charCount).toBe(800); // full length, unlike the truncated preview text

    // Record detail keeps the FULL thinking text, unlike the timeline entry's preview.
    const detail = await getRecordDetail(data, 3);
    expect(detail?.kind).toBe("thinking");
    expect(detail && "text" in detail ? detail.text : undefined).toBe(longText);
  });

  it("builds a timeline for a subagent's own transcript", async () => {
    const subData = await loadSubagentSessionData(SESSION_FILE, AGENT_ID);
    expect(subData).toBeDefined();
    const entries = await buildTimeline(subData as SessionData, { mainFilePath: SESSION_FILE });
    const kinds = entries.map((e) => e.kind);
    // A 2nd tool-call (Read /p/foo.ts) was appended for file-access merge coverage.
    expect(kinds).toEqual(["user", "tool-call", "assistant-text", "tool-call"]);
    const user = entries[0] as UserEntry;
    expect(user.text).toBe("explore stuff");
    const assistantText = entries[2] as AssistantTextEntry;
    expect(assistantText.text).toBe("bar.ts exports bar.");
    expect(assistantText.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("getRecordDetail", () => {
  it("returns full tool-call detail with linkage", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 3); // Read tool_use line
    expect(detail?.kind).toBe("tool-call");
    if (detail?.kind !== "tool-call") throw new Error("expected tool-call");
    expect(detail.toolUseId).toBe("toolu_read1");
    expect(detail.name).toBe("Read");
    expect(detail.input).toEqual({ file_path: "/p/foo.ts" });
    expect(detail.status).toBe("ok");
    expect(detail.resultText).toBe("const x = 1;");
    expect(detail.resultLine).toBe(4);
    expect(detail.durationMs).toBe(1000);
  });

  it("returns full assistant-text detail", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 27); // "All done." assistant record
    expect(detail?.kind).toBe("assistant-text");
    if (detail?.kind !== "assistant-text") throw new Error("expected assistant-text");
    expect(detail.text).toBe("All done.");
    expect(detail.model).toBe("claude-fable-5");
    expect(detail.outputTokens).toBe(80);
    expect(detail.costUsd).toBeGreaterThan(0);
  });

  it("returns full subagent-launch detail, unresolved without mainFilePath", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 21); // Agent tool_use line
    expect(detail?.kind).toBe("subagent-launch");
    if (detail?.kind !== "subagent-launch") throw new Error("expected subagent-launch");
    expect(detail.agentId).toBeUndefined();
    expect(detail.prompt).toBe("explore stuff");
    expect(detail.model).toBe("haiku");
    expect(detail.returnedText).toBe("agent done");
    expect(detail.outputTokens).toBeUndefined();
  });

  it("resolves subagent-launch detail with mainFilePath", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 21, { mainFilePath: SESSION_FILE });
    if (detail?.kind !== "subagent-launch") throw new Error("expected subagent-launch");
    expect(detail.agentId).toBe(AGENT_ID);
    expect(detail.model).toBe("claude-haiku-4-5-20251001");
    expect(detail.toolCallCount).toBe(2);
    expect(detail.durationMs).toBe(25_000);
  });

  it("returns compaction detail", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 19);
    expect(detail?.kind).toBe("compaction");
    if (detail?.kind !== "compaction") throw new Error("expected compaction");
    expect(detail.trigger).toBe("auto");
    expect(detail.preTokens).toBe(150000);
    expect(detail.postTokens).toBe(9000);
  });

  it("returns api-error detail with status and retry attempt", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 7);
    expect(detail?.kind).toBe("api-error");
    if (detail?.kind !== "api-error") throw new Error("expected api-error");
    expect(detail.message).toBe("529 Overloaded");
    expect(detail.status).toBe(529);
    expect(detail.retryAttempt).toBe(1);
  });

  it("returns undefined for a tool-result-only carrier line (not independently addressable)", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 4); // tool_result for toolu_read1
    expect(detail).toBeUndefined();
  });

  it("returns undefined for a line that doesn't exist", async () => {
    const data = await loadMainData();
    const detail = await getRecordDetail(data, 99999);
    expect(detail).toBeUndefined();
  });
});
