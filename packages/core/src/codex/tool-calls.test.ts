import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexTranscriptFile } from "./parser.js";
import { listCodexToolCalls } from "./tool-calls.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/codex/bash-stats",
);

/**
 * `listCodexToolCalls` is the generic listing `get_tool_calls` (MCP) uses for
 * Codex sessions — every tool call, Bash-like or not, with `shellCommand` set
 * only for the genuine shell executions `bash-stats.test.ts` already covers
 * in depth. This file focuses on the GENERIC parts: every call is listed
 * (not just shell calls), non-shell calls carry no `shellCommand`, and
 * `toolName`/`inputSummary`/`inputChars` are populated sensibly for a
 * non-shell call too.
 */
describe("listCodexToolCalls", () => {
  it("lists every tool call in source order, including the non-shell apply_patch call", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const records = listCodexToolCalls(transcript);
    expect(records.map((r) => r.callId)).toEqual([
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
      "call-6",
      "call-7",
      "call-8",
      "call-9",
      "call-10",
    ]);
  });

  it("leaves shellCommand unset for a non-shell call (apply_patch)", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const records = listCodexToolCalls(transcript);
    const applyPatch = records.find((r) => r.callId === "call-10");
    expect(applyPatch).toMatchObject({ toolName: "apply_patch", status: "ok" });
    expect(applyPatch?.shellCommand).toBeUndefined();
    expect(applyPatch?.resultChars).toBe("patch applied".length);
  });

  it("names a local_shell_call 'shell' (no name field of its own on the wire) and a function_call by its raw name", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const records = listCodexToolCalls(transcript);
    expect(records.find((r) => r.callId === "call-6")?.toolName).toBe("shell");
    expect(records.find((r) => r.callId === "call-1")?.toolName).toBe("shell");
    expect(records.find((r) => r.callId === "call-2")?.toolName).toBe("exec_command");
    expect(records.find((r) => r.callId === "call-9")?.toolName).toBe("exec");
  });

  it("sets shellCommand only for genuine shell calls, and resolves inputChars from the raw argument text", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const records = listCodexToolCalls(transcript);
    const call1 = records.find((r) => r.callId === "call-1");
    expect(call1?.shellCommand).toBe("git status");
    expect(call1?.inputChars).toBe(JSON.stringify({ command: ["git", "status"] }).length);
  });

  it("flags only the local_shell_call record's resultChars as a placeholder (v2 PR A's $ weighting)", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const records = listCodexToolCalls(transcript);
    expect(records.find((r) => r.callId === "call-6")?.resultIsPlaceholder).toBe(true);
    // Every other record — function_call, custom_tool_call, web_search_call,
    // apply_patch — carries real (or at least non-synthesized) result text,
    // so the key is omitted entirely (never `false`).
    for (const record of records) {
      if (record.callId === "call-6") continue;
      expect(record).not.toHaveProperty("resultIsPlaceholder");
    }
  });
});
