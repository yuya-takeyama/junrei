import { describe, expect, it } from "vitest";
import { computeDelegationSummary } from "./delegation.js";
import type { ModelUsageSummary, UsageSummary } from "./metrics.js";

describe("computeDelegationSummary", () => {
  it("splits mixed models, including one that never ran on the main thread", () => {
    const sonnetMain: ModelUsageSummary = {
      model: "sonnet",
      messageCount: 5,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      costUsd: 2,
    };
    const sonnetTotal: ModelUsageSummary = {
      model: "sonnet",
      messageCount: 15,
      inputTokens: 4000,
      outputTokens: 800,
      cacheReadTokens: 400,
      cacheCreationTokens: 200,
      costUsd: 8,
    };
    const haikuTotal: ModelUsageSummary = {
      model: "haiku",
      messageCount: 20,
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 500,
      cacheCreationTokens: 250,
      costUsd: 1.5,
    };
    const main: UsageSummary = {
      byModel: [sonnetMain],
      total: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
        costUsd: 2,
        costIsComplete: true,
      },
    };
    const total = {
      inputTokens: 9000,
      outputTokens: 1800,
      cacheReadTokens: 900,
      cacheCreationTokens: 450,
      costUsd: 9.5,
      costIsComplete: true,
    };

    const summary = computeDelegationSummary(main, total, [sonnetTotal, haikuTotal]);

    // Overall: main = its own usage; subagents = total − main.
    expect(summary.main).toEqual({ tokens: 1350, outputTokens: 200, costUsd: 2, messageCount: 5 });
    expect(summary.subagents).toEqual({
      tokens: 10800,
      outputTokens: 1600,
      costUsd: 7.5,
      messageCount: 30,
    });
    expect(summary.costIsComplete).toBe(true);

    // Per model: sonnet ran on both; haiku ran on subagents only.
    const sonnetSlice = summary.byModel.find((m) => m.model === "sonnet");
    expect(sonnetSlice?.main).toEqual({
      tokens: 1350,
      outputTokens: 200,
      costUsd: 2,
      messageCount: 5,
    });
    expect(sonnetSlice?.subagents).toEqual({
      tokens: 4050,
      outputTokens: 600,
      costUsd: 6,
      messageCount: 10,
    });

    const haikuSlice = summary.byModel.find((m) => m.model === "haiku");
    expect(haikuSlice?.main).toEqual({ tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 });
    expect(haikuSlice?.subagents).toEqual({
      tokens: 6750,
      outputTokens: 1000,
      costUsd: 1.5,
      messageCount: 20,
    });
  });

  it("propagates an undefined subagent cost (and costIsComplete: false) when a model has no known pricing", () => {
    const main: UsageSummary = {
      byModel: [],
      total: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        costIsComplete: true,
      },
    };
    const total = {
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      costIsComplete: false,
    };
    const unpriced: ModelUsageSummary = {
      model: "unknown-model",
      messageCount: 3,
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      // costUsd intentionally omitted — unpriced model.
    };

    const summary = computeDelegationSummary(main, total, [unpriced]);

    expect(summary.costIsComplete).toBe(false);
    const slice = summary.byModel.find((m) => m.model === "unknown-model");
    // Never ran on main -> a real, known 0 (not "unknown pricing").
    expect(slice?.main.costUsd).toBe(0);
    // Model itself has no known price at all -> leave undefined, don't guess.
    expect(slice?.subagents.costUsd).toBeUndefined();
    expect(slice?.subagents.tokens).toBe(400);
  });

  it("returns an all-zero subagents slice for a session with no subagents", () => {
    const modelEntry: ModelUsageSummary = {
      model: "sonnet",
      messageCount: 4,
      inputTokens: 400,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: 1.2,
    };
    const main: UsageSummary = {
      byModel: [modelEntry],
      total: {
        inputTokens: 400,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        costUsd: 1.2,
        costIsComplete: true,
      },
    };
    const total = {
      inputTokens: 400,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: 1.2,
      costIsComplete: true,
    };

    const summary = computeDelegationSummary(main, total, [modelEntry]);

    expect(summary.subagents).toEqual({ tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 });
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.subagents).toEqual({
      tokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
    });
  });

  it("clamps a negative token/message-count subtraction to 0 instead of going negative", () => {
    const mainEntry: ModelUsageSummary = {
      model: "m1",
      messageCount: 2,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 1,
    };
    const main: UsageSummary = {
      byModel: [mainEntry],
      total: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 1,
        costIsComplete: true,
      },
    };
    // Deliberately inconsistent with `main` (contrived, to exercise the
    // clamp guard) — a real `totalUsage` is always >= `usage.total`.
    const total = {
      inputTokens: 90,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 1,
      costIsComplete: true,
    };
    const totalEntry: ModelUsageSummary = {
      model: "m1",
      messageCount: 1,
      inputTokens: 90,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 1,
    };

    const summary = computeDelegationSummary(main, total, [totalEntry]);

    expect(summary.subagents.tokens).toBe(0);
    expect(summary.subagents.messageCount).toBe(0);
    const slice = summary.byModel.find((m) => m.model === "m1");
    expect(slice?.subagents.tokens).toBe(0);
    expect(slice?.subagents.outputTokens).toBe(0);
    expect(slice?.subagents.messageCount).toBe(0);
  });
});
