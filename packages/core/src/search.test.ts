import { describe, expect, it } from "vitest";
import {
  extractClaudeSearchFields,
  extractCodexSearchFields,
  flattenToSearchText,
} from "./search.js";

describe("flattenToSearchText", () => {
  it("emits decoded values only — no key names, joined by newlines", () => {
    const text = flattenToSearchText({
      command: "aqua i -l",
      nested: { flag: true, count: 3 },
      list: ["a", "b"],
    });
    expect(text).toBe("aqua i -l\ntrue\n3\na\nb");
    expect(text).not.toContain("command");
  });

  it("handles bare strings and skips null/undefined", () => {
    expect(flattenToSearchText("plain")).toBe("plain");
    expect(flattenToSearchText({ a: null, b: undefined })).toBe("");
  });
});

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

describe("extractCodexSearchFields", () => {
  it("extracts event_msg user_message / agent_message and flags them", () => {
    const user = extractCodexSearchFields({
      type: "event_msg",
      payload: { type: "user_message", message: "fix the flaky test" },
    });
    expect(user.fields).toEqual([{ field: "user", text: "fix the flaky test" }]);
    expect(user.sawUserMessageEvent).toBe(true);

    const agent = extractCodexSearchFields({
      type: "event_msg",
      payload: { type: "agent_message", message: "done" },
    });
    expect(agent.fields).toEqual([{ field: "assistant", text: "done" }]);
    expect(agent.sawAgentMessageEvent).toBe(true);
  });

  it("extracts thread_name_updated as a title field", () => {
    const extraction = extractCodexSearchFields({
      type: "event_msg",
      payload: { type: "thread_name_updated", thread_name: "flaky test hunt" },
    });
    expect(extraction.fields).toEqual([{ field: "title", text: "flaky test hunt" }]);
  });

  it("defers response_item message text behind its event gate", () => {
    const user = extractCodexSearchFields({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "real prompt" }],
      },
    });
    expect(user.fields).toEqual([]);
    expect(user.deferredFields).toEqual([
      { gate: "userMessage", field: "user", text: "real prompt" },
    ]);

    const assistant = extractCodexSearchFields({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ text: "answer text" }] },
    });
    expect(assistant.deferredFields).toEqual([
      { gate: "agentMessage", field: "assistant", text: "answer text" },
    ]);
  });

  it("never extracts synthetic injected user context", () => {
    const extraction = extractCodexSearchFields({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ text: "<user_instructions>be nice</user_instructions>" }],
      },
    });
    expect(extraction.fields).toEqual([]);
    expect(extraction.deferredFields).toEqual([]);
  });

  it("decodes function_call arguments before matching", () => {
    const extraction = extractCodexSearchFields({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: '{"command":["rg","aqua-checksums"]}',
      },
    });
    expect(extraction.fields).toEqual([
      { field: "tool_input", toolName: "shell", text: "rg\naqua-checksums" },
    ]);
  });

  it("keeps non-JSON function_call arguments as raw text", () => {
    const extraction = extractCodexSearchFields({
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "c1", arguments: "not json {" },
    });
    expect(extraction.fields).toEqual([
      { field: "tool_input", toolName: "shell", text: "not json {" },
    ]);
  });

  it("coerces function_call_output content and reads reasoning summaries", () => {
    const output = extractCodexSearchFields({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "c1",
        output: { content: "exit code 1", success: false },
      },
    });
    expect(output.fields).toEqual([{ field: "tool_result", text: "exit code 1" }]);

    const reasoning = extractCodexSearchFields({
      type: "response_item",
      payload: { type: "reasoning", summary: [{ text: "thinking about aqua" }] },
    });
    expect(reasoning.fields).toEqual([{ field: "thinking", text: "thinking about aqua" }]);
  });

  it("extracts web_search_call queries", () => {
    const extraction = extractCodexSearchFields({
      type: "response_item",
      payload: {
        type: "web_search_call",
        action: { type: "search", query: "aqua registry", queries: ["aquaproj tags"] },
      },
    });
    expect(extraction.fields).toEqual([
      { field: "tool_input", toolName: "web_search", text: "aqua registry\naquaproj tags" },
    ]);
  });

  it("returns the empty extraction for non-envelope records", () => {
    const extraction = extractCodexSearchFields({ type: "event_msg", payload: "nope" });
    expect(extraction.fields).toEqual([]);
    expect(extraction.deferredFields).toEqual([]);
    expect(extraction.sawUserMessageEvent).toBe(false);
  });
});
