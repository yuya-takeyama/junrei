import { describe, expect, it } from "vitest";
import { findPatterns, type PatternSessionInput, type PatternTextHit } from "./patterns.js";

describe("findPatterns text", () => {
  const hits: PatternTextHit[] = Array.from({ length: 15 }, (_, i) => ({
    source: "claude-code",
    sessionId: `s${i}`,
    field: "assistant",
    excerpt: `match ${i}`,
  }));

  it("wraps hits and truncates in concise detail", () => {
    const result = findPatterns({ kind: "text", detail: "concise", query: "foo", hits });
    expect(result.kind).toBe("text");
    expect(result.query).toBe("foo");
    expect(result.textHits).toHaveLength(10);
    expect(result._meta.truncated).toBe(true);
    expect(result._meta.truncatedFields).toEqual([{ path: "textHits", shown: 10, total: 15 }]);
  });

  it("returns all hits in full detail", () => {
    const result = findPatterns({ kind: "text", detail: "full", hits });
    expect(result.textHits).toHaveLength(15);
    expect("truncated" in result._meta).toBe(false);
    expect("truncatedFields" in result._meta).toBe(false);
  });

  it("supplies nextSteps when there are no hits", () => {
    const result = findPatterns({ kind: "text", detail: "full", hits: [] });
    expect(result._meta.nextSteps?.length).toBeGreaterThan(0);
  });
});

describe("findPatterns delegation", () => {
  const sessions: PatternSessionInput[] = [
    {
      source: "claude-code",
      sessionId: "a",
      subagentCount: 4,
      delegationModels: ["opus", "haiku"],
      totalCostUsd: 10,
      subagentReturnChars: 2000,
      wasteClasses: [],
    },
    {
      source: "claude-code",
      sessionId: "b",
      subagentCount: 5,
      delegationModels: ["haiku", "opus"],
      totalCostUsd: 20,
      subagentReturnChars: 4000,
      wasteClasses: [],
    },
    {
      source: "claude-code",
      sessionId: "c",
      subagentCount: 0,
      delegationModels: [],
      totalCostUsd: 1,
      wasteClasses: [],
    },
  ];

  it("groups by subagent-count bucket and sorted model mix, ranked by avg cost", () => {
    const result = findPatterns({ kind: "delegation", detail: "full", sessions });
    const patterns = result.delegationPatterns ?? [];
    // Sessions a & b share the "3-5 subagents · haiku+opus" shape (models sorted).
    const grouped = patterns.find((p) => p.subagentCountBucket === "3-5 subagents");
    expect(grouped?.sessionCount).toBe(2);
    expect(grouped?.models).toEqual(["haiku", "opus"]);
    expect(grouped?.avgCostUsd).toBe(15);
    expect(grouped?.avgSubagentReturnChars).toBe(3000);
    // Highest avg cost first.
    expect(patterns[0]?.subagentCountBucket).toBe("3-5 subagents");
  });

  it("reports null avg return chars when no session in a group had a known value", () => {
    const result = findPatterns({
      kind: "delegation",
      detail: "full",
      sessions: [
        {
          source: "claude-code",
          sessionId: "x",
          subagentCount: 1,
          delegationModels: ["haiku"],
          totalCostUsd: 2,
          wasteClasses: [],
        },
      ],
    });
    expect(result.delegationPatterns?.[0]?.avgSubagentReturnChars).toBeNull();
  });
});

describe("findPatterns waste", () => {
  const sessions: PatternSessionInput[] = [
    {
      source: "claude-code",
      sessionId: "a",
      subagentCount: 0,
      delegationModels: [],
      totalCostUsd: 1,
      wasteClasses: ["near-duplicate", "near-duplicate", "large-result"],
    },
    {
      source: "claude-code",
      sessionId: "b",
      subagentCount: 0,
      delegationModels: [],
      totalCostUsd: 1,
      wasteClasses: ["near-duplicate"],
    },
  ];

  it("rolls up waste classes by occurrence with distinct session counts", () => {
    const result = findPatterns({ kind: "waste", detail: "full", sessions });
    const patterns = result.wastePatterns ?? [];
    const nearDup = patterns.find((p) => p.class === "near-duplicate");
    expect(nearDup?.occurrences).toBe(3);
    expect(nearDup?.sessionCount).toBe(2);
    // Ranked by occurrences desc.
    expect(patterns[0]?.class).toBe("near-duplicate");
  });
});
