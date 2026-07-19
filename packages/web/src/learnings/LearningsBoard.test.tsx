import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { BriefingWaste, Learning } from "../api.js";
import { LearningsBoard } from "./LearningsBoard.js";

/** SSR render tests for the Learnings loop board (Pattern B) — same `renderToStaticMarkup` + `<MemoryRouter>` approach as the rest of packages/web. */

function learning(
  overrides: Partial<Learning> & { id: string; status: Learning["status"] },
): Learning {
  return {
    createdAt: "2026-07-10T00:00:00.000Z",
    repo: "/Users/me/junrei",
    sourceSessions: [],
    finding: `finding ${overrides.id}`,
    change: `change ${overrides.id}`,
    proposedBy: "agent",
    ...overrides,
  } as Learning;
}

const waste: BriefingWaste[] = [
  {
    class: "near-duplicate",
    title: "git diff repeated 9×",
    fix: "batch into one call",
    impactUsd: 0.76,
    provenance: { source: "claude-code", sessionId: "sess-9", title: "Tools refactor" },
  },
];

const learnings: Learning[] = [
  learning({ id: "L-016", status: "open" }),
  learning({ id: "L-015", status: "applied" }),
  learning({
    id: "L-014",
    status: "verified",
    verification: { metric: "costPerDayUsd", before: 31, after: 21, windowDays: 14 },
  }),
  learning({ id: "L-012", status: "rejected" }),
];

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LearningsBoard learnings={learnings} waste={waste} briefingApproxTokens={900} />
    </MemoryRouter>,
  );
}

describe("LearningsBoard", () => {
  it("renders the four pipeline columns with their counts", () => {
    const html = render();
    for (const name of ["Measure", "Learn", "Change", "Verify"]) {
      expect(html).toContain(name);
    }
  });

  it("routes the waste feed into Measure and each learning into its status column", () => {
    const html = render();
    expect(html).toContain("git diff repeated 9×"); // Measure (from briefing waste)
    expect(html).toContain("L-016"); // Learn (open)
    expect(html).toContain("L-015"); // Change (applied)
    expect(html).toContain("L-014"); // Verify (verified)
    expect(html).toContain("L-012"); // Verify (rejected)
  });

  it("shows the agent-proposed badge on an open learning and Accept/Dismiss controls", () => {
    const html = render();
    expect(html).toContain("Open · agent");
    expect(html).toContain("Accept");
    expect(html).toContain("Dismiss");
  });

  it("shows a verified learning's before/after effect and the loop-health verified saving", () => {
    const html = render();
    expect(html).toContain("costPerDayUsd: 31 → 21");
    // Σ(before−after) = $10/day, surfaced only because a costPerDayUsd verification exists.
    expect(html).toContain("$10.00/day");
  });

  it("links a Measure card to its provenance session and carries both provenance badges", () => {
    const html = render();
    expect(html).toContain("/session/claude-code/sess-9");
    expect(html).toContain("briefing()");
    expect(html).toContain("learnings()");
  });
});
