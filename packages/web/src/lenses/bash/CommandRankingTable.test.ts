import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { BashCommandGroupJson } from "./bashLensFormat.js";
import {
  type CommandRankingSortKey,
  CommandRankingTable,
  DEFAULT_COMMAND_RANKING_SORT,
} from "./CommandRankingTable.js";

/**
 * Same "call the component directly, walk the returned element tree"
 * approach the sibling `*.test.ts` files in this folder use (no
 * jsdom/testing-library in this repo — see `HeavyHittersTable.test.ts`'s
 * doc comment). `SortableHeaderCell` is a hookless function component, so
 * resolving it by calling `type(props)` is a legitimate function call, same
 * as descending into a host element's `children`.
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

/** Every `.bcmd` body row's Command-cell text, in rendered order — the row label is that row's first child span. */
function rowLabelsInOrder(node: ReactNode): string[] {
  const labels: string[] = [];
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
    if (n.type === "div" && props.className === "bcmd") {
      const firstChild = Array.isArray(props.children) ? props.children[0] : props.children;
      labels.push(flattenText(firstChild as ReactNode));
      return; // rows don't nest further bcmd divs
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return labels;
}

/** Finds a header button's onClick by its rendered label prefix (the label text, before any ▲/▼ indicator). */
function findHeaderOnClick(node: ReactNode, labelPrefix: string): (() => void) | undefined {
  let found: (() => void) | undefined;
  const walk = (n: ReactNode): void => {
    if (found !== undefined || n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (
      n.type === "th" &&
      typeof props["aria-sort"] === "string" &&
      isValidElement(props.children)
    ) {
      const btnProps = props.children.props as { children: ReactNode; onClick: () => void };
      if (flattenText(btnProps.children).startsWith(labelPrefix)) {
        found = btnProps.onClick;
      }
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

const BY_COMMAND: BashCommandGroupJson[] = [
  {
    family: "git",
    subcommand: "diff",
    calls: 2,
    errors: 0,
    totalInputChars: 10,
    totalResultChars: 5_000,
    avgResultChars: 2_500,
    estimatedTokens: 1_250,
    sharePct: 10,
    sampleCommands: [],
  },
  {
    family: "npm",
    subcommand: "test",
    calls: 8,
    errors: 1,
    totalInputChars: 20,
    totalResultChars: 20_000,
    avgResultChars: 2_500,
    estimatedTokens: 5_000,
    sharePct: 40,
    sampleCommands: [],
  },
  {
    family: "cat",
    calls: 5,
    errors: 0,
    totalInputChars: 5,
    totalResultChars: 12_000,
    avgResultChars: 2_400,
    estimatedTokens: 3_000,
    sharePct: 24,
    sampleCommands: [],
  },
];

describe("CommandRankingTable", () => {
  it("renders rows in the given sortSpec's order (totalChars desc — the default)", () => {
    const element = CommandRankingTable({
      byCommand: BY_COMMAND,
      sortSpec: DEFAULT_COMMAND_RANKING_SORT,
      onSortChange: () => {},
    });
    expect(rowLabelsInOrder(element)).toEqual(["npm test", "cat", "git diff"]);
  });

  it("re-sorts rows when given a different sortSpec (calls asc)", () => {
    const element = CommandRankingTable({
      byCommand: BY_COMMAND,
      sortSpec: { key: "calls", dir: "asc" },
      onSortChange: () => {},
    });
    expect(rowLabelsInOrder(element)).toEqual(["git diff", "cat", "npm test"]);
  });

  it("sorts the label column as a string (asc)", () => {
    const element = CommandRankingTable({
      byCommand: BY_COMMAND,
      sortSpec: { key: "label", dir: "asc" },
      onSortChange: () => {},
    });
    expect(rowLabelsInOrder(element)).toEqual(["cat", "git diff", "npm test"]);
  });

  it("wires each header's click to onSortChange with the right next spec", () => {
    const calls: Array<{ key: CommandRankingSortKey; dir: "asc" | "desc" }> = [];
    const element = CommandRankingTable({
      byCommand: BY_COMMAND,
      sortSpec: DEFAULT_COMMAND_RANKING_SORT, // { key: "totalChars", dir: "desc" }
      onSortChange: (spec) => calls.push(spec),
    });

    // Clicking a different column (Calls, numeric) jumps to its own default (desc).
    findHeaderOnClick(element, "Calls")?.();
    // Clicking the already-active column (Total chars) toggles desc -> asc.
    findHeaderOnClick(element, "Total chars")?.();
    // Clicking the string column (Command) starts at its default (asc).
    findHeaderOnClick(element, "Command")?.();

    expect(calls).toEqual([
      { key: "calls", dir: "desc" },
      { key: "totalChars", dir: "asc" },
      { key: "label", dir: "asc" },
    ]);
  });
});
