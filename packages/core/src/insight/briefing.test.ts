import { describe, expect, it } from "vitest";
import type { BashOpportunity } from "../shared/bash-opportunities.js";
import { computeTrends, type TrendSessionItem } from "../shared/trends.js";
import { type BriefingSessionInput, buildBriefing } from "./briefing.js";
import type { Learning } from "./types.js";

const TZ = "UTC";
// A Sunday noon UTC — the 7-day window is 2026-07-13 .. 2026-07-19.
const NOW = Date.parse("2026-07-19T12:00:00.000Z");

function makeItem(overrides: Partial<TrendSessionItem> & { sessionId: string }): TrendSessionItem {
  return {
    source: "claude-code",
    userTurnCount: 3,
    totalCostUsd: 5,
    compactionCount: 0,
    startedAt: "2026-07-18T09:00:00.000Z",
    usageByModel: [
      {
        model: "opus",
        costUsd: 5,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
      },
    ],
    delegation: { main: { tokens: 1000, costUsd: 4 }, subagents: { tokens: 700, costUsd: 1 } },
    bashSummary: { calls: 2, resultChars: 4000, estUsd: 0.1 },
    ...overrides,
  };
}

function makeOpportunity(overrides: Partial<BashOpportunity> = {}): BashOpportunity {
  return {
    class: "near-duplicate",
    title: "git status run 5×",
    lever: "claude-md-rule",
    fixText: "Cache git status once per turn.",
    estUsdSaved: 0.5,
    savingsBasis: "measured",
    occurrenceCount: 5,
    totalChars: 5000,
    threads: ["main"],
    evidence: [],
    ...overrides,
  };
}

function trends(items: TrendSessionItem[]) {
  return computeTrends(items, { nowMs: NOW, days: 7, timeZone: TZ });
}

