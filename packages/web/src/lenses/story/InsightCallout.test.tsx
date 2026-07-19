import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { SessionInsight, SessionRef } from "../../api.js";
import { InsightCallout } from "./InsightCallout.js";

/**
 * SSR render tests for the Story tab's FROM-THIS-SESSION insight callout — same
 * `renderToStaticMarkup` + `<MemoryRouter>` approach as the Briefing view tests.
 * Every value the callout shows must come from the `SessionInsight` payload
 * (`GET /api/sessions/<source>/:id/insight`); these assert the headline,
 * recommendations, and provenance badge all trace to that one object.
 */

function insight(overrides: Partial<SessionInsight> = {}): SessionInsight {
  return {
    sessionId: "sess-1",
    source: "claude-code",
    summary: {
      headline: "$12.30 across sonnet, opus; 44% of cost delegated to subagents.",
      costUsd: 12.3,
      costIsComplete: true,
      models: ["sonnet", "opus"],
      delegationShare: 0.44,
    },
    costDrivers: [],
    waste: [
      {
        class: "oversized-return",
        title: "Subagent returns avg 8.2k chars",
        fix: "add a return-size contract to spawn prompts",
        impactUsd: 2.1,
        provenance: { source: "claude-code", sessionId: "sess-1" },
      },
    ],
    delegation: {
      mainCostShare: 0.56,
      subagentCostShare: 0.44,
      subagentCount: 3,
      models: ["sonnet", "opus"],
      oversizedReturnCount: 1,
    },
    recommendations: [
      {
        finding: "Subagent returns avg 8.2k chars",
        change: "add a return-size contract to spawn prompts",
        expectedEffect: "Save ~$2.10 of avoidable spend.",
        impactUsd: 2.1,
        logLearningCall: {
          finding: "Subagent returns avg 8.2k chars",
          change: "add a return-size contract to spawn prompts",
          expectedEffect: "Save ~$2.10 of avoidable spend.",
          sourceSessions: [{ source: "claude-code", sessionId: "sess-1" }],
        },
      },
    ],
    _meta: { approxTokens: 320 },
    ...overrides,
  } as SessionInsight;
}

const ref: SessionRef = { source: "claude-code", id: "sess-1" };

function render(node: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("InsightCallout", () => {
  it("renders the headline, recommendation, and provenance badge from the payload", () => {
    const html = render(<InsightCallout insight={insight()} sessionRef={ref} />);
    expect(html).toContain("From this session");
    expect(html).toContain("44% of cost delegated");
    expect(html).toContain("3 subagents");
    expect(html).toContain("1 oversized return");
    expect(html).toContain("Subagent returns avg 8.2k chars");
    expect(html).toContain("add a return-size contract to spawn prompts");
    // Provenance badge (Pattern C) traces to the analyze_session call.
    expect(html).toContain("analyze_session()");
  });

  it("shows a Log learning button only when onLog is provided", () => {
    const withLog = render(
      <InsightCallout insight={insight()} sessionRef={ref} onLog={() => undefined} />,
    );
    expect(withLog).toContain("Log learning");
    const readOnly = render(<InsightCallout insight={insight()} sessionRef={ref} />);
    expect(readOnly).not.toContain("Log learning");
  });

  it("shows the pending / done states for the recommendation being logged", () => {
    const logging = render(
      <InsightCallout
        insight={insight()}
        sessionRef={ref}
        onLog={() => undefined}
        loggingKey="Subagent returns avg 8.2k chars"
      />,
    );
    expect(logging).toContain("logging…");
    const logged = render(
      <InsightCallout
        insight={insight()}
        sessionRef={ref}
        onLog={() => undefined}
        loggedKeys={new Set(["Subagent returns avg 8.2k chars"])}
      />,
    );
    expect(logged).toContain("logged ✓");
  });

  it("renders the clean-session copy when there are no recommendations", () => {
    const html = render(
      <InsightCallout insight={insight({ recommendations: [], waste: [] })} sessionRef={ref} />,
    );
    expect(html).toContain("looks clean");
  });
});
