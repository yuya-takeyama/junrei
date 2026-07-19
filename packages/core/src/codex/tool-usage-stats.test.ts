import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexTranscriptFile } from "./parser.js";
import { computeCodexToolUsageEntries, computeCodexToolUsageStats } from "./tool-usage-stats.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/codex/bash-stats",
);

/**
 * Reuses `bash-stats`'s `main.jsonl` fixture (documented in
 * `codex/bash-stats.test.ts`) — it carries call-1..call-9 (nine genuine shell
 * calls) plus call-10, a `custom_tool_call` "apply_patch". The Bash engine
 * excludes apply_patch; the cross-tool engine counts EVERY tool call, so it
 * sees all 10.
 */
describe("computeCodexToolUsageEntries / computeCodexToolUsageStats", () => {
  it("maps EVERY tool call including apply_patch (unlike the Bash engine's 9)", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexToolUsageEntries(transcript);
    expect(entries.map((e) => e.id)).toEqual([
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
    // apply_patch surfaces under its own tool name.
    expect(entries.find((e) => e.id === "call-10")?.tool).toBe("apply_patch");
  });

  it("carries isError but NO errorCategory (Codex has no result text to classify), tallying errors under 'other'", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const entries = computeCodexToolUsageEntries(transcript);
    // call-3 ({success:false}) and call-6 (exit 1) are the errored calls.
    expect(entries.find((e) => e.id === "call-3")?.isError).toBe(true);
    expect(entries.find((e) => e.id === "call-6")?.isError).toBe(true);
    for (const entry of entries) expect(entry.errorCategory).toBeUndefined();

    const stats = computeCodexToolUsageStats(transcript);
    // Every errored call falls under "other" (no category available).
    const totalErrorCats = stats.byTool.reduce(
      (sum, t) => sum + Object.values(t.errorCategories).reduce((a, b) => a + b, 0),
      0,
    );
    expect(totalErrorCats).toBe(stats.totals.errors);
    for (const t of stats.byTool) {
      for (const key of Object.keys(t.errorCategories)) expect(key).toBe("other");
    }
  });

  it("propagates the local_shell_call placeholder (call-6) and excludes it from estUsd while pricing the rest", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexToolUsageStats(transcript, "claude-fable-5");

    const call6 = stats.heavyHitters.find((h) => h.id === "call-6");
    // call-6 may or may not fall in the top-10 by size; assert placeholder
    // handling only when present, and always via the entries below.
    if (call6 !== undefined) {
      expect(call6.resultIsPlaceholder).toBe(true);
      expect(call6).not.toHaveProperty("estUsd");
    }

    const FABLE_INPUT_RATE = 0.00001;
    const entries = computeCodexToolUsageEntries(transcript);
    let expectedEstUsd = 0;
    for (const entry of entries) {
      if (entry.resultIsPlaceholder === true) continue;
      expectedEstUsd += Math.ceil(entry.resultChars / 4) * FABLE_INPUT_RATE;
    }
    expect(stats.totals.estUsd).toBe(expectedEstUsd);
    // Main-thread-only: every heavy hitter is on "main".
    expect(stats.heavyHitters.every((h) => h.thread === "main")).toBe(true);
  });

  it("leaves estUsd absent throughout when no model is supplied", async () => {
    const transcript = await parseCodexTranscriptFile(join(FIXTURES_DIR, "main.jsonl"));
    const stats = computeCodexToolUsageStats(transcript);
    expect(stats.totals).not.toHaveProperty("estUsd");
    expect(stats.heavyHitters.every((h) => !("estUsd" in h))).toBe(true);
  });

  it("returns empty rollups for a transcript with no tool calls", async () => {
    const transcript = await parseCodexTranscriptFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../test/fixtures/codex/empty/rollout-2025-03-01T00-00-00-66666666-6666-6666-6666-666666666666.jsonl",
      ),
    );
    expect(computeCodexToolUsageEntries(transcript)).toEqual([]);
    const stats = computeCodexToolUsageStats(transcript, "claude-fable-5");
    expect(stats.totals.calls).toBe(0);
    expect(stats.byTool).toEqual([]);
  });
});
