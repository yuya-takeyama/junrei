import { describe, expect, it } from "vitest";
import { cacheHitRate } from "./metrics.js";
import { computeTrends, type TrendSessionItem } from "./trends.js";

function item(overrides: Partial<TrendSessionItem> = {}): TrendSessionItem {
  return {
    sessionId: "s1",
    source: "claude-code",
    projectDirName: "-Users-me-proj",
    userTurnCount: 1,
    totalCostUsd: 1,
    compactionCount: 0,
    usageByModel: [],
    delegation: { main: { tokens: 0, costUsd: 0 }, subagents: { tokens: 0, costUsd: 0 } },
    ...overrides,
  };
}

describe("computeTrends — local-day (TZ) bucketing", () => {
  it("a session at 2026-07-18T22:00:00Z lands on 2026-07-19 in Asia/Tokyo but 2026-07-18 in UTC", () => {
    const nowMs = Date.parse("2026-07-19T12:00:00.000Z");
    const items = [item({ startedAt: "2026-07-18T22:00:00.000Z", totalCostUsd: 5 })];

    const utcReport = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    const utcBucket = utcReport.buckets.find((b) => b.date === "2026-07-18");
    expect(utcBucket?.sessionCount).toBe(1);
    expect(utcReport.buckets.find((b) => b.date === "2026-07-19")?.sessionCount).toBe(0);

    const tokyoReport = computeTrends(items, { nowMs, days: 7, timeZone: "Asia/Tokyo" });
    const tokyoBucket = tokyoReport.buckets.find((b) => b.date === "2026-07-19");
    expect(tokyoBucket?.sessionCount).toBe(1);
    expect(tokyoReport.buckets.find((b) => b.date === "2026-07-18")?.sessionCount).toBe(0);
  });
});

describe("computeTrends — window shape", () => {
  it("returns startDate/endDate spanning the current window, and echoes back days/timeZone/nowMs", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const report = computeTrends([], { nowMs, days: 7, timeZone: "UTC" });
    expect(report.window).toEqual({
      days: 7,
      timeZone: "UTC",
      bucket: "day",
      startDate: "2026-07-08",
      endDate: "2026-07-14",
      nowMs,
    });
  });

  it("produces exactly `days` consecutive calendar dates even across a DST transition (America/New_York spring-forward, 2026-03-08)", () => {
    const nowMs = Date.parse("2026-03-12T12:00:00.000Z");
    const report = computeTrends([], { nowMs, days: 14, timeZone: "America/New_York" });
    expect(report.buckets).toHaveLength(14);
    const dates = report.buckets.map((b) => b.date);
    for (let i = 1; i < dates.length; i++) {
      const prev = dates[i - 1] as string;
      const cur = dates[i] as string;
      const expectedNext = new Date(`${prev}T00:00:00.000Z`);
      expectedNext.setUTCDate(expectedNext.getUTCDate() + 1);
      expect(cur).toBe(expectedNext.toISOString().slice(0, 10));
    }
  });
});

describe("computeTrends — today's sessions land in today's own bucket (the calendar-day-window-alignment bug)", () => {
  it("sum(buckets[].sessionCount)/totalCostUsd across the whole window, including today, equals summary.current — true by construction now", () => {
    const nowMs = Date.parse("2026-07-14T15:00:00.000Z");
    const items = [
      item({ sessionId: "a", startedAt: "2026-07-08T01:00:00.000Z", totalCostUsd: 3 }), // window's first day
      item({ sessionId: "b", startedAt: "2026-07-11T09:00:00.000Z", totalCostUsd: 4 }),
      item({ sessionId: "today1", startedAt: "2026-07-14T02:00:00.000Z", totalCostUsd: 10 }), // today, before "now"
      item({ sessionId: "today2", startedAt: "2026-07-14T14:00:00.000Z", totalCostUsd: 6 }), // today, moments before "now"
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });

    const bucketSessionSum = report.buckets.reduce((sum, b) => sum + b.sessionCount, 0);
    const bucketCostSum = report.buckets.reduce((sum, b) => sum + b.totalCostUsd, 0);
    expect(bucketSessionSum).toBe(report.summary.current.sessionCount);
    expect(bucketCostSum).toBeCloseTo(report.summary.current.totalCostUsd);
    expect(report.summary.current.sessionCount).toBe(4);

    const todayBucket = report.buckets.find((b) => b.date === "2026-07-14");
    expect(todayBucket?.sessionCount).toBe(2);
    expect(todayBucket?.totalCostUsd).toBe(16);
  });

  it("a session started moments ago lands in today's own bucket instead of being dropped from every per-day panel — UTC and Asia/Tokyo variants", () => {
    const nowMs = Date.parse("2026-07-14T23:30:00.000Z");
    const items = [item({ startedAt: "2026-07-14T23:00:00.000Z", totalCostUsd: 9 })]; // 30 minutes before "now"

    const utc = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    expect(utc.window.endDate).toBe("2026-07-14");
    expect(utc.buckets.find((b) => b.date === "2026-07-14")?.sessionCount).toBe(1);
    expect(utc.summary.current.sessionCount).toBe(1);

    // In Asia/Tokyo (UTC+9) both "now" and the session's start fall on the next calendar day.
    const tokyo = computeTrends(items, { nowMs, days: 7, timeZone: "Asia/Tokyo" });
    expect(tokyo.window.endDate).toBe("2026-07-15");
    expect(tokyo.buckets.find((b) => b.date === "2026-07-15")?.sessionCount).toBe(1);
    expect(tokyo.summary.current.sessionCount).toBe(1);
  });
});

