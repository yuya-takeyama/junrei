import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../shared/pricing/pricing.js";
import type {
  ApiErrorEntry,
  AssistantTextEntry,
  CompactionEntry,
  SubagentLaunchEntry,
  TaskNotificationEntry,
  ThinkingEntry,
  ToolCallEntry,
  UserEntry,
} from "../shared/timeline.js";
import type { TokenUsage } from "../shared/types.js";
import { parseClaudeTranscriptFile } from "./parser.js";
import type { SessionData } from "./session-data.js";
import { buildSessionData } from "./session-data.js";
import type { ClaudeSessionStore } from "./store.js";
import { loadSubagentSessionData } from "./subagents.js";
import { buildClaudeTimeline, getClaudeRecordDetail, getClaudeToolCallDetail } from "./timeline.js";
import type { AssistantContentBlock, ClaudeTranscript } from "./types.js";

const FIXTURE_PROJECTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/projects",
);
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

// Inline-transcript helpers for the multi-record-message cases the shared
// fixture doesn't cover (its text-bearing messages are all single-record).
function usageOf(outputTokens: number): TokenUsage {
  return { inputTokens: 100, outputTokens, cacheReadTokens: 400, cacheCreationTokens: 0 };
}

function assistantStep(
  line: number,
  messageId: string,
  blocks: AssistantContentBlock[],
  outputTokens: number,
): ClaudeTranscript["records"][number] {
  return {
    type: "assistant",
    line,
    messageId,
    model: "claude-fable-5",
    timestamp: `2026-07-09T01:00:0${String(line)}.000Z`,
    usage: usageOf(outputTokens),
    blocks,
  };
}

function transcriptOf(records: ClaudeTranscript["records"]): ClaudeTranscript {
  return { filePath: "/tmp/fake.jsonl", records, warnings: [] };
}

