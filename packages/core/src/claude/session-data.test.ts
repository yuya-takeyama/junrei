import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../shared/types.js";
import { buildSessionData, transcriptEndsAtRest } from "./session-data.js";
import type { AssistantRecord, ClaudeTranscript, UserRecord } from "./types.js";

function assistantRecord(
  line: number,
  messageId: string,
  usage: TokenUsage | undefined,
): AssistantRecord {
  return {
    type: "assistant",
    line,
    messageId,
    model: "claude-fable-5",
    timestamp: `2026-07-09T01:00:0${String(line)}.000Z`,
    ...(usage !== undefined && { usage }),
    blocks: [{ kind: "text", text: `block ${String(line)}` }],
  };
}

function usage(outputTokens: number): TokenUsage {
  return { inputTokens: 100, outputTokens, cacheReadTokens: 400, cacheCreationTokens: 200 };
}

function transcriptOf(records: ClaudeTranscript["records"]): ClaudeTranscript {
  return { filePath: "/tmp/fake.jsonl", records, warnings: [] };
}

describe("buildSessionData usage dedup", () => {
  it("keeps the LAST occurrence's usage per message id (final output snapshot)", () => {
    // Real transcripts repeat a completed API message across JSONL records:
    // input/cache fields are identical on every occurrence, but output_tokens
    // is a streaming snapshot that grows (e.g. 5→5→473). First-occurrence
    // dedup undercounts output; last-occurrence is the billed total.
    const data = buildSessionData(
      transcriptOf([
        assistantRecord(1, "msg_1", usage(5)),
        assistantRecord(2, "msg_1", usage(5)),
        assistantRecord(3, "msg_1", usage(473)),
      ]),
    );

    expect(data.apiMessages).toHaveLength(1);
    const message = data.apiMessages[0];
    // Input/cache counted once — no multiplication across occurrences.
    expect(message?.usage).toEqual(usage(473));
    // Line/timestamp anchor the message START (first occurrence) so turn
    // attribution and the context timeline are unaffected by the dedup rule.
    expect(message?.line).toBe(1);
    expect(message?.timestamp).toBe("2026-07-09T01:00:01.000Z");
  });

  it("a later usage-less occurrence doesn't clobber recorded usage", () => {
    const data = buildSessionData(
      transcriptOf([assistantRecord(1, "msg_1", usage(5)), assistantRecord(2, "msg_1", undefined)]),
    );
    expect(data.apiMessages[0]?.usage).toEqual(usage(5));
  });

  it("fills usage in from a later occurrence when the first had none", () => {
    const data = buildSessionData(
      transcriptOf([
        assistantRecord(1, "msg_1", undefined),
        assistantRecord(2, "msg_1", usage(42)),
      ]),
    );
    expect(data.apiMessages[0]?.usage).toEqual(usage(42));
    expect(data.apiMessages[0]?.line).toBe(1);
  });
});

describe("transcriptEndsAtRest", () => {
  const userPrompt = (line: number): UserRecord => ({
    type: "user",
    line,
    promptText: "do the thing",
    toolResults: [],
  });
  const finalAssistant = (line: number, stopReason?: string): AssistantRecord => ({
    ...assistantRecord(line, `msg_${String(line)}`, usage(10)),
    ...(stopReason !== undefined && { stopReason }),
  });

  it("is true when the last message record is an assistant end_turn", () => {
    const records = [userPrompt(1), finalAssistant(2, "end_turn")];
    expect(transcriptEndsAtRest({ records })).toBe(true);
  });

  it("is false without a captured stop_reason (old-version-style records)", () => {
    const records = [userPrompt(1), finalAssistant(2)];
    expect(transcriptEndsAtRest({ records })).toBe(false);
  });

  it("is false for non-end_turn stop reasons (tool_use mid-flight, synthetic stop_sequence)", () => {
    expect(transcriptEndsAtRest({ records: [userPrompt(1), finalAssistant(2, "tool_use")] })).toBe(
      false,
    );
    expect(
      transcriptEndsAtRest({ records: [userPrompt(1), finalAssistant(2, "stop_sequence")] }),
    ).toBe(false);
  });

  it("is false again when a user record follows the final answer (agent resumed)", () => {
    const records = [userPrompt(1), finalAssistant(2, "end_turn"), userPrompt(3)];
    expect(transcriptEndsAtRest({ records })).toBe(false);
  });

  it("ignores trailing non-message records (queue-operation, permission-mode, ...)", () => {
    const records = [
      userPrompt(1),
      finalAssistant(2, "end_turn"),
      { line: 3, type: "permission-mode" },
    ];
    expect(transcriptEndsAtRest({ records })).toBe(true);
  });

  it("is false for an empty transcript", () => {
    expect(transcriptEndsAtRest({ records: [] })).toBe(false);
  });
});
