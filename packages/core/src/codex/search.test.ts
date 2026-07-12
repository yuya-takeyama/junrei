import { describe, expect, it } from "vitest";
import { extractCodexSearchFields } from "./search.js";

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
