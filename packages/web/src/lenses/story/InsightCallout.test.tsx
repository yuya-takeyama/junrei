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
      headline: "$12.30 across sonnet, opus; 44% of cost delegated to subagents (mixed).",
      costUsd: 12.3,
      costIsComplete: true,
      models: ["sonnet", "opus"],
      delegationShare: 0.44,
      archetype: "mixed",
      mainCostShare: 0.56,
    },
    contextLifetime: { ctxMaxTokens: 120_000, compactionCount: 0, warning: false },
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
      turnBudget: { watch: 0, outliers: [] },
      opusMessageShare: 0.3,
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

  it("shows the pending state for the recommendation being logged", () => {
    const logging = render(
      <InsightCallout
        insight={insight()}
        sessionRef={ref}
        onLog={() => undefined}
        loggingKey="Subagent returns avg 8.2k chars"
      />,
    );
    expect(logging).toContain("logging…");
  });

  it("replaces a logged recommendation's button with a link to the Learnings board (undo = Dismiss)", () => {
    const logged = render(
      <InsightCallout
        insight={insight()}
        sessionRef={ref}
        onLog={() => undefined}
        loggedKeys={new Set(["Subagent returns avg 8.2k chars"])}
      />,
    );
    // Post-write feedback: no confirm dialog, the button becomes a link.
    expect(logged).toContain("Logged ✓ → View in Learnings");
    expect(logged).toContain('href="/learnings"');
    // The tooltip documents the undo path (Dismiss on the Learnings board).
    expect(logged).toContain("To undo, use Dismiss on the Learnings board.");
    // The re-log button is gone once the recommendation is logged.
    expect(logged).not.toContain("Log learning");
  });

  it("renders the clean-session copy when there are no recommendations", () => {
    const html = render(
      <InsightCallout insight={insight({ recommendations: [], waste: [] })} sessionRef={ref} />,
    );
    expect(html).toContain("looks clean");
  });

  it("renders the cost-share archetype badge from the payload", () => {
    const html = render(<InsightCallout insight={insight()} sessionRef={ref} />);
    expect(html).toMatch(/class="abadge mixed"[^>]*>mixed</);
  });

  it("shows the context-lifetime warning line only when contextLifetime.warning is set", () => {
    const clean = render(<InsightCallout insight={insight()} sessionRef={ref} />);
    expect(clean).not.toContain("context ran to");

    const warned = render(
      <InsightCallout
        insight={insight({
          summary: { ...insight().summary, archetype: "marathon", mainCostShare: 0.95 },
          contextLifetime: { ctxMaxTokens: 480_000, compactionCount: 0, warning: true },
        })}
        sessionRef={ref}
      />,
    );
    expect(warned).toContain("context ran to 480,000 tokens with 0");
    expect(warned).toMatch(/class="abadge marathon"[^>]*>marathon</);
  });

  it("renders the What-if card only when whatIf is present, with server values", () => {
    const without = render(<InsightCallout insight={insight()} sessionRef={ref} />);
    expect(without).not.toContain("whatif-card");

    const withWhatIf = render(
      <InsightCallout
        insight={insight({
          whatIf: [
            {
              scenario: "compaction-policy",
              basis: "counterfactual-model",
              thresholdTokens: 200_000,
              baselineTokens: 30_000,
              resetCount: 2,
              estSavedTokens: 1_200_000,
              estSavedUsd: 1.8,
              baselineModelCostUsd: 4,
              estSavedPct: 0.45,
              pricingComplete: true,
              assumptions: [
                "Counterfactual compaction resets context to baseline B=30,000 tokens.",
              ],
            },
            {
              scenario: "evict-heavy-results",
              skipped: true,
              reason: "no tool result larger than 100,000 chars to evict",
            },
          ],
        } as Partial<SessionInsight>)}
        sessionRef={ref}
      />,
    );
    expect(withWhatIf).toContain("whatif-card");
    expect(withWhatIf).toContain("Compact at threshold");
    expect(withWhatIf).toContain("(45%)"); // estSavedPct from the payload
    expect(withWhatIf).toContain("Evict heavy results");
    expect(withWhatIf).toContain("no tool result larger"); // skipped reason surfaced
  });
});
