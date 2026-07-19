import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { ToolUsageStatsJson } from "../../api.js";
import { ToolRankingTable } from "./ToolRankingTable.js";
import type { ToolGroupJson } from "./toolsLensFormat.js";

/**
 * Same "call the component directly, walk the returned element tree" approach
 * the Bash `*.test.ts` files use (no jsdom/testing-library) — every component
 * under test here is hook-free, so resolving one by calling `type(props)` is a
 * legitimate function call.
 */
function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) {
    if (typeof node.type === "function") {
      const component = node.type as (props: unknown) => ReactNode;
      return flattenText(component(node.props));
    }
    return flattenText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Every `.bcmd` (non-header) row's first-cell (tool-name) text, in rendered order. */
function rowNamesInOrder(node: ReactNode): string[] {
  const names: string[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (typeof n.type === "function") {
      walk((n.type as (p: unknown) => ReactNode)(props));
      return;
    }
    if (
      n.type === "div" &&
      typeof props.className === "string" &&
      props.className.split(" ").includes("bcmd") &&
      !props.className.split(" ").includes("hdr")
    ) {
      const firstChild = Array.isArray(props.children) ? props.children[0] : props.children;
      names.push(flattenText(firstChild as ReactNode));
      return;
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return names;
}

/** Collects the `to` targets of every `.drill` Link in the tree. */
function drillTargets(node: ReactNode): string[] {
  const targets: string[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (typeof props.className === "string" && props.className.split(" ").includes("drill")) {
      targets.push(String(props.to));
      return;
    }
    if (typeof n.type === "function" && n.type !== ToolRankingTable) {
      walk((n.type as (p: unknown) => ReactNode)(props));
      return;
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return targets;
}

/** Whether any `.tbadge` "mcp" span appears (the MCP row tag). */
function hasMcpBadge(node: ReactNode): boolean {
  let found = false;
  const walk = (n: ReactNode): void => {
    if (found || n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (
      n.type === "span" &&
      typeof props.className === "string" &&
      props.className.split(" ").includes("tbadge") &&
      flattenText(props.children as ReactNode) === "mcp"
    ) {
      found = true;
      return;
    }
    if (typeof n.type === "function") {
      walk((n.type as (p: unknown) => ReactNode)(props));
      return;
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return found;
}

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

// 10 tools → the table shows the top 8, rolls up the last 2, then Totals.
const BY_TOOL: ToolGroupJson[] = [
  tool("Bash", { estUsd: 1.0, sharePct: 50, orchestratorSharePct: 1 }),
  tool("Read", { estUsd: 0.28 }),
  tool("Grep", { estUsd: 0.12 }),
  tool("Glob", { estUsd: 0.06 }),
  tool("Edit", { estUsd: 0.05 }),
  tool("Agent", { estUsd: 0.05 }),
  tool("mcp__junrei__get_bash_stats", { estUsd: 0.02, errors: 1, errorCategories: { other: 1 } }),
  tool("Write", { estUsd: 0.02 }),
  tool("Workflow", { estUsd: 0.01 }),
  tool("TaskUpdate", { estUsd: 0.01 }),
];

const STATS: ToolUsageStatsJson = {
  totals: { calls: 100, errors: 1, resultChars: 100_000, estimatedTokens: 25_000, estUsd: 1.62 },
  byTool: BY_TOOL,
  byThread: [
    {
      thread: "main",
      model: "claude-opus-4-8",
      calls: 40,
      errors: 0,
      inputChars: 0,
      resultChars: 9_000,
      estimatedTokens: 2_250,
      estUsd: 0.2,
      charsSharePct: 9,
      usdSharePct: 12,
    },
  ],
  heavyHitters: [],
};

const BASH_HREF = "/session/claude-code/abc/tools/bash";

describe("ToolRankingTable", () => {
  it("renders tool rows in the engine's $-ranked order, then the roll-up, then Totals", () => {
    const element = ToolRankingTable({ stats: STATS, bashHref: BASH_HREF });
    expect(rowNamesInOrder(element)).toEqual([
      "Bash",
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Agent",
      // ToolNameCell renders the raw MCP wire name + the "mcp" badge, so the
      // flattened cell text carries the badge suffix.
      "mcp__junrei__get_bash_statsmcp",
      "Write",
      "+ 2 more tools (Workflow, TaskUpdate)",
      "Totals · 10 tools",
    ]);
  });

  it("links only the Bash row's drill-down to the Bash sub-tab", () => {
    const element = ToolRankingTable({ stats: STATS, bashHref: BASH_HREF });
    expect(drillTargets(element)).toEqual([BASH_HREF]);
  });

  it("tags MCP rows with the mcp badge", () => {
    const element = ToolRankingTable({ stats: STATS, bashHref: BASH_HREF });
    expect(hasMcpBadge(element)).toBe(true);
  });

  it("omits the roll-up row when the session has at most TOP_TOOLS tools", () => {
    const stats: ToolUsageStatsJson = { ...STATS, byTool: BY_TOOL.slice(0, 3) };
    const element = ToolRankingTable({ stats, bashHref: BASH_HREF });
    expect(rowNamesInOrder(element)).toEqual(["Bash", "Read", "Grep", "Totals · 3 tools"]);
  });

  it("handles an empty session (no tools) with just a Totals row", () => {
    const stats: ToolUsageStatsJson = {
      totals: { calls: 0, errors: 0, resultChars: 0, estimatedTokens: 0 },
      byTool: [],
      byThread: [],
      heavyHitters: [],
    };
    const element = ToolRankingTable({ stats, bashHref: BASH_HREF });
    expect(rowNamesInOrder(element)).toEqual(["Totals · 0 tools"]);
    expect(drillTargets(element)).toEqual([]);
  });
});
