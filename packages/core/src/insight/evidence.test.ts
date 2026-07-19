import { describe, expect, it, vi } from "vitest";
import { type EvidenceFetchers, selectEvidence } from "./evidence.js";

describe("selectEvidence", () => {
  it("dispatches record to the record fetcher and returns its payload verbatim", async () => {
    const record = vi.fn().mockResolvedValue({ line: 42, text: "hello" });
    const result = await selectEvidence(
      {
        source: "claude-code",
        sessionId: "s1",
        select: { type: "record", line: 42 },
        agentId: "a1",
        detail: "full",
      },
      { record },
    );
    expect(record).toHaveBeenCalledWith({
      sessionId: "s1",
      line: 42,
      agentId: "a1",
      detail: "full",
    });
    expect(result.kind).toBe("record");
    expect(result.data).toEqual({ line: 42, text: "hello" });
    expect(result._meta.approxTokens).toBeGreaterThan(0);
  });

  it("dispatches tool_call with the tool use id", async () => {
    const toolCall = vi.fn().mockResolvedValue({ ok: true });
    await selectEvidence(
      { source: "claude-code", sessionId: "s1", select: { type: "tool_call", toolUseId: "tu_9" } },
      { toolCall },
    );
    expect(toolCall).toHaveBeenCalledWith({ sessionId: "s1", toolUseId: "tu_9" });
  });

  it("omits optional tool_calls filters when not provided", async () => {
    const toolCalls = vi.fn().mockResolvedValue([]);
    await selectEvidence(
      { source: "codex", sessionId: "s1", select: { type: "tool_calls" } },
      { toolCalls },
    );
    expect(toolCalls).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("passes tool_calls filters through when provided", async () => {
    const toolCalls = vi.fn().mockResolvedValue([]);
    await selectEvidence(
      {
        source: "codex",
        sessionId: "s1",
        select: { type: "tool_calls", toolName: "Bash", limit: 5 },
      },
      { toolCalls },
    );
    expect(toolCalls).toHaveBeenCalledWith({ sessionId: "s1", toolName: "Bash", limit: 5 });
  });

  it("returns notAvailable (never throws) when the kind has no fetcher for the harness", async () => {
    const fetchers: EvidenceFetchers = {}; // Codex has no task_executions concept.
    const result = await selectEvidence(
      { source: "codex", sessionId: "s1", select: { type: "task_executions" } },
      fetchers,
    );
    expect(result.notAvailable).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result._meta.nextSteps?.[0]).toMatch(/not available for codex/);
  });

  it("resolves first_prompt with only the session id", async () => {
    const firstPrompt = vi.fn().mockResolvedValue({ prompt: "do the thing" });
    const result = await selectEvidence(
      { source: "claude-code", sessionId: "s1", select: { type: "first_prompt" } },
      { firstPrompt },
    );
    expect(firstPrompt).toHaveBeenCalledWith({ sessionId: "s1" });
    expect(result.data).toEqual({ prompt: "do the thing" });
  });
});
