import { describe, expect, it } from "vitest";
import type { ToolUsageStatsJson } from "../../api.js";
import {
  bashSubTabCostHint,
  buildDecisionStrip,
  buildErrorMatrix,
  buildSourceSplit,
  type ToolGroupJson,
} from "./toolsLensFormat.js";

function tool(name: string, over: Partial<ToolGroupJson> = {}): ToolGroupJson {
  return {
    name,
    calls: 10,
    errors: 0,
    errorCategories: {},
    resultChars: 10_000,
    estimatedTokens: 2_500,
    estUsd: 0.1,
    sharePct: 10,
    orchestratorSharePct: 0,
    ...over,
  };
}

function statsOf(
  byTool: ToolGroupJson[],
  over: Partial<ToolUsageStatsJson> = {},
): ToolUsageStatsJson {
  const calls = byTool.reduce((s, t) => s + t.calls, 0);
  const errors = byTool.reduce((s, t) => s + t.errors, 0);
  const resultChars = byTool.reduce((s, t) => s + t.resultChars, 0);
  const estUsd = byTool.reduce((s, t) => s + (t.estUsd ?? 0), 0);
  return {
    totals: { calls, errors, resultChars, estimatedTokens: Math.ceil(resultChars / 4), estUsd },
    byTool,
    byThread: [],
    heavyHitters: [],
    ...over,
  };
}

describe("buildSourceSplit", () => {
  it("partitions built-in vs MCP and counts distinct MCP servers", () => {
    const stats = statsOf([
      tool("Bash", { estUsd: 1.0 }),
      tool("Read", { estUsd: 0.5 }),
      tool("mcp__junrei__get_bash_stats", { estUsd: 0.02 }),
      tool("mcp__junrei__list_sessions", { estUsd: 0.01 }),
      tool("mcp__github__search", { estUsd: 0.01 }),
    ]);
    const split = buildSourceSplit(stats);
    expect(split.builtIn?.toolCount).toBe(2);
    expect(split.mcp?.toolCount).toBe(3);
    // junrei + github = 2 distinct servers.
    expect(split.mcp?.legend).toContain("2 servers");
    expect(split.builtIn?.legend).toContain("Built-in · 2 tools");
  });

  it("returns no MCP segment when the session called no MCP tools", () => {
    const split = buildSourceSplit(statsOf([tool("Bash"), tool("Read")]));
    expect(split.mcp).toBeUndefined();
  });

  it("returns no built-in segment for an MCP-only session", () => {
    const split = buildSourceSplit(
      statsOf([tool("mcp__junrei__get_bash_stats"), tool("mcp__github__search")]),
    );
    expect(split.builtIn).toBeUndefined();
    expect(split.mcp?.toolCount).toBe(2);
  });
});

describe("buildErrorMatrix", () => {
  it("renders only the categories that appear, rows sorted by total errors desc", () => {
    const stats = statsOf([
      tool("Bash", { errors: 3, errorCategories: { "command-failed": 2, other: 1 } }),
      tool("Grep", { errors: 1, errorCategories: { "command-failed": 1 } }),
      tool("Edit", { errors: 2, errorCategories: { "string-not-found": 2 } }),
      tool("Read", { errors: 0 }),
    ]);
    const matrix = buildErrorMatrix(stats);
    expect(matrix).toBeDefined();
    // "file-not-found"/"permission-denied"/… never appeared → not columns.
    expect(matrix?.columns.map((c) => c.key)).toEqual([
      "command-failed",
      "string-not-found",
      "other",
    ]);
    // Sorted by total desc: Bash(3), Edit(2), Grep(1) — Read(0) excluded.
    expect(matrix?.rows.map((r) => r.name)).toEqual(["Bash", "Edit", "Grep"]);
    expect(matrix?.grandTotal).toBe(6);
    // Column totals aligned to columns: command-failed=3, string-not-found=2, other=1.
    expect(matrix?.columnTotals).toEqual([3, 2, 1]);
  });

  it("is undefined when the session recorded no tool errors", () => {
    expect(buildErrorMatrix(statsOf([tool("Bash"), tool("Read")]))).toBeUndefined();
  });
});

describe("buildDecisionStrip", () => {
  it("names the top-$ tool as the cost concentration and the max-error tool as the error concentration", () => {
    const stats = statsOf(
      [
        tool("Bash", {
          estUsd: 1.0,
          calls: 100,
          sharePct: 60,
          errors: 2,
          errorCategories: { other: 2 },
        }),
        tool("Read", { estUsd: 0.2, errors: 5, errorCategories: { "file-not-found": 5 } }),
      ],
      {
        byThread: [
          {
            thread: "main",
            model: "claude-opus-4-8",
            calls: 10,
            errors: 0,
            inputChars: 0,
            resultChars: 2_000,
            estimatedTokens: 500,
            estUsd: 0.3,
            charsSharePct: 10,
            usdSharePct: 25,
          },
          {
            thread: "sub-a",
            model: "claude-sonnet-4-5",
            calls: 90,
            errors: 0,
            inputChars: 0,
            resultChars: 18_000,
            estimatedTokens: 4_500,
            estUsd: 0.9,
            charsSharePct: 90,
            usdSharePct: 75,
          },
        ],
      },
    );
    const strip = buildDecisionStrip(stats);
    expect(strip.costConcentration.value).toBe("Bash");
    expect(strip.errorConcentration.value).toBe("5 / 7");
    // 1 non-main thread → subagent count reflected in the orchestrator card.
    expect(strip.orchestratorShare.subLines[0]).toContain("1 subagent");
  });

  it("reports no errors gracefully when the session had none", () => {
    const strip = buildDecisionStrip(statsOf([tool("Bash", { errors: 0 })]));
    expect(strip.errorConcentration.value).toBe("0 / 0");
    expect(strip.errorConcentration.subLines[0]).toBe("no tool errors recorded");
  });
});

describe("bashSubTabCostHint", () => {
  it("~-prefixes the priced Bash cost", () => {
    expect(bashSubTabCostHint({ calls: 12, estUsd: 1.27 })).toBe("~$1.27");
  });

  it("is undefined when there are no Bash calls or nothing priced", () => {
    expect(bashSubTabCostHint({ calls: 0, estUsd: 1.0 })).toBeUndefined();
    expect(bashSubTabCostHint({ calls: 5 })).toBeUndefined();
  });
});
