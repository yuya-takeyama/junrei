import { describe, expect, it } from "vitest";
import type { ModelUsageSummary, SubagentNodeJson } from "../../api.js";
import {
  activeModels,
  costShare,
  findAgentPath,
  flattenSubagents,
  isSessionLive,
  mainDelegatedSplit,
  mainDelegatedTokenSplit,
  nodeStatus,
  SESSION_LIVE_THRESHOLD_MS,
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
    expect(rows.map((r) => [r.id, r.ancestorIsLast, r.isLast])).toEqual([
      ["test-writer", [], false],
      ["lint-fixer", [false], true],
      ["doc-scanner", [], true],
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

describe("costShare", () => {
  it("returns the part/total fraction", () => {
    expect(costShare(25, 100)).toBeCloseTo(0.25, 6);
    expect(costShare(100, 100)).toBeCloseTo(1, 6);
  });

  it("returns undefined rather than dividing by zero (or a negative) total", () => {
    expect(costShare(5, 0)).toBeUndefined();
    expect(costShare(5, -1)).toBeUndefined();
  });
});

describe("isSessionLive", () => {
  const NOW = Date.parse("2026-07-13T12:00:00.000Z");

  it("is live just inside the threshold", () => {
    const recent = new Date(NOW - (SESSION_LIVE_THRESHOLD_MS - 1000)).toISOString();
    expect(isSessionLive(recent, NOW)).toBe(true);
  });

  it("is not live once the threshold has fully elapsed", () => {
    const stale = new Date(NOW - SESSION_LIVE_THRESHOLD_MS - 1000).toISOString();
    expect(isSessionLive(stale, NOW)).toBe(false);
  });

  it("is not live for an undefined lastActivityAt", () => {
    expect(isSessionLive(undefined, NOW)).toBe(false);
  });

  it("is not live for an unparseable timestamp", () => {
    expect(isSessionLive("not-a-date", NOW)).toBe(false);
  });
});

describe("nodeStatus", () => {
  it("maps completed/failed straight through regardless of session liveness", () => {
    expect(nodeStatus({ status: "completed" }, true)).toBe("done");
    expect(nodeStatus({ status: "completed" }, false)).toBe("done");
    expect(nodeStatus({ status: "failed" }, true)).toBe("fail");
    expect(nodeStatus({ status: "failed" }, false)).toBe("fail");
  });

  it("reads unresolved as run only while the session still looks live", () => {
    expect(nodeStatus({ status: "unresolved" }, true)).toBe("run");
    expect(nodeStatus({ status: "unresolved" }, false)).toBeUndefined();
  });

  it("returns undefined for a Codex node (status never set) regardless of liveness", () => {
    expect(nodeStatus({ status: undefined }, true)).toBeUndefined();
    expect(nodeStatus({ status: undefined }, false)).toBeUndefined();
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

function modelUsage(model: string, overrides: Partial<ModelUsageSummary> = {}): ModelUsageSummary {
  return {
    model,
    messageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe("activeModels", () => {
  it("returns every model with real activity, cost descending — the SendMessage override case", () => {
    // Mirrors the dogfooding example (session acca8a8c-36c7-42d2-be69-46fa1473ab2b,
    // subagent a4a92f13): a subagent silently switched from its assigned
    // sonnet to the expensive session model (fable) mid-run, so usage.byModel
    // carries both — a single-model badge used to hide the fable side
    // entirely.
    const sonnet = modelUsage("claude-sonnet-4-5", {
      messageCount: 149,
      outputTokens: 12000,
      costUsd: 6.72,
    });
    const fable = modelUsage("claude-fable-5", {
      messageCount: 57,
      outputTokens: 9000,
      costUsd: 18.21,
    });
    expect(activeModels([sonnet, fable]).map((m) => m.model)).toEqual([
      "claude-fable-5",
      "claude-sonnet-4-5",
    ]);
  });

  it("returns the single entry unchanged for a single-model node", () => {
    const sonnet = modelUsage("claude-sonnet-4-5", { outputTokens: 500, costUsd: 0.42 });
    expect(activeModels([sonnet])).toEqual([sonnet]);
  });

  it("excludes a zero-usage entry even when messageCount > 0 — a logged '<synthetic>' stub must never count as an active model", () => {
    // Shape mirrors Claude Code's real "<synthetic>" harness stub (see
    // @junrei/core's metrics.test.ts): the message happened (messageCount: 1)
    // but moved no tokens and billed nothing, so `messageCount` alone can't
    // be the activity signal — only token volume / cost qualifies.
    const sonnet = modelUsage("claude-sonnet-4-5", { outputTokens: 500, costUsd: 0.42 });
    const synthetic = modelUsage("<synthetic>", { messageCount: 1, costUsd: 0 });
    expect(activeModels([sonnet, synthetic]).map((m) => m.model)).toEqual(["claude-sonnet-4-5"]);
  });

  it("returns [] when every entry is zero-usage (no active model at all)", () => {
    const synthetic = modelUsage("<synthetic>", { messageCount: 1, costUsd: 0 });
    expect(activeModels([synthetic])).toEqual([]);
  });

  it("returns [] for an empty byModel — the Codex-safety no-data case", () => {
    expect(activeModels([])).toEqual([]);
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
