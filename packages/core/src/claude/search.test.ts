import { describe, expect, it } from "vitest";
import { extractClaudeSearchFields } from "./search.js";

describe("extractClaudeSearchFields", () => {
  it("extracts a string user prompt as a user field", () => {
    const fields = extractClaudeSearchFields({
      type: "user",
      message: { role: "user", content: 'say "hello"\nworld' },
    });
    expect(fields).toEqual([{ field: "user", text: 'say "hello"\nworld' }]);
  });

  it("extracts tool_result blocks in full (no normalizer truncation)", () => {
    const long = `${"x".repeat(2400)}NEEDLE${"y".repeat(10)}`;
    const fields = extractClaudeSearchFields({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: long }] },
        ],
      },
    });
    const toolResult = fields.find((f) => f.field === "tool_result");
    expect(toolResult?.text).toHaveLength(long.length);
    expect(toolResult?.text).toContain("NEEDLE");
  });

  it("skips harness-injected task notifications", () => {
    const fields = extractClaudeSearchFields({
      type: "user",
      message: {
        role: "user",
        content:
          "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>",
      },
    });
    expect(fields).toEqual([]);
  });

  it("extracts assistant text, thinking, and tool_use input with toolName", () => {
    const fields = extractClaudeSearchFields({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden gold", signature: "sig" },
          { type: "text", text: "I will fix it" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "aqua i -l" } },
        ],
      },
    });
    expect(fields).toContainEqual({ field: "thinking", text: "hidden gold" });
    expect(fields).toContainEqual({ field: "assistant", text: "I will fix it" });
    expect(fields).toContainEqual({ field: "tool_input", toolName: "Bash", text: "aqua i -l" });
  });

  it("extracts summary / ai-title / custom-title as title fields", () => {
    expect(extractClaudeSearchFields({ type: "summary", summary: "Aqua session" })).toEqual([
      { field: "title", text: "Aqua session" },
    ]);
    expect(extractClaudeSearchFields({ type: "ai-title", aiTitle: "T1" })).toEqual([
      { field: "title", text: "T1" },
    ]);
    expect(extractClaudeSearchFields({ type: "custom-title", customTitle: "T2" })).toEqual([
      { field: "title", text: "T2" },
    ]);
  });

  it("returns nothing for unknown or malformed records", () => {
    expect(extractClaudeSearchFields({ type: "system", subtype: "api_error" })).toEqual([]);
    expect(extractClaudeSearchFields("not a record")).toEqual([]);
    expect(extractClaudeSearchFields(null)).toEqual([]);
  });
});
