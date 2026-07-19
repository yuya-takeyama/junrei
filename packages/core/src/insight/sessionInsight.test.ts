import { describe, expect, it } from "vitest";
import type { BashOpportunity } from "../shared/bash-opportunities.js";
import type { BashThreadGroup } from "../shared/bash-stats.js";
import type { DelegationSummary } from "../shared/delegation.js";
import { buildSessionInsight, type SessionInsightInput } from "./sessionInsight.js";

function delegation(overrides: Partial<DelegationSummary> = {}): DelegationSummary {
  return {
    main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
    subagents: { tokens: 700, outputTokens: 200, costUsd: 1, messageCount: 5 },
    byModel: [
      {
        model: "opus",
        main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
        subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
      },
      {
        model: "haiku",
        main: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
        subagents: { tokens: 700, outputTokens: 200, costUsd: 1, messageCount: 5 },
      },
    ],
    costIsComplete: true,
    ...overrides,
  };
}

function thread(overrides: Partial<BashThreadGroup> & { thread: string }): BashThreadGroup {
  return {
    calls: 3,
    errors: 0,
    inputChars: 100,
    resultChars: 4000,
    estimatedTokens: 1025,
    charsSharePct: 50,
    ...overrides,
  };
}

function opportunity(overrides: Partial<BashOpportunity> = {}): BashOpportunity {
  return {
    class: "large-result",
    title: "cat of a 40k-char file",
    lever: "command-flag",
    fixText: "Use Read with offset/limit instead of cat.",
    estUsdSaved: 0.8,
    savingsBasis: "heuristic",
    occurrenceCount: 1,
    totalChars: 40000,
    threads: ["main"],
    evidence: [],
    ...overrides,
  };
}

function input(overrides: Partial<SessionInsightInput> = {}): SessionInsightInput {
  return {
    source: "claude-code",
    sessionId: "sess-1",
    title: "My session",
    detail: "full",
    totalCostUsd: 5,
    costIsComplete: true,
    models: ["opus", "haiku"],
    delegation: delegation(),
    opportunities: [opportunity()],
    byThread: [
      thread({ thread: "main", model: "opus", estUsd: 3, resultChars: 6000, charsSharePct: 60 }),
      thread({
        thread: "agent-1",
        model: "haiku",
        estUsd: 0.2,
        resultChars: 4000,
        charsSharePct: 40,
      }),
    ],
    subagentCount: 1,
    ...overrides,
  };
}

