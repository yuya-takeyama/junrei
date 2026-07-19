import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Briefing } from "../api.js";
import { BriefingView } from "./BriefingView.js";

/**
 * SSR render tests for the Briefing home body (Pattern A). Same approach as
 * the rest of packages/web's render tests: `renderToStaticMarkup` (no jsdom in
 * this package) inside a `<MemoryRouter>` for the `<Link>`s. Every value the
 * view shows must come from the `Briefing` payload — these assert the KPI
 * numbers, section metas, and provenance badge all trace to that one object.
 */

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    repo: "/Users/me/junrei",
    summary: {
      window: { days: 7, startDate: "2026-07-13", endDate: "2026-07-19" },
      costUsd: 23.4,
      sessionCount: 4,
      archetypeDistribution: { marathon: 1, fanOut: 2, mixed: 1 },
      contextLifetimeWarnings: 1,
      wasteUsd: 4.1,
      wasteCount: 2,
      wasteShareOfCost: 0.175,
      cacheHitRate: 0.96,
      delegationShare: 0.42,
      delta: {
        costUsdPct: -25,
        sessionCountPct: 10,
        cacheHitRatePts: 2,
        delegationSharePts: 5,
      },
    },
    waste: [
      {
        class: "oversized-return",
        title: "Subagent returns avg 8.2k chars",
        fix: "add a return-size contract to spawn prompts",
        impactUsd: 2.1,
        provenance: { source: "claude-code", sessionId: "sess-1", title: "Tools tab refactor" },
      },
    ],
    wins: [{ model: "sonnet", launches: 5, successRate: 1, avgReturnChars: 900, avgCostUsd: 0.84 }],
    learnings: {
      open: 1,
      applied: 1,
      verified: 1,
      rejected: 0,
      recent: [
        { id: "L-016", finding: "Cap verify panels at 3.", status: "open" },
        { id: "L-015", finding: "Mandate Read/Grep/Glob.", status: "applied" },
      ],
    },
    dailyCosts: [
      { date: "2026-07-18", costUsd: 31 },
      { date: "2026-07-19", costUsd: 23.4 },
    ],
    topSessions: [],
    _meta: { approxTokens: 1234, nextSteps: ["Call analyze_session on sess-1."] },
    ...overrides,
  };
}

function render(b: Briefing): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BriefingView briefing={b} approxTokens={b._meta.approxTokens} />
    </MemoryRouter>,
  );
}

describe("BriefingView — populated window", () => {
  it("renders the KPI strip straight from summary values (cost, waste, delegation, cache)", () => {
    const html = render(briefing());
    expect(html).toContain("$23.40"); // cost
    expect(html).toContain("$4.10"); // waste $
    expect(html).toContain("42%"); // delegation share
    expect(html).toContain("96%"); // cache hit
    expect(html).toContain("↓25% vs prev"); // cost delta, muted arrow (no tone)
  });

  it("shows the waste section total + share from the SAME server field the KPI uses (never a client re-sum)", () => {
    const html = render(briefing());
    // WASTE header meta reads $4.10 recoverable · 18% — the summary.wasteUsd /
    // wasteShareOfCost fields, identical to the KPI card.
    expect(html).toContain("$4.10 recoverable");
    expect(html).toContain("18%"); // 0.175 rounded
  });

  it("renders each waste row's title, fix, and provenance link", () => {
    const html = render(briefing());
    expect(html).toContain("Subagent returns avg 8.2k chars");
    expect(html).toContain("add a return-size contract to spawn prompts");
    expect(html).toContain("/session/claude-code/sess-1");
  });

  it("shows the Log learning button only when an onLogWaste handler is wired", () => {
    expect(render(briefing())).not.toContain("Log learning"); // read-only render
    const interactive = renderToStaticMarkup(
      <MemoryRouter>
        <BriefingView briefing={briefing()} approxTokens={1234} onLogWaste={() => undefined} />
      </MemoryRouter>,
    );
    expect(interactive).toContain("Log learning");
  });

  it("renders the learnings cards, wins, and the provenance badge naming briefing()", () => {
    const html = render(briefing());
    expect(html).toContain("L-016");
    expect(html).toContain("Cap verify panels at 3.");
    expect(html).toContain("sonnet");
    expect(html).toContain("briefing()");
    expect(html).toContain("~1.2kt"); // approxTokens badge
  });

  it("renders the sparkbar with a bar per daily-cost entry, tinting today", () => {
    const html = render(briefing());
    expect(html).toContain("spark-bar today");
    expect(html).toContain("last 2-day cost");
  });

  it("never applies a good/bad tone class to a delta (numbers, never grades)", () => {
    const html = render(briefing());
    // The delta strings render in the muted `.kpi-sub mut` class — never errtx/t-gr next to a signed number.
    expect(html).not.toMatch(/class="[^"]*\bt-gr\b[^"]*"[^>]*>[^<]*↓25%/);
  });
});

describe("BriefingView — empty window", () => {
  it("renders the briefing's own nextSteps instead of empty sections", () => {
    const html = render(
      briefing({
        summary: {
          window: { days: 1, startDate: "2026-07-19", endDate: "2026-07-19" },
          costUsd: 0,
          sessionCount: 0,
          archetypeDistribution: { marathon: 0, fanOut: 0, mixed: 0 },
          contextLifetimeWarnings: 0,
          wasteUsd: null,
          wasteCount: 0,
          wasteShareOfCost: null,
          cacheHitRate: null,
          delegationShare: null,
          delta: null,
        },
        waste: [],
        wins: [],
        learnings: { open: 0, applied: 0, verified: 0, rejected: 0, recent: [] },
        dailyCosts: [],
        _meta: { approxTokens: 40, nextSteps: ["Widen the period, or check the repo filter."] },
      }),
    );
    expect(html).toContain("Nothing in this window");
    expect(html).toContain("Widen the period, or check the repo filter.");
    // KPI strip still renders, em-dashing the null rates.
    expect(html).toContain("—");
  });
});
