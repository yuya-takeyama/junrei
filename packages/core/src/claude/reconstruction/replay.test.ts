import { describe, expect, it } from "vitest";
import { buildTurns, parseReconstructionRecords, type ReplayBlock } from "./replay.js";
import type { ReconstructionRecord, ReconUserRecord } from "./types.js";

// Every fixture here is fully synthetic — invented prompts, tool ids, and
// injection content. Nothing is copied from a real capture.

async function* linesOf(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

function sources(blocks: ReplayBlock[]): string[] {
  return blocks.map((b) => b.source);
}

describe("parseReconstructionRecords", () => {
  it("preserves attachment injection content and untruncated tool_result content", async () => {
    const bigResult = "R".repeat(5000); // exceeds the analytics parser's 2000-char cap
    const records = await parseReconstructionRecords(
      linesOf([
        `{"type":"user","message":{"content":"hi"},"cwd":"/proj","version":"9.9.9","timestamp":"2026-07-18T00:00:00.000Z"}`,
        `{"type":"attachment","attachment":{"type":"agent_listing_delta","addedLines":["- a: x"]}}`,
        `{"type":"attachment","attachment":{"type":"skill_listing","content":"- s: y"}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"${bigResult}"}]}}`,
        `{"type":"assistant","requestId":"req_1","message":{"id":"m1","content":[{"type":"text","text":"ok"}]}}`,
        `{"type":"user","isSidechain":true,"message":{"content":"subagent turn"}}`,
      ]),
    );
    // Sidechain record dropped (main-loop only).
    expect(records).toHaveLength(5);
    const attach = records[1];
    expect(attach).toMatchObject({ type: "attachment", attachment: { addedLines: ["- a: x"] } });
    const toolResultUser = records[3] as ReconUserRecord | undefined;
    expect(toolResultUser?.type).toBe("user");
    const content = toolResultUser?.content;
    if (Array.isArray(content)) {
      expect(content[0]?.content).toBe(bigResult); // full length, not truncated
    }
    const assistant = records[4];
    expect(assistant).toMatchObject({ type: "assistant", requestId: "req_1", line: 5 });
  });

  it("skips blank lines and keeps 1-based line numbers", async () => {
    const records = await parseReconstructionRecords(
      linesOf([
        `{"type":"user","message":{"content":"a"}}`,
        "",
        `{"type":"assistant","message":{"id":"m","content":[]}}`,
      ]),
    );
    expect(records.map((r) => r.line)).toEqual([1, 3]);
  });
});

describe("buildTurns", () => {
  it("merges consecutive tool_results that share an owner assistant message into one user turn", () => {
    const records: ReconstructionRecord[] = [
      {
        type: "assistant",
        line: 1,
        messageId: "mA",
        blocks: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Read", input: {} },
        ],
      },
      {
        type: "user",
        line: 2,
        content: [{ type: "tool_result", tool_use_id: "t1", content: "one" }],
      },
      {
        type: "user",
        line: 3,
        content: [{ type: "tool_result", tool_use_id: "t2", content: "two" }],
      },
    ];
    const { turns } = buildTurns(records);
    // assistant turn + a SINGLE merged user turn holding both results.
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("assistant");
    expect(turns[1]?.role).toBe("user");
    expect(turns[1]?.blocks).toHaveLength(2);
    expect(sources(turns[1]?.blocks ?? [])).toEqual(["tool-result", "tool-result"]);
  });

  it("drops thinking blocks, skips queue-operation/metadata records, and prepends injected reminders", () => {
    const records: ReconstructionRecord[] = [
      { type: "user", line: 1, content: "prompt one" },
      {
        type: "attachment",
        line: 2,
        attachment: { type: "agent_listing_delta", addedLines: ["- a: x"] },
      },
      { type: "attachment", line: 3, attachment: { type: "skill_listing", content: "- s: y" } },
      { type: "queue-operation", line: 4 },
      { type: "last-prompt", line: 5 },
      {
        type: "assistant",
        line: 6,
        messageId: "mA",
        blocks: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const { turns, stats } = buildTurns(records);

    expect(stats.droppedThinking).toBe(true);
    expect(stats.skippedQueueOperations).toBe(1);

    // The agent + skill listings and the disk-contingent CLAUDE.md reminder are
    // prepended (in that order) to the user turn they follow, before the prompt.
    expect(sources(turns[0]?.blocks ?? [])).toEqual([
      "attachment-agent",
      "attachment-skill",
      "disk-claude-md",
      "user-string",
    ]);

    // Thinking is gone; only the text block remains on the assistant turn.
    expect(sources(turns[1]?.blocks ?? [])).toEqual(["assistant-text"]);
  });

  it("flags task-notification user turns", () => {
    const records: ReconstructionRecord[] = [
      {
        type: "user",
        line: 1,
        content:
          "<task-notification><task-id>abc</task-id><status>completed</status></task-notification>",
      },
    ];
    const { turns, stats } = buildTurns(records);
    expect(stats.taskNotificationTurns).toBe(1);
    const block = turns[0]?.blocks[0];
    expect(block?.source === "user-string" && block.isTaskNotification).toBe(true);
  });
});
