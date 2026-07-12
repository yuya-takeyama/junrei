import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeClaudeSession, type ClaudeSessionAnalysis } from "@junrei/core";
import { describe, expect, it } from "vitest";
import { computeModelMix } from "./sessions.js";

const SESSION_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures/projects/-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);

describe("computeModelMix", () => {
  it("aggregates output tokens per model across the main session and all subagents", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    const mix = computeModelMix(analysis);

    // Main transcript only uses claude-fable-5; the fixture's one subagent
    // uses claude-haiku-4-5-20251001 — both must be represented, keyed by
    // output tokens (not message count or cost) so the L0 mix bar reflects
    // actual generation volume per model.
    const fableMain = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    expect(fableMain).toBeDefined();

    const fable = mix.find((m) => m.model === "claude-fable-5");
    const haiku = mix.find((m) => m.model === "claude-haiku-4-5-20251001");
    expect(fable?.outputTokens).toBe(fableMain?.outputTokens);
    expect(haiku?.outputTokens).toBeGreaterThan(0);

    // Every model's output tokens must come from usage.byModel + subagent
    // usage — never double-counted, never dropped.
    const total = mix.reduce((sum, m) => sum + m.outputTokens, 0);
    expect(total).toBe(analysis.totalUsage.outputTokens);
  });

  it("returns an empty list when there is no usage at all", () => {
    const analysis = {
      usage: {
        byModel: [],
        total: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          costIsComplete: true,
        },
      },
      subagents: [],
    } as unknown as ClaudeSessionAnalysis;
    expect(computeModelMix(analysis)).toEqual([]);
  });
});