describe("computeTrends — zero-fill continuity", () => {
  it("produces one bucket per calendar day in the window even with no sessions at all", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const report = computeTrends([], { nowMs, days: 14, timeZone: "UTC" });
    expect(report.buckets).toHaveLength(14);
    expect(report.buckets.map((b) => b.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
      "2026-07-13",
      "2026-07-14",
    ]);
    for (const bucket of report.buckets) {
      expect(bucket.sessionCount).toBe(0);
      expect(bucket.totalCostUsd).toBe(0);
      expect(bucket.cacheHitRate).toBeNull();
      expect(bucket.subagentReturn).toBeNull();
      expect(bucket.byModel).toEqual([]);
    }
    expect(report.window.days).toBe(14);
  });

  it("fills gap days between two sparse sessions with zeroed buckets", () => {
    const nowMs = Date.parse("2026-07-07T12:00:00.000Z");
    const items = [
      item({ sessionId: "a", startedAt: "2026-07-01T01:00:00.000Z", totalCostUsd: 2 }),
      item({ sessionId: "b", startedAt: "2026-07-06T01:00:00.000Z", totalCostUsd: 3 }),
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    const byDate = new Map(report.buckets.map((b) => [b.date, b]));
    expect(byDate.get("2026-07-01")?.sessionCount).toBe(1);
    expect(byDate.get("2026-07-06")?.sessionCount).toBe(1);
    for (const gapDate of ["2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]) {
      expect(byDate.get(gapDate)?.sessionCount).toBe(0);
    }
  });
});

describe("computeTrends — byModel and delegation aggregation", () => {
  it("merges usageByModel across sessions in the same bucket, summing per model", () => {
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const items = [
      item({
        sessionId: "a",
        startedAt: "2026-07-01T01:00:00.000Z",
        usageByModel: [
          {
            model: "sonnet",
            costUsd: 3,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
          },
        ],
      }),
      item({
        sessionId: "b",
        startedAt: "2026-07-01T02:00:00.000Z",
        usageByModel: [
          {
            model: "sonnet",
            costUsd: 2,
            inputTokens: 40,
            outputTokens: 20,
            cacheReadTokens: 4,
            cacheCreationTokens: 1,
          },
          {
            model: "haiku",
            costUsd: 0.5,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      }),
    ];
    const report = computeTrends(items, { nowMs, days: 1, timeZone: "UTC" });
    const bucket = report.buckets[0];
    expect(bucket?.byModel).toEqual([
      { model: "sonnet", costUsd: 5, inputTokens: 140, outputTokens: 70 },
      { model: "haiku", costUsd: 0.5, inputTokens: 10, outputTokens: 5 },
    ]);
    expect(bucket?.tokens).toEqual({
      inputTokens: 150,
      outputTokens: 75,
      cacheReadTokens: 14,
      cacheCreationTokens: 6,
    });
  });

  it("sums main/subagents delegation cost across sessions in the same bucket", () => {
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const items = [
      item({
        sessionId: "a",
        startedAt: "2026-07-01T01:00:00.000Z",
        delegation: { main: { tokens: 10, costUsd: 1 }, subagents: { tokens: 30, costUsd: 3 } },
      }),
      item({
        sessionId: "b",
        startedAt: "2026-07-01T02:00:00.000Z",
        delegation: { main: { tokens: 5, costUsd: 0.5 }, subagents: { tokens: 15, costUsd: 1.5 } },
      }),
    ];
    const report = computeTrends(items, { nowMs, days: 1, timeZone: "UTC" });
    expect(report.buckets[0]?.delegation).toEqual({
      main: { costUsd: 1.5 },
      subagents: { costUsd: 4.5 },
    });
  });

  it("drops a bucket's delegation costUsd once any contributing session's slice is unpriced", () => {
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const items = [
      item({
        startedAt: "2026-07-01T01:00:00.000Z",
        delegation: { main: { tokens: 10, costUsd: 1 }, subagents: { tokens: 30 } },
      }),
    ];
    const report = computeTrends(items, { nowMs, days: 1, timeZone: "UTC" });
    expect(report.buckets[0]?.delegation.main).toEqual({ costUsd: 1 });
    expect(report.buckets[0]?.delegation.subagents.costUsd).toBeUndefined();
  });

  it("merges subagentReturn across sessions (maxChars is the max, not a sum) and null-safely skips sessions without one", () => {
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const items = [
      item({
        sessionId: "a",
        startedAt: "2026-07-01T01:00:00.000Z",
        subagentReturn: { count: 2, totalChars: 400, maxChars: 250 },
      }),
      item({ sessionId: "b", source: "codex", startedAt: "2026-07-01T02:00:00.000Z" }), // no subagentReturn (Codex)
      item({
        sessionId: "c",
        startedAt: "2026-07-01T03:00:00.000Z",
        subagentReturn: { count: 1, totalChars: 100, maxChars: 100 },
      }),
    ];
    const report = computeTrends(items, { nowMs, days: 1, timeZone: "UTC" });
    expect(report.buckets[0]?.subagentReturn).toEqual({ count: 3, totalChars: 500, maxChars: 250 });
  });
});

describe("computeTrends — cacheHitRate reuse", () => {
  it("a single-session bucket's cacheHitRate matches calling the shared formula on that session's own totals", () => {
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const usageByModel = [
      {
        model: "sonnet",
        costUsd: 1,
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 700,
        cacheCreationTokens: 100,
      },
    ];
    const items = [item({ startedAt: "2026-07-01T01:00:00.000Z", usageByModel })];
    const report = computeTrends(items, { nowMs, days: 1, timeZone: "UTC" });
    const expected = cacheHitRate({
      inputTokens: 200,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    });
    expect(report.buckets[0]?.cacheHitRate).toBeCloseTo(expected);
    expect(report.summary.current.cacheHitRate).toBeCloseTo(expected);
  });

  it("is null (not 0) for a bucket/window with no effective-input tokens at all", () => {
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const items = [item({ startedAt: "2026-07-01T01:00:00.000Z", usageByModel: [] })];
    const report = computeTrends(items, { nowMs, days: 1, timeZone: "UTC" });
    expect(report.buckets[0]?.cacheHitRate).toBeNull();
    expect(report.summary.current.cacheHitRate).toBeNull();
  });
});

describe("computeTrends — previous-window summary and delta", () => {
  it("computes previous-window totals from items before the current window's first day and a null-safe delta", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const items = [
      // Current window (2026-07-08..14).
      item({ sessionId: "cur1", startedAt: "2026-07-09T00:00:00.000Z", totalCostUsd: 10 }),
      item({ sessionId: "cur2", startedAt: "2026-07-10T00:00:00.000Z", totalCostUsd: 10 }),
      // Previous window (the 7 days immediately before, 2026-07-01..07).
      item({ sessionId: "prev1", startedAt: "2026-07-02T00:00:00.000Z", totalCostUsd: 5 }),
      item({ sessionId: "prev2", startedAt: "2026-07-03T00:00:00.000Z", totalCostUsd: 5 }),
      // Outside both windows entirely.
      item({ sessionId: "old", startedAt: "2026-06-01T00:00:00.000Z", totalCostUsd: 999 }),
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });

    expect(report.summary.current.totalCostUsd).toBe(20);
    expect(report.summary.current.sessionCount).toBe(2);
    expect(report.summary.previous?.totalCostUsd).toBe(10);
    expect(report.summary.previous?.sessionCount).toBe(2);

    // (20 - 10) / 10 * 100 = 100% cost growth; (2 - 2) / 2 * 100 = 0% session-count change.
    expect(report.summary.delta?.totalCostUsdPct).toBeCloseTo(100);
    expect(report.summary.delta?.sessionCountPct).toBeCloseTo(0);
  });

  it("previous is null when the prior window has zero matching sessions, and so is delta", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const items = [item({ startedAt: "2026-07-09T00:00:00.000Z", totalCostUsd: 10 })];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    expect(report.summary.previous).toBeNull();
    expect(report.summary.delta).toBeNull();
  });

  it("totalCostUsdPct is null (not Infinity) when the previous window's cost was exactly 0", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const items = [
      item({ sessionId: "cur", startedAt: "2026-07-09T00:00:00.000Z", totalCostUsd: 10 }),
      item({ sessionId: "prev", startedAt: "2026-07-02T00:00:00.000Z", totalCostUsd: 0 }),
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    expect(report.summary.previous?.totalCostUsd).toBe(0);
    expect(report.summary.delta?.totalCostUsdPct).toBeNull();
  });
});