describe("buildSessionInsight", () => {
  it("builds a headline summary with delegation share", () => {
    const insight = buildSessionInsight(input());
    expect(insight.sessionId).toBe("sess-1");
    expect(insight.summary.costUsd).toBe(5);
    expect(insight.summary.delegationShare).toBeCloseTo(0.2);
    expect(insight.summary.headline).toMatch(/20% of cost delegated/);
  });

  it("ranks cost drivers by priced spend, unpriced threads last", () => {
    const insight = buildSessionInsight(
      input({
        byThread: [
          thread({ thread: "agent-1", model: "haiku", estUsd: 0.2, resultChars: 4000 }),
          thread({ thread: "main", model: "opus", estUsd: 3, resultChars: 6000 }),
          thread({ thread: "agent-2", resultChars: 9000 }),
        ],
      }),
    );
    expect(insight.costDrivers.map((d) => d.thread)).toEqual(["main", "agent-1", "agent-2"]);
  });

  it("produces recommendations carrying a ready-to-submit logLearningCall", () => {
    const insight = buildSessionInsight(input());
    expect(insight.recommendations).toHaveLength(1);
    const rec = insight.recommendations[0];
    expect(rec?.logLearningCall.finding).toBe("cat of a 40k-char file");
    expect(rec?.logLearningCall.change).toBe("Use Read with offset/limit instead of cat.");
    expect(rec?.logLearningCall.sourceSessions).toEqual([
      { source: "claude-code", sessionId: "sess-1", title: "My session" },
    ]);
    expect(rec?.expectedEffect).toMatch(/Save ~\$0\.80/);
  });

  it("reports delegation health including oversized returns and model mix", () => {
    const insight = buildSessionInsight(
      input({
        subagentReturns: [
          { agentId: "a1", returnedChars: 30000 },
          { agentId: "a2", returnedChars: 100 },
        ],
      }),
    );
    expect(insight.delegation.subagentCount).toBe(1);
    expect(insight.delegation.oversizedReturnCount).toBe(1);
    expect(insight.delegation.models).toEqual(["opus", "haiku"]);
    expect(insight.delegation.subagentCostShare).toBeCloseTo(0.2);
  });

  it("folds oversized returns into ranked waste alongside bash opportunities", () => {
    const insight = buildSessionInsight(
      input({
        opportunities: [opportunity({ estUsdSaved: 0.3 })],
        subagentReturns: [{ agentId: "a1", returnedChars: 60000, costUsd: 2 }],
      }),
    );
    expect(insight.waste[0]?.class).toBe("oversized-return");
    expect(insight.waste[0]?.impactUsd).toBe(2);
  });

  it("truncates waste in concise detail and flags _meta.truncated", () => {
    const opportunities = Array.from({ length: 7 }, (_, i) =>
      opportunity({ title: `op-${i}`, estUsdSaved: 7 - i }),
    );
    const insight = buildSessionInsight(input({ detail: "concise", opportunities }));
    expect(insight.waste).toHaveLength(5);
    expect(insight._meta.truncated).toBe(true);
    expect(insight._meta.truncatedFields).toContainEqual({
      path: "waste",
      shown: 5,
      total: 7,
    });
  });

  it("reports a truncatedFields entry for a full-detail cap (costDrivers beyond the 10-thread full-detail limit)", () => {
    const byThread = Array.from({ length: 11 }, (_, i) =>
      thread({ thread: `agent-${i}`, model: "haiku", estUsd: 11 - i, resultChars: 100 }),
    );
    const insight = buildSessionInsight(input({ detail: "full", byThread }));
    expect(insight.costDrivers).toHaveLength(10);
    expect(insight._meta.truncated).toBe(true);
    expect(insight._meta.truncatedFields).toContainEqual({
      path: "costDrivers",
      shown: 10,
      total: 11,
    });
  });

  it("passes through notAvailable and always supplies nextSteps", () => {
    const insight = buildSessionInsight(input({ source: "codex", notAvailable: ["repetitions"] }));
    expect(insight.notAvailable).toEqual(["repetitions"]);
    expect(insight._meta.nextSteps?.length).toBeGreaterThan(0);
  });

  it("marks delegationShare null when subagent cost is unpriced", () => {
    const insight = buildSessionInsight(
      input({
        delegation: delegation({ subagents: { tokens: 700, outputTokens: 200, messageCount: 5 } }),
      }),
    );
    expect(insight.summary.delegationShare).toBeNull();
    expect(insight.summary.headline).toMatch(/unpriced/);
  });

  describe("archetype classification (from main cost share)", () => {
    it("is fan-out when the main loop holds ≤55% of cost", () => {
      // default input: main $4 of $5 total → mainCostShare 0.8 → mixed; push
      // main down to $2 of $5 (0.4) for a fan-out.
      const insight = buildSessionInsight(
        input({
          delegation: delegation({
            main: { tokens: 1000, outputTokens: 400, costUsd: 2, messageCount: 10 },
          }),
        }),
      );
      expect(insight.summary.mainCostShare).toBeCloseTo(0.4);
      expect(insight.summary.archetype).toBe("fan-out");
    });

    it("is marathon by construction for a zero-subagent, fully-main-priced session", () => {
      const insight = buildSessionInsight(
        input({
          totalCostUsd: 4,
          subagentCount: 0,
          delegation: delegation({
            main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
            subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
            byModel: [
              {
                model: "opus",
                main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
                subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
              },
            ],
          }),
        }),
      );
      expect(insight.summary.mainCostShare).toBeCloseTo(1);
      expect(insight.summary.archetype).toBe("marathon");
    });
  });

  describe("contextLifetime", () => {
    it("warns above 200K with zero compactions", () => {
      const insight = buildSessionInsight(input({ ctxMaxTokens: 480_000, compactionCount: 0 }));
      expect(insight.contextLifetime).toEqual({
        ctxMaxTokens: 480_000,
        compactionCount: 0,
        warning: true,
      });
    });

    it("does not warn when a compaction fired, even at high ctx", () => {
      const insight = buildSessionInsight(input({ ctxMaxTokens: 480_000, compactionCount: 2 }));
      expect(insight.contextLifetime.warning).toBe(false);
    });

    it("defaults to a zeroed, non-warning lifetime when the inputs are absent", () => {
      const insight = buildSessionInsight(input());
      expect(insight.contextLifetime).toEqual({
        ctxMaxTokens: 0,
        compactionCount: 0,
        warning: false,
      });
    });
  });

  describe("delegation.turnBudget", () => {
    it("counts watch (>60) and outliers (>150), worst-first, with cap suggestion in fix text", () => {
      const insight = buildSessionInsight(
        input({
          // main $2/$5 → fan-out, so the outlier recommendation fires too.
          delegation: delegation({
            main: { tokens: 1000, outputTokens: 400, costUsd: 2, messageCount: 10 },
          }),
          subagents: [
            { agentId: "a1", label: "impl", toolCallCount: 252 },
            { agentId: "a2", toolCallCount: 61 },
            { agentId: "a3", toolCallCount: 60 }, // exactly 60 — not watched (strict >)
            { agentId: "a4", toolCallCount: 180 },
          ],
        }),
      );
      expect(insight.delegation.turnBudget.watch).toBe(3); // 252, 61, 180
      expect(insight.delegation.turnBudget.outliers.map((o) => o.agentId)).toEqual(["a1", "a4"]);
      const rec = insight.recommendations.find((r) => /turn budget/i.test(r.change));
      expect(rec?.change).toMatch(/~60 tool calls/);
      expect(rec?.logLearningCall.finding).toMatch(/impl/);
    });

    it("is empty when no subagent material is supplied", () => {
      const insight = buildSessionInsight(input());
      expect(insight.delegation.turnBudget).toEqual({ watch: 0, outliers: [] });
    });
  });

  describe("delegation.opusMessageShare", () => {
    it("derives the Opus-class subagent message share from the delegation split", () => {
      const insight = buildSessionInsight(
        input({
          delegation: delegation({
            byModel: [
              {
                model: "claude-opus-4-8",
                main: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
                subagents: { tokens: 100, outputTokens: 50, costUsd: 1, messageCount: 3 },
              },
              {
                model: "claude-sonnet-4-5",
                main: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
                subagents: { tokens: 100, outputTokens: 50, costUsd: 1, messageCount: 9 },
              },
            ],
          }),
        }),
      );
      expect(insight.delegation.opusMessageShare).toBeCloseTo(3 / 12);
    });

    it("is null when no subagent messages were recorded", () => {
      const insight = buildSessionInsight(
        input({
          delegation: delegation({
            byModel: [
              {
                model: "opus",
                main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
                subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
              },
            ],
          }),
        }),
      );
      expect(insight.delegation.opusMessageShare).toBeNull();
    });
  });

  it("folds a marathon-with-warning into recommendations, ahead of waste fixes", () => {
    const insight = buildSessionInsight(
      input({
        totalCostUsd: 4,
        subagentCount: 0,
        ctxMaxTokens: 480_000,
        compactionCount: 0,
        delegation: delegation({
          main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
          subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
          byModel: [
            {
              model: "opus",
              main: { tokens: 1000, outputTokens: 400, costUsd: 4, messageCount: 10 },
              subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
            },
          ],
        }),
      }),
    );
    expect(insight.summary.archetype).toBe("marathon");
    expect(insight.recommendations[0]?.change).toMatch(/one session per PR|compact/i);
    expect(insight.recommendations[0]?.logLearningCall.change).toMatch(/compact/i);
  });
});
