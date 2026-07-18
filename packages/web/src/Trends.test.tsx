import type { TrendBucket, TrendsReport } from "@junrei/core";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ALL_REPOS } from "./router.js";
import { Trends } from "./Trends.js";
import { TrendsView } from "./trends/TrendsView.js";

/**
 * Smoke/render tests for the Trends screen. The package has no jsdom or
 * `@testing-library/react` (no other `.tsx` in this package has a render
 * test at all — see the option's own note that packages/web's 351 pre-existing
 * tests are all pure-function tests), and the task disallows adding new
 * dependencies, so these render through `react-dom/server`'s
 * `renderToStaticMarkup` instead: real React rendering (catches thrown
 * errors, bad prop access, etc.) that needs no DOM. `<MemoryRouter>` (from
 * `react-router`, already a dependency) supplies the routing context every
 * `<Link>`/`useSearchParams` call needs.
 *
 * SSR never runs `useEffect`, so `Trends` (the fetch/routing wrapper)
 * renders only its pre-fetch loading state this way — no `fetch` mock is
 * needed for that half. The three fixtures below (typical / null-heavy /
 * empty-window) instead target `TrendsView`, the presentational component
 * `Trends.tsx` renders once a `TrendsReport` has loaded — that's where every
 * null-safety/formatting branch this option calls out actually lives.
 */

const bucketDefaults: Omit<TrendBucket, "date"> = {
  sessionCount: 0,
  userTurnCount: 0,
  totalDurationMs: 0,
  totalCostUsd: 0,
  tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  byModel: [],
  delegation: { main: {}, subagents: {} },
  cacheHitRate: null,
  compactionCount: 0,
  subagentReturn: null,
  bashCalls: 0,
  bashResultChars: 0,
};

function bucket(date: string, overrides: Partial<TrendBucket> = {}): TrendBucket {
  return { date, ...bucketDefaults, ...overrides };
}

function renderView(report: TrendsReport, repoFilter: string = ALL_REPOS): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TrendsView
        report={report}
        windowDays={7}
        repoOptionByKey={new Map()}
        repoFilter={repoFilter}
      />
    </MemoryRouter>,
  );
}

// `Trends.tsx` renders `shell/Band.tsx`, which renders `ThemeToggle.tsx`,
// which reads `window.matchMedia` SYNCHRONOUSLY during render (`theme.ts`'s
// `systemTheme`) — a real browser API this vitest environment (plain Node,
// no jsdom) doesn't provide. Stubbed here, test-file-local, rather than
// touching `theme.ts` itself: every other render (`TrendsView`'s tests
// above/below) never mounts `Band`, so this is scoped to the one test that
// renders the full screen wrapper.
if (typeof window === "undefined") {
  (
    globalThis as unknown as { window: { matchMedia: (q: string) => { matches: boolean } } }
  ).window = {
    matchMedia: () => ({ matches: false }),
  };
}

describe("Trends (screen wrapper)", () => {
  it("renders the controls and loading state without a network fetch (SSR never runs effects)", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Trends />
      </MemoryRouter>,
    );
    expect(html).toContain("Trends");
    expect(html).toContain("Analyzing trends");
    expect(html).toContain("7d");
    expect(html).toContain("14d");
    expect(html).toContain("30d");
  });
});

