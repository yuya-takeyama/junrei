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
});