describe("computeTrends — spike detection", () => {
  it("does not flag anything when fewer than 4 days in the window have sessions", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const items = [
      item({ sessionId: "a", startedAt: "2026-07-01T01:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "b", startedAt: "2026-07-02T01:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "c", startedAt: "2026-07-03T01:00:00.000Z", totalCostUsd: 100 }), // would otherwise be a huge outlier
    ];
    const report = computeTrends(items, { nowMs, days: 14, timeZone: "UTC" });
    expect(report.anomalies.spikeDays).toEqual([]);
  });

  it("flags a day whose cost is more than 2 population-stddev above the window's mean", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    // 4 quiet, evenly-costed active days plus one huge spike day; the rest
    // of the 14-day window stays zero-filled (included in mean/stddev — see
    // `computeSpikeDays`'s doc comment).
    const items = [
      item({ sessionId: "a", startedAt: "2026-07-01T01:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "b", startedAt: "2026-07-02T01:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "c", startedAt: "2026-07-03T01:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "d", startedAt: "2026-07-04T01:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "spike", startedAt: "2026-07-05T01:00:00.000Z", totalCostUsd: 500 }),
    ];
    const report = computeTrends(items, { nowMs, days: 14, timeZone: "UTC" });
    expect(report.anomalies.spikeDays).toHaveLength(1);
    expect(report.anomalies.spikeDays[0]?.date).toBe("2026-07-05");
    expect(report.anomalies.spikeDays[0]?.costUsd).toBe(500);
    expect(report.anomalies.spikeDays[0]?.mean).toBeGreaterThan(0);
    expect(report.anomalies.spikeDays[0]?.stddev).toBeGreaterThan(0);
  });

  it("does not flag any day when costs are all equal (stddev 0, nothing exceeds the mean)", () => {
    const nowMs = Date.parse("2026-07-04T12:00:00.000Z");
    const items = [
      item({ sessionId: "a", startedAt: "2026-07-01T01:00:00.000Z", totalCostUsd: 10 }),
      item({ sessionId: "b", startedAt: "2026-07-02T01:00:00.000Z", totalCostUsd: 10 }),
      item({ sessionId: "c", startedAt: "2026-07-03T01:00:00.000Z", totalCostUsd: 10 }),
      item({ sessionId: "d", startedAt: "2026-07-04T01:00:00.000Z", totalCostUsd: 10 }),
    ];
    const report = computeTrends(items, { nowMs, days: 4, timeZone: "UTC" });
    expect(report.anomalies.spikeDays).toEqual([]);
  });
});