describe("buildClaudeTimeline", () => {
  it("produces one entry per record/block, in source order, without a mainFilePath", async () => {
    const data = await loadMainData();
    const entries = await buildClaudeTimeline(data);

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
    const entries = await buildClaudeTimeline(data);
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
    const entries = await buildClaudeTimeline(data);
    const thinking = entries.find((e): e is ThinkingEntry => e.kind === "thinking");
    expect(thinking?.text).toBe("let me look");
    expect(thinking?.truncated).toBe(false);
    expect(thinking?.charCount).toBe("let me look".length);
    expect(thinking?.model).toBe("claude-fable-5");
    expect(thinking?.line).toBe(2);
  });

  it("builds tool-call entries with status, summaries, and duration", async () => {
    const data = await loadMainData();
    const entries = await buildClaudeTimeline(data);
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
    const entries = await buildClaudeTimeline(data);
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
    const entries = await buildClaudeTimeline(data);
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

  it("prices a text block by its message's FINAL usage, not the record's streaming snapshot", async () => {
    // One API message spans several JSONL records, each repeating `usage`
    // with output_tokens as a GROWING streaming snapshot (5→60 here). The
    // text block lands on an early record, so pricing by record.usage
    // undercounted — the badge must come from the deduped ApiMessage.
    const data = buildSessionData(
      transcriptOf([
        assistantStep(1, "msg_a", [{ kind: "text", text: "Let me check." }], 5),
        assistantStep(
          2,
          "msg_a",
          [{ kind: "tool_use", toolUseId: "toolu_x", name: "Read", input: {} }],
          60,
        ),
      ]),
    );
    const entries = await buildClaudeTimeline(data);
    const text = entries.find((e): e is AssistantTextEntry => e.kind === "assistant-text");
    expect(text?.outputTokens).toBe(60);
    expect(text?.costUsd).toBe(estimateCostUsd("claude-fable-5", usageOf(60)));
  });

  it("puts the usage badge only on the message's LAST text block", async () => {
    const data = buildSessionData(
      transcriptOf([
        assistantStep(1, "msg_b", [{ kind: "text", text: "part one" }], 5),
        assistantStep(2, "msg_b", [{ kind: "text", text: "part two" }], 90),
      ]),
    );
    const entries = await buildClaudeTimeline(data);
    const texts = entries.filter((e): e is AssistantTextEntry => e.kind === "assistant-text");
    expect(texts).toHaveLength(2);
    // Both blocks belong to ONE API message — repeating the message total on
    // each would read as 2× the real cost in the list, so only the last
    // block carries the badge. The model chip stays on both.
    expect(texts[0]?.outputTokens).toBeUndefined();
    expect(texts[0]?.costUsd).toBeUndefined();
    expect(texts[0]?.model).toBe("claude-fable-5");
    expect(texts[1]?.outputTokens).toBe(90);
    expect(texts[1]?.costUsd).toBe(estimateCostUsd("claude-fable-5", usageOf(90)));
  });

  it("recognizes compaction boundaries", async () => {
    const data = await loadMainData();
    const entries = await buildClaudeTimeline(data);
    const compaction = entries.find((e): e is CompactionEntry => e.kind === "compaction");
    expect(compaction?.trigger).toBe("auto");
    expect(compaction?.preTokens).toBe(150000);
    expect(compaction?.postTokens).toBe(9000);
    expect(compaction?.line).toBe(19);
  });

  it("surfaces api_error records with a short message", async () => {
    const data = await loadMainData();
    const entries = await buildClaudeTimeline(data);
    const apiError = entries.find((e): e is ApiErrorEntry => e.kind === "api-error");
    expect(apiError?.message).toBe("529 Overloaded");
    expect(apiError?.line).toBe(7);
  });

  it("builds task-notification entries anchored to the launching tool call", async () => {
    const data = await loadMainData();
    const entries = await buildClaudeTimeline(data);
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
    const entries = await buildClaudeTimeline(data);
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
    const entries = await buildClaudeTimeline(data, { mainFilePath: SESSION_FILE });
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
    const entries = await buildClaudeTimeline(data);
    const toolCalls = entries.filter((e): e is ToolCallEntry => e.kind === "tool-call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.every((c) => c.status === "error")).toBe(true);
  });

  it("captures returnedChars for a SYNCHRONOUS subagent launch", async () => {
    const transcript = await parseClaudeTranscriptFile(OUT_OF_ORDER_FILE);
    const data = buildSessionData(transcript);
    const entries = await buildClaudeTimeline(data);
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
    const entries = await buildClaudeTimeline(data);
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
    const detail = await getClaudeRecordDetail(data, 3);
    expect(detail?.kind).toBe("thinking");
    expect(detail && "text" in detail ? detail.text : undefined).toBe(longText);
  });

  it("builds a timeline for a subagent's own transcript", async () => {
    const subData = await loadSubagentSessionData(SESSION_FILE, AGENT_ID);
    expect(subData).toBeDefined();
    const entries = await buildClaudeTimeline(subData as SessionData, {
      mainFilePath: SESSION_FILE,
    });
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

describe("getClaudeRecordDetail", () => {
  it("returns full tool-call detail with linkage", async () => {
    const data = await loadMainData();
    const detail = await getClaudeRecordDetail(data, 3); // Read tool_use line
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
    const detail = await getClaudeRecordDetail(data, 27); // "All done." assistant record
    expect(detail?.kind).toBe("assistant-text");
    if (detail?.kind !== "assistant-text") throw new Error("expected assistant-text");
    expect(detail.text).toBe("All done.");
    expect(detail.model).toBe("claude-fable-5");
    expect(detail.outputTokens).toBe(80);
    expect(detail.costUsd).toBeGreaterThan(0);
  });

  it("reports the message-final usage on ANY of the message's text blocks", async () => {
    // Unlike the timeline badge (last text block only), the single-record
    // detail view answers "what did this message cost" on every block — and
    // never with the record's own streaming snapshot (5 here).
    const data = buildSessionData(
      transcriptOf([
        assistantStep(1, "msg_b", [{ kind: "text", text: "part one" }], 5),
        assistantStep(2, "msg_b", [{ kind: "text", text: "part two" }], 90),
      ]),
    );
    const detail = await getClaudeRecordDetail(data, 1);
    if (detail?.kind !== "assistant-text") throw new Error("expected assistant-text");
    expect(detail.outputTokens).toBe(90);
    expect(detail.costUsd).toBe(estimateCostUsd("claude-fable-5", usageOf(90)));
  });

  it("returns full subagent-launch detail, unresolved without mainFilePath", async () => {
    const data = await loadMainData();
    const detail = await getClaudeRecordDetail(data, 21); // Agent tool_use line
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
    const detail = await getClaudeRecordDetail(data, 21, { mainFilePath: SESSION_FILE });
    if (detail?.kind !== "subagent-launch") throw new Error("expected subagent-launch");
    expect(detail.agentId).toBe(AGENT_ID);
    expect(detail.model).toBe("claude-haiku-4-5-20251001");
    expect(detail.toolCallCount).toBe(2);
    expect(detail.durationMs).toBe(25_000);
  });

  it("returns compaction detail", async () => {
    const data = await loadMainData();
    const detail = await getClaudeRecordDetail(data, 19);
    expect(detail?.kind).toBe("compaction");
    if (detail?.kind !== "compaction") throw new Error("expected compaction");
    expect(detail.trigger).toBe("auto");
    expect(detail.preTokens).toBe(150000);
    expect(detail.postTokens).toBe(9000);
  });

  it("returns api-error detail with status and retry attempt", async () => {
    const data = await loadMainData();
    const detail = await getClaudeRecordDetail(data, 7);
    expect(detail?.kind).toBe("api-error");
    if (detail?.kind !== "api-error") throw new Error("expected api-error");
    expect(detail.message).toBe("529 Overloaded");
    expect(detail.status).toBe(529);
    expect(detail.retryAttempt).toBe(1);
  });

  it("returns undefined for a tool-result-only carrier line (not independently addressable)", async () => {
    const data = await loadMainData();
    const detail = await getClaudeRecordDetail(data, 4); // tool_result for toolu_read1
    expect(detail).toBeUndefined();
  });

  it("returns undefined for a line that doesn't exist", async () => {
    const data = await loadMainData();
    const detail = await getClaudeRecordDetail(data, 99999);
    expect(detail).toBeUndefined();
  });
});

/** A store whose `openLines` never yields anything — every raw-line recovery attempt against it fails (line "unreadable"). */
function unreadableLineStore(): ClaudeSessionStore {
  return {
    listSessionFiles: () => Promise.resolve([]),
    findSessionFileById: () => Promise.resolve(undefined),
    openLines: async function* openLines() {
      // Yields nothing — readRawLineAt never reaches the target line.
    },
    readFile: () => Promise.reject(new Error("not implemented")),
    listSidecarFiles: () => Promise.resolve([]),
  };
}

describe("getClaudeToolCallDetail", () => {
  it("returns the call and its result as one unit, with the containing record's uuid and no related records", async () => {
    const data = await loadMainData();
    const detail = await getClaudeToolCallDetail(data, "toolu_read1");
    expect(detail?.toolUseId).toBe("toolu_read1");
    expect(detail?.call).toEqual({
      name: "Read",
      input: { file_path: "/p/foo.ts" },
      line: 3,
      timestamp: "2026-07-09T01:00:06.000Z",
      uuid: "a2",
    });
    expect(detail?.result).toEqual({
      isError: false,
      text: "const x = 1;",
      line: 4,
      timestamp: "2026-07-09T01:00:07.000Z",
    });
    expect(detail?.resultMissing).toBe(false);
    expect(detail?.relatedRecords).toEqual([]);
  });

  it("declares result: null and resultMissing: true for a call with no result", async () => {
    const data = await loadMainData();
    const detail = await getClaudeToolCallDetail(data, "toolu_webfetch1"); // line 18, never resulted
    expect(detail?.result).toBeNull();
    expect(detail?.resultMissing).toBe(true);
  });

  it("recovers the FULL result text (re-reading the raw source line) when the parser's capture cap would otherwise truncate it", async () => {
    const data = await loadMainData();
    const detail = await getClaudeToolCallDetail(data, "toolu_skill1"); // line 29 -> result line 30, 2200 raw chars
    // No longer stuck at the parser's TOOL_RESULT_TEXT_LIMIT (2000) — the
    // true 2200-char tool_result is recovered from the raw JSONL line.
    expect(detail?.result?.text.length).toBe(2200);
    expect(detail?.result?.fullTextLength).toBeUndefined();
  });

  it("omits fullTextLength when the captured text was never cut", async () => {
    const data = await loadMainData();
    const detail = await getClaudeToolCallDetail(data, "toolu_read1");
    expect(detail?.result?.fullTextLength).toBeUndefined();
  });

  it("falls back to the parser's capped text and reports fullTextLength when raw-line recovery fails", async () => {
    const data = await loadMainData();
    const detail = await getClaudeToolCallDetail(data, "toolu_skill1", unreadableLineStore());
    // Recovery couldn't read the raw line — never lies about it: still the
    // parser's own capped snapshot, with the TRUE original count reported.
    expect(detail?.result?.text.length).toBe(2000);
    expect(detail?.result?.fullTextLength).toBe(2200);
  });

  it("skips recovery (and reports fullTextLength) for hand-built SessionData with no filePath", async () => {
    const { filePath: _filePath, ...withoutFilePath } = await loadMainData();
    const detail = await getClaudeToolCallDetail(withoutFilePath, "toolu_skill1");
    expect(detail?.result?.text.length).toBe(2000);
    expect(detail?.result?.fullTextLength).toBe(2200);
  });

  it("links a background launch's completion notification as a related record", async () => {
    const data = await loadMainData();
    const detail = await getClaudeToolCallDetail(data, "toolu_bgbash1"); // line 23, launches taskId bgtask01
    expect(detail?.relatedRecords).toEqual([
      {
        kind: "task-notification",
        taskId: "bgtask01",
        line: 25,
        timestamp: "2026-07-09T01:02:55.000Z",
        status: "completed",
        exitCode: 0,
      },
    ]);
  });

  it("returns undefined for an unknown toolUseId", async () => {
    const data = await loadMainData();
    expect(await getClaudeToolCallDetail(data, "does-not-exist")).toBeUndefined();
  });
});
