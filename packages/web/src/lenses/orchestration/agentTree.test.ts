import { describe, expect, it } from "vitest";
import type { SubagentNodeJson } from "../../api.js";
import {
  findAgentPath,
  flattenSubagents,
  mainDelegatedSplit,
  mainDelegatedTokenSplit,
  spawnedByLabel,
  subtreeCost,
} from "./agentTree.js";

function usage(costUsd: number) {
  return {
    byModel: [],
    total: {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
      costIsComplete: true,
    },
  };
}

function node(
  agentId: string,
  costUsd: number,
  children: SubagentNodeJson[] = [],
): SubagentNodeJson {
  return {
    agentId,
    usage: usage(costUsd),
    toolCallCount: 1,
    toolErrorCount: 0,
    children,
  };
}

describe("flattenSubagents", () => {
  it("box-draws a two-level tree with the right prefixes and depths", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    const research = node("research-agent", 0.94);
    const rows = flattenSubagents([research, testWriter]);

    expect(rows.map((r) => `${r.prefix}${r.id}`)).toEqual([
      "├ research-agent",
      "└ test-writer",
      "  └ lint-fixer",
    ]);
    expect(rows.find((r) => r.id === "lint-fixer")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "lint-fixer")?.nested).toBe(true);
    expect(rows.find((r) => r.id === "research-agent")?.nested).toBe(false);
  });

  it("keeps the connecting bar under a non-last root's nested children", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    const docScanner = node("doc-scanner", 0.11);
    // test-writer is NOT the last root here (doc-scanner follows), so its
    // nested child's prefix carries "│" instead of blank spacing.
    const rows = flattenSubagents([testWriter, docScanner]);
    expect(rows.map((r) => `${r.prefix}${r.id}`)).toEqual([
      "├ test-writer",
      "│ └ lint-fixer",
      "└ doc-scanner",
    ]);
  });
});

describe("subtreeCost", () => {
  it("sums a node's own cost with every descendant's, recursively", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    expect(subtreeCost(testWriter)).toBeCloseTo(1.95, 6);
    expect(subtreeCost(lintFixer)).toBeCloseTo(0.09, 6);
  });
});

describe("mainDelegatedSplit", () => {
  it("computes the main/delegated cost share by percent, complementary", () => {
    const session = {
      usage: { total: { costUsd: 17.29 } },
      totalUsage: { costUsd: 23.41 },
    } as never;
    const { mainPct, delegatedPct } = mainDelegatedSplit(session);
    expect(mainPct).toBe(74);
    expect(delegatedPct).toBe(26);
  });

  it("reports 0/0 rather than dividing by zero when there's no priced usage", () => {
    const session = {
      usage: { total: { costUsd: 0 } },
      totalUsage: { costUsd: 0 },
    } as never;
    expect(mainDelegatedSplit(session)).toEqual({ mainPct: 0, delegatedPct: 0 });
  });
});

describe("mainDelegatedTokenSplit", () => {
  it("computes the main/delegated TOKEN share by percent, complementary", () => {
    const session = {
      delegation: {
        main: { tokens: 2260, outputTokens: 0 },
        subagents: { tokens: 7740, outputTokens: 0 },
      },
    } as never;
    const { mainPct, delegatedPct } = mainDelegatedTokenSplit(session);
    expect(mainPct).toBe(23);
    expect(delegatedPct).toBe(77);
  });

  it("reports 0/0 rather than dividing by zero when there are no tokens at all", () => {
    const session = {
      delegation: {
        main: { tokens: 0, outputTokens: 0 },
        subagents: { tokens: 0, outputTokens: 0 },
      },
    } as never;
    expect(mainDelegatedTokenSplit(session)).toEqual({ mainPct: 0, delegatedPct: 0 });
  });

  it("can rank in the opposite direction from the cost split (the inversion the header surfaces)", () => {
    // Same shape as the dogfooding example: main did 55.9% of cost but only
    // 22.6% of tokens — cost and token shares disagree about who did "most"
    // of the work.
    const costSession = {
      usage: { total: { costUsd: 63.18 } },
      totalUsage: { costUsd: 113.02 },
    } as never;
    const tokenSession = {
      delegation: {
        main: { tokens: 2260, outputTokens: 0 },
        subagents: { tokens: 7740, outputTokens: 0 },
      },
    } as never;
    expect(mainDelegatedSplit(costSession).mainPct).toBe(56);
    expect(mainDelegatedTokenSplit(tokenSession).mainPct).toBe(23);
  });
});

describe("findAgentPath", () => {
  it("returns the root-first ancestor chain, inclusive of the target", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    const research = node("research-agent", 0.94);

    expect(findAgentPath([research, testWriter], "lint-fixer")?.map((n) => n.agentId)).toEqual([
      "test-writer",
      "lint-fixer",
    ]);
    expect(findAgentPath([research, testWriter], "research-agent")?.map((n) => n.agentId)).toEqual([
      "research-agent",
    ]);
  });

  it("returns undefined when the agentId isn't anywhere in the forest", () => {
    const research = node("research-agent", 0.94);
    expect(findAgentPath([research], "does-not-exist")).toBeUndefined();
  });
});

describe("spawnedByLabel", () => {
  it("resolves to the parent's display name, or 'main' at the root", () => {
    const lintFixer: SubagentNodeJson = { ...node("lint-fixer", 0.09), spawnedBy: "test-writer" };
    const testWriter: SubagentNodeJson = {
      ...node("test-writer", 1.86, [lintFixer]),
      description: "test-writer",
      spawnedBy: "main",
    };
    expect(spawnedByLabel(lintFixer, [testWriter])).toBe("test-writer");
    expect(spawnedByLabel(testWriter, [testWriter])).toBe("main");
  });
});