describe("TrendsView — typical report", () => {
  const report: TrendsReport = {
    window: {
      days: 7,
      timeZone: "UTC",
      bucket: "day",
      startDate: "2026-06-26",
      endDate: "2026-07-02",
      nowMs: Date.parse("2026-07-02T15:00:00.000Z"),
    },
    buckets: [
      bucket("2026-07-01", {
        sessionCount: 3,
        userTurnCount: 10,
        totalDurationMs: 3_600_000,
        totalCostUsd: 5,
        byModel: [{ model: "claude-sonnet-4-5", costUsd: 5, inputTokens: 100, outputTokens: 200 }],
        delegation: { main: { costUsd: 4 }, subagents: { costUsd: 1 } },
        cacheHitRate: 0.5,
        compactionCount: 1,
        subagentReturn: { count: 2, totalChars: 400, maxChars: 300 },
      }),
      bucket("2026-07-02", {
        sessionCount: 5,
        userTurnCount: 20,
        totalDurationMs: 7_200_000,
        totalCostUsd: 42,
        byModel: [
          { model: "claude-opus-4-5", costUsd: 30, inputTokens: 500, outputTokens: 100 },
          { model: "claude-sonnet-4-5", costUsd: 12, inputTokens: 200, outputTokens: 300 },
        ],
        delegation: { main: { costUsd: 20 }, subagents: { costUsd: 22 } },
        cacheHitRate: 0.8,
        compactionCount: 3,
        subagentReturn: { count: 4, totalChars: 4000, maxChars: 40_000 },
      }),
    ],
    summary: {
      current: {
        totalCostUsd: 47,
        sessionCount: 8,
        cacheHitRate: 0.7,
        subagentCostShare: 0.489,
        bashResultChars: 0,
      },
      previous: {
        totalCostUsd: 30,
        sessionCount: 6,
        cacheHitRate: 0.6,
        subagentCostShare: 0.2,
        bashResultChars: 0,
      },
      delta: {
        totalCostUsdPct: 56.7,
        sessionCountPct: 33.3,
        cacheHitRatePts: 10,
        subagentCostSharePts: 28.9,
        bashResultCharsPct: null,
        bashEstUsdPct: null,
      },
    },
    anomalies: {
      spikeDays: [{ date: "2026-07-02", costUsd: 42, mean: 23.5, stddev: 8 }],
      topSessions: [
        {
          sessionId: "11111111-1111-1111-1111-111111111111",
          source: "claude-code",
          repoKey: "/Users/yuya/src/junrei",
          startedAt: "2026-07-02T10:00:00Z",
          totalCostUsd: 30,
          firstUserPrompt: "refactor the trends aggregator",
        },
        {
          sessionId: "22222222-2222-2222-2222-222222222222",
          source: "codex",
          repoKey: "codex-cwd:/Users/yuya/src/junrei",
          totalCostUsd: 12,
        },
      ],
    },
  };

  it("renders without throwing and surfaces the window totals, deltas, and spike marker", () => {
    const html = renderView(report);
    expect(html).toContain("$47");
    expect(html).toContain("+56.7%");
    expect(html).toContain("+10.0pts");
    expect(html).toContain("70%"); // cache hit rate
    expect(html).toContain("49%"); // subagent cost share
    expect(html).toContain("spike");
    expect(html).toContain("refactor the trends aggregator");
    // Both top sessions link to their own session detail route.
    expect(html).toContain("/session/claude-code/11111111-1111-1111-1111-111111111111");
    expect(html).toContain("/session/codex/22222222-2222-2222-2222-222222222222");
  });

  it("never applies a good/bad tone class to a KPI delta — numbers, never grades (docs/concept.md §4.6)", () => {
    const html = renderView(report);
    expect(html).not.toContain("goodtx");
    expect(html).not.toMatch(/class="[^"]*\berrtx\b[^"]*"[^>]*>\s*[+-]\d/);
  });

  it("colors subagents with a plain identity tone (k-sub), never the amber warning class, in the delegation split legend", () => {
    const html = renderView(report);
    expect(html).toContain("k-sub");
    // The legend swatch itself must not also carry `.amb` (the warning/"cost
    // worth noticing" tone) — a `k-sub amb` class pairing would still be the
    // bug this fix removes.
    expect(html).not.toMatch(/class="lgs k-sub amb"/);
  });

  it("links each daily-cost column and spike-day row to the session list, filtered to that exact local calendar day", () => {
    const html = renderView(report, "/Users/yuya/src/junrei");
    expect(html).toContain("/?day=2026-07-01&amp;repo=%2FUsers%2Fyuya%2Fsrc%2Fjunrei");
    expect(html).toContain("/?day=2026-07-02&amp;repo=%2FUsers%2Fyuya%2Fsrc%2Fjunrei");
  });

  it("omits the repo param from drill-down links when no repo filter is active", () => {
    const html = renderView(report, ALL_REPOS);
    expect(html).toContain("/?day=2026-07-01");
    expect(html).not.toContain("repo=all");
  });

  it("shows the window's peak daily cost and the subagent-return panel's estimate label and outlier max", () => {
    const html = renderView(report);
    expect(html).toContain("peak $42");
    expect(html).toContain("≈ tokens (chars÷4)");
    // 40_000 chars ÷ 4 = 10_000 ≈ tokens — the window max sub-label.
    expect(html).toContain("max ≈ 10.0k");
  });

  it("shows sparse x-axis date labels (at least the window's first and last bucket dates)", () => {
    const html = renderView(report);
    expect(html).toContain("Jul 1");
    expect(html).toContain("Jul 2");
  });
});