describe("buildBriefing", () => {
  it("summarizes the window from the trend report", () => {
    const report = trends([makeItem({ sessionId: "s1" }), makeItem({ sessionId: "s2" })]);
    const briefing = buildBriefing({
      repo: "myrepo",
      days: 7,
      detail: "full",
      trends: report,
      sessions: [],
      learnings: [],
    });
    expect(briefing.repo).toBe("myrepo");
    expect(briefing.summary.sessionCount).toBe(2);
    expect(briefing.summary.costUsd).toBe(10);
    expect(briefing.summary.window.days).toBe(7);
    expect(briefing._meta.approxTokens).toBeGreaterThan(0);
  });

  it("rolls up total recoverable waste ($ and share of cost) into the summary — one server number for the KPI strip, never a client re-sum", () => {
    const report = trends([makeItem({ sessionId: "s1", totalCostUsd: 10 })]);
    // Unpriced opportunity built by dropping estUsdSaved (exactOptionalPropertyTypes
    // forbids setting it to `undefined`) — excluded from the rollup, not counted as $0.
    const { estUsdSaved: _drop, ...unpriced } = makeOpportunity({ savingsBasis: "none" });
    const sessions: BriefingSessionInput[] = [
      {
        source: "claude-code",
        sessionId: "s1",
        opportunities: [
          makeOpportunity({ estUsdSaved: 1.5 }),
          makeOpportunity({ estUsdSaved: 0.5 }),
          unpriced,
        ],
      },
    ];
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions,
      learnings: [],
    });
    expect(briefing.summary.costUsd).toBe(10);
    expect(briefing.summary.wasteUsd).toBeCloseTo(2, 6);
    expect(briefing.summary.wasteShareOfCost).toBeCloseTo(0.2, 6);
  });

  it("reports null waste totals when nothing in the window could be priced", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const { estUsdSaved: _drop, ...unpriced } = makeOpportunity({ savingsBasis: "none" });
    const sessions: BriefingSessionInput[] = [
      { source: "claude-code", sessionId: "s1", opportunities: [unpriced] },
    ];
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions,
      learnings: [],
    });
    expect(briefing.summary.wasteUsd).toBeNull();
    expect(briefing.summary.wasteShareOfCost).toBeNull();
  });

  it("projects the trend window's day buckets into a dailyCosts sparkbar series (oldest-first, one entry per window day)", () => {
    const report = trends([
      makeItem({ sessionId: "s1", startedAt: "2026-07-18T09:00:00.000Z", totalCostUsd: 5 }),
      makeItem({ sessionId: "s2", startedAt: "2026-07-19T09:00:00.000Z", totalCostUsd: 8 }),
    ]);
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [],
      learnings: [],
    });
    // One bucket per calendar day in the 7-day window (2026-07-13 .. 2026-07-19).
    expect(briefing.dailyCosts).toHaveLength(report.buckets.length);
    expect(briefing.dailyCosts).toHaveLength(7);
    // Oldest-first, dates + costs traced verbatim from the trend buckets — the
    // sparkbar can never disagree with the KPI window cost.
    expect(briefing.dailyCosts.map((d) => d.date)).toEqual(report.buckets.map((b) => b.date));
    expect(briefing.dailyCosts.at(-1)).toEqual({ date: "2026-07-19", costUsd: 8 });
    expect(briefing.dailyCosts.find((d) => d.date === "2026-07-18")?.costUsd).toBe(5);
  });

  it("ranks waste across sessions by dollar impact, priced above unpriced", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    // Build the unpriced case by dropping estUsdSaved entirely
    // (exactOptionalPropertyTypes forbids setting it to `undefined`).
    const { estUsdSaved: _drop, ...unpriced } = makeOpportunity({ title: "unpriced" });
    const sessions: BriefingSessionInput[] = [
      {
        source: "claude-code",
        sessionId: "s1",
        title: "Session one",
        opportunities: [
          makeOpportunity({ title: "small", estUsdSaved: 0.2 }),
          makeOpportunity({ title: "big", estUsdSaved: 2 }),
          unpriced,
        ],
      },
    ];
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions,
      learnings: [],
    });
    expect(briefing.waste.map((w) => w.title)).toEqual(["big", "small", "unpriced"]);
    expect(briefing.waste[0]?.impactUsd).toBe(2);
    expect(briefing.waste[0]?.provenance.sessionId).toBe("s1");
  });

  it("includes oversized subagent returns as waste", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [
        {
          source: "claude-code",
          sessionId: "s1",
          opportunities: [],
          oversizedReturns: [{ agentId: "agent-7", returnedChars: 50000, costUsd: 1.2 }],
        },
      ],
      learnings: [],
    });
    const oversized = briefing.waste.find((w) => w.class === "oversized-return");
    expect(oversized).toBeDefined();
    expect(oversized?.impactUsd).toBe(1.2);
  });

  it("derives wins from successful subagent launches, ranked by launch count", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [
        {
          source: "claude-code",
          sessionId: "s1",
          opportunities: [],
          subagentLaunches: [
            { model: "haiku", returnedChars: 800, costUsd: 0.02, status: "completed" },
            { model: "haiku", returnedChars: 1200, costUsd: 0.03, status: "completed" },
            { model: "sonnet", returnedChars: 900, costUsd: 0.1, status: "completed" },
            { model: "opus", returnedChars: 500, status: "failed" },
          ],
        },
      ],
      learnings: [],
    });
    expect(briefing.wins.map((w) => w.model)).toEqual(["haiku", "sonnet"]);
    const haiku = briefing.wins[0];
    expect(haiku?.launches).toBe(2);
    expect(haiku?.successRate).toBe(1);
    expect(haiku?.avgReturnChars).toBe(1000);
    expect(haiku?.avgCostUsd).toBeCloseTo(0.025);
  });

  it("counts learnings by status and lists recent ones newest-first", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const learnings: Learning[] = [
      {
        id: "L-a",
        createdAt: "2026-07-01T00:00:00.000Z",
        repo: "r",
        sourceSessions: [],
        finding: "older open",
        change: "c",
        status: "open",
        proposedBy: "agent",
      },
      {
        id: "L-b",
        createdAt: "2026-07-10T00:00:00.000Z",
        repo: "r",
        sourceSessions: [],
        finding: "newer applied",
        change: "c",
        status: "applied",
        proposedBy: "agent",
      },
    ];
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [],
      learnings,
    });
    expect(briefing.learnings.open).toBe(1);
    expect(briefing.learnings.applied).toBe(1);
    expect(briefing.learnings.recent[0]?.finding).toBe("newer applied");
  });

  it("truncates waste in concise detail and flags it in _meta", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const opportunities = Array.from({ length: 8 }, (_, i) =>
      makeOpportunity({ title: `op-${i}`, estUsdSaved: 8 - i }),
    );
    const briefing = buildBriefing({
      days: 7,
      detail: "concise",
      trends: report,
      sessions: [{ source: "claude-code", sessionId: "s1", opportunities }],
      learnings: [],
    });
    expect(briefing.waste).toHaveLength(5);
    expect(briefing._meta.truncated).toBe(true);
    expect(briefing._meta.truncatedFields).toContainEqual({
      path: "waste",
      shown: 5,
      total: 8,
    });
  });

  it("reports a truncatedFields entry for a full-detail cap (waste beyond the 50-item full-detail limit)", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const opportunities = Array.from({ length: 55 }, (_, i) =>
      makeOpportunity({ title: `op-${i}`, estUsdSaved: 55 - i }),
    );
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [{ source: "claude-code", sessionId: "s1", opportunities }],
      learnings: [],
    });
    expect(briefing.waste).toHaveLength(50);
    expect(briefing._meta.truncated).toBe(true);
    expect(briefing._meta.truncatedFields).toContainEqual({
      path: "waste",
      shown: 50,
      total: 55,
    });
  });

  it("gives 'no sessions' nextSteps when the window is empty", () => {
    const report = trends([]);
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [],
      learnings: [],
    });
    expect(briefing.summary.sessionCount).toBe(0);
    expect(briefing._meta.nextSteps?.[0]).toMatch(/No sessions/);
  });

  it("unions notAvailable across sessions", () => {
    const report = trends([makeItem({ sessionId: "s1" })]);
    const briefing = buildBriefing({
      days: 7,
      detail: "full",
      trends: report,
      sessions: [
        { source: "codex", sessionId: "s1", opportunities: [], notAvailable: ["repetitions"] },
        {
          source: "codex",
          sessionId: "s2",
          opportunities: [],
          notAvailable: ["taskExecutions", "repetitions"],
        },
      ],
      learnings: [],
    });
    expect(briefing.notAvailable?.sort()).toEqual(["repetitions", "taskExecutions"]);
  });
});
