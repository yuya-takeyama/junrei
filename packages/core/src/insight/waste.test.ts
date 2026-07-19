import { describe, expect, it } from "vitest";
import type { BashOpportunity } from "../shared/bash-opportunities.js";
import type { WasteItem } from "./types.js";
import {
  OVERSIZED_RETURN_CHARS,
  opportunitiesToWaste,
  oversizedReturnsToWaste,
  rankWaste,
} from "./waste.js";

const PROV = { source: "claude-code" as const, sessionId: "s1", title: "t" };

function op(overrides: Partial<BashOpportunity>): BashOpportunity {
  return {
    class: "near-duplicate",
    title: "t",
    lever: "claude-md-rule",
    fixText: "f",
    savingsBasis: "measured",
    occurrenceCount: 1,
    totalChars: 1,
    threads: ["main"],
    evidence: [],
    ...overrides,
  };
}

describe("opportunitiesToWaste", () => {
  it("maps class/title/fix and carries impact + provenance", () => {
    const [item] = opportunitiesToWaste([op({ estUsdSaved: 1.5 })], PROV);
    expect(item).toMatchObject({
      class: "near-duplicate",
      fix: "f",
      impactUsd: 1.5,
      provenance: { source: "claude-code", sessionId: "s1", title: "t" },
    });
  });

  it("omits impactUsd when the opportunity has no priced savings", () => {
    const { estUsdSaved: _drop, ...unpriced } = op({});
    const [item] = opportunitiesToWaste([unpriced], PROV);
    expect(item && "impactUsd" in item).toBe(false);
  });
});

describe("oversizedReturnsToWaste", () => {
  it("keeps only returns at or above the threshold", () => {
    const items = oversizedReturnsToWaste(
      [
        { agentId: "a", returnedChars: OVERSIZED_RETURN_CHARS },
        { agentId: "b", returnedChars: OVERSIZED_RETURN_CHARS - 1 },
      ],
      PROV,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.class).toBe("oversized-return");
  });
});

describe("rankWaste", () => {
  it("orders by impact desc with unknown-impact items last", () => {
    const items: WasteItem[] = [
      {
        class: "large-result",
        title: "unknown",
        fix: "f",
        provenance: { source: "codex", sessionId: "s" },
      },
      {
        class: "large-result",
        title: "cheap",
        fix: "f",
        impactUsd: 1,
        provenance: { source: "codex", sessionId: "s" },
      },
      {
        class: "large-result",
        title: "pricey",
        fix: "f",
        impactUsd: 9,
        provenance: { source: "codex", sessionId: "s" },
      },
    ];
    expect(rankWaste(items).map((i) => i.title)).toEqual(["pricey", "cheap", "unknown"]);
  });
});