describe("TrendsView — null-heavy report (no previous window, unpriced/undefined fields throughout)", () => {
  const report: TrendsReport = {
    window: {
      days: 7,
      timeZone: "UTC",
      bucket: "day",
      startDate: "2026-06-25",
      endDate: "2026-07-01",
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
    },
    buckets: [
      bucket("2026-07-01", {
        sessionCount: 2,
        totalCostUsd: 3,
        byModel: [{ model: "gpt-5.6-sol", inputTokens: 50, outputTokens: 50 }], // unpriced: no costUsd
        delegation: { main: {}, subagents: { costUsd: 1 } }, // main unpriced
        cacheHitRate: null,
        subagentReturn: null,
      }),
    ],
    summary: {
      current: {
        totalCostUsd: 3,
        sessionCount: 2,
        cacheHitRate: null,
        subagentCostShare: null,
        bashResultChars: 0,
      },
      previous: null,
      delta: null,
    },
    anomalies: { spikeDays: [], topSessions: [] },
  };

  it("renders every KPI/delta as an em dash rather than throwing on null math", () => {
    const html = renderView(report);
    // cache hit rate / subagent cost share have no denominator this window.
    expect(html).toContain("—");
    // No previous window — every delta em-dashes too (checked via absence of
    // any +/-% or +/-pts token, which would only appear with a real delta).
    expect(html).not.toMatch(/[+-]\d+\.\d(%|pts)/);
  });

  it("marks the delegation column unpriced instead of guessing a cost", () => {
    const html = renderView(report);
    expect(html).toContain("unpriced");
  });

  it("renders the anomalies panel's empty states when there are no spikes/top sessions", () => {
    const html = renderView(report);
    expect(html).toContain("No cost spikes detected in this window.");
    expect(html).toContain("No sessions in this window.");
  });

  it("the subagent-return sparkline degrades to no-data (no Codex/no subagentReturn anywhere) without throwing", () => {
    const html = renderView(report);
    expect(html).toContain("No data in this window.");
  });
});

describe("TrendsView — empty window (zero sessions)", () => {
  const report: TrendsReport = {
    window: {
      days: 7,
      timeZone: "UTC",
      bucket: "day",
      startDate: "2026-06-25",
      endDate: "2026-07-01",
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
    },
    buckets: [bucket("2026-07-01"), bucket("2026-07-02")],
    summary: {
      current: {
        totalCostUsd: 0,
        sessionCount: 0,
        cacheHitRate: null,
        subagentCostShare: null,
        bashResultChars: 0,
      },
      previous: null,
      delta: null,
    },
    anomalies: { spikeDays: [], topSessions: [] },
  };

  it("renders the empty-window note and every chart's own no-data message, never throwing", () => {
    const html = renderView(report);
    expect(html).toContain("No sessions in this window.");
    expect(html).toContain("No priced sessions in this window.");
    expect(html).toContain("No cost spikes detected in this window.");
  });
});