describe("computeTrends — topSessions ordering/limit", () => {
  it("returns at most the top 5 CURRENT-window sessions by cost, descending", () => {
    const nowMs = Date.parse("2026-07-07T12:00:00.000Z");
    const items = Array.from({ length: 8 }, (_, i) =>
      item({
        sessionId: `s${String(i)}`,
        startedAt: "2026-07-02T00:00:00.000Z",
        totalCostUsd: i,
      }),
    );
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    expect(report.anomalies.topSessions).toHaveLength(5);
    expect(report.anomalies.topSessions.map((s) => s.sessionId)).toEqual([
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
    ]);
  });

  it("excludes previous-window sessions from topSessions even if they're more expensive", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const items = [
      item({ sessionId: "cur", startedAt: "2026-07-09T00:00:00.000Z", totalCostUsd: 1 }),
      item({ sessionId: "prev", startedAt: "2026-07-02T00:00:00.000Z", totalCostUsd: 999 }),
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    expect(report.anomalies.topSessions.map((s) => s.sessionId)).toEqual(["cur"]);
  });

  it("truncates firstUserPrompt to ~120 chars and carries repoKey/startedAt through", () => {
    const nowMs = Date.parse("2026-07-07T12:00:00.000Z");
    const longPrompt = "x".repeat(200);
    const items = [
      item({
        startedAt: "2026-07-02T00:00:00.000Z",
        totalCostUsd: 9,
        firstUserPrompt: longPrompt,
        repoRoot: "/Users/me/junrei",
      }),
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC" });
    const [top] = report.anomalies.topSessions;
    expect(top?.repoKey).toBe("/Users/me/junrei");
    expect(top?.startedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(top?.firstUserPrompt?.length).toBeLessThanOrEqual(121); // 120 chars + ellipsis
    expect(top?.firstUserPrompt?.startsWith("x".repeat(120))).toBe(true);
  });
});

describe("computeTrends — repo filtering", () => {
  it("matches sessions by repoRoot and excludes sessions from other repos, in both windows", () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const REPO = "/Users/me/junrei";
    const items = [
      item({
        sessionId: "a",
        repoRoot: REPO,
        startedAt: "2026-07-09T00:00:00.000Z",
        totalCostUsd: 3,
      }),
      item({
        sessionId: "b",
        repoRoot: "/Users/me/other",
        startedAt: "2026-07-09T00:00:00.000Z",
        totalCostUsd: 7,
      }),
      item({
        sessionId: "c",
        repoRoot: REPO,
        startedAt: "2026-07-02T00:00:00.000Z",
        totalCostUsd: 1,
      }),
      item({
        sessionId: "d",
        repoRoot: "/Users/me/other",
        startedAt: "2026-07-02T00:00:00.000Z",
        totalCostUsd: 1,
      }),
    ];
    const report = computeTrends(items, { nowMs, days: 7, timeZone: "UTC", repo: REPO });
    expect(report.summary.current.sessionCount).toBe(1);
    expect(report.summary.current.totalCostUsd).toBe(3);
    expect(report.summary.previous?.sessionCount).toBe(1);
    expect(report.summary.previous?.totalCostUsd).toBe(1);
    expect(report.anomalies.topSessions.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("falls back to a projectDirName-keyed bucket for a Claude session with no repoRoot", () => {
    const nowMs = Date.parse("2026-07-07T12:00:00.000Z");
    const items = [
      item({
        sessionId: "a",
        projectDirName: "-Users-me-proj",
        startedAt: "2026-07-02T00:00:00.000Z",
      }),
      item({
        sessionId: "b",
        projectDirName: "-Users-other-proj",
        startedAt: "2026-07-02T00:00:00.000Z",
      }),
    ];
    const report = computeTrends(items, {
      nowMs,
      days: 7,
      timeZone: "UTC",
      repo: "claude-project:-Users-me-proj",
    });
    expect(report.summary.current.sessionCount).toBe(1);
    expect(report.anomalies.topSessions.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("falls back to a codex-repo:<url> bucket, and a codex-cwd:<cwd> bucket, for Codex sessions with no repoRoot", () => {
    const nowMs = Date.parse("2026-07-07T12:00:00.000Z");
    const items = [
      item({
        sessionId: "a",
        source: "codex",
        repoUrl: "github.com/me/proj",
        startedAt: "2026-07-02T00:00:00.000Z",
      }),
      item({
        sessionId: "b",
        source: "codex",
        cwd: "/Users/me/x",
        startedAt: "2026-07-02T00:00:00.000Z",
      }),
    ];
    const byUrl = computeTrends(items, {
      nowMs,
      days: 7,
      timeZone: "UTC",
      repo: "codex-repo:github.com/me/proj",
    });
    expect(byUrl.anomalies.topSessions.map((s) => s.sessionId)).toEqual(["a"]);

    const byCwd = computeTrends(items, {
      nowMs,
      days: 7,
      timeZone: "UTC",
      repo: "codex-cwd:/Users/me/x",
    });
    expect(byCwd.anomalies.topSessions.map((s) => s.sessionId)).toEqual(["b"]);
  });
});
