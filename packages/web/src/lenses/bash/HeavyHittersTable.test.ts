import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { BashHeavyHitterJson } from "./bashLensFormat.js";
import { DEFAULT_HEAVY_HITTER_SORT, HeavyHittersTable } from "./HeavyHittersTable.js";

/**
 * Collects every row-level `.lnbtn` (record drill-down) `<button onClick>`
 * handler in a React element tree, in document order — excludes the
 * header row's `.sortbtn` buttons (`SortableHeaderCell`), which this same
 * walk would otherwise also pick up now that the header is clickable too;
 * those are covered separately by the sort-specific tests below. This repo
 * has no jsdom/testing-library setup (every other `*.test.ts` file tests
 * extracted pure logic, not rendered output — see `bashLensFormat.test.ts`),
 * so a real DOM click isn't available here.
 */
function collectButtonClicks(node: ReactNode): Array<() => void> {
  const clicks: Array<() => void> = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (
      n.type === "button" &&
      typeof props.className === "string" &&
      props.className.includes("lnbtn") &&
      typeof props.onClick === "function"
    ) {
      clicks.push(props.onClick as () => void);
    }
    if (typeof n.type === "function") {
      walk((n.type as (p: unknown) => ReactNode)(props));
      return;
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return clicks;
}

function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) {
    if (typeof node.type === "function") {
      return flattenText((node.type as (p: unknown) => ReactNode)(node.props));
    }
    return flattenText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Every `.bhh` body row's Command-cell text, in rendered order. */
function rowCommandsInOrder(node: ReactNode): string[] {
  const commands: string[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (n.type === "div" && props.className === "bhh") {
      const children = Array.isArray(props.children) ? props.children : [props.children];
      // Cells: [rank, command, thread, resultChars, line] — command is index 1.
      commands.push(flattenText(children[1] as ReactNode));
      return;
    }
    if (typeof n.type === "function") {
      walk((n.type as (p: unknown) => ReactNode)(props));
      return;
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return commands;
}

/** Finds a header button's onClick by its rendered label prefix (before any ▲/▼ indicator). */
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

const HEAVY_HITTERS: BashHeavyHitterJson[] = [
  {
    command: "find . -name *.ts",
    family: "find",
    resultChars: 12_000,
    line: 204,
    toolUseId: "toolu_1",
    thread: "main",
  },
  {
    command: "rg TODO",
    family: "rg",
    resultChars: 8_000,
    line: 55,
    toolUseId: "toolu_2",
    thread: "agent-a",
  },
];

describe("HeavyHittersTable", () => {
  it("wires each row's button click to onOpenRecord(line, agentId) — agentId only for a non-main thread", () => {
    const calls: Array<[line: number, agentId: string | undefined]> = [];
    const element = HeavyHittersTable({
      heavyHitters: HEAVY_HITTERS,
      sortSpec: DEFAULT_HEAVY_HITTER_SORT,
      onSortChange: () => {},
      onOpenRecord: (line, agentId) => calls.push([line, agentId]),
    });

    const clicks = collectButtonClicks(element);
    expect(clicks).toHaveLength(2);
    for (const click of clicks) click();

    expect(calls).toEqual([
      [204, undefined],
      [55, "agent-a"],
    ]);
  });

  it("renders plain (non-clickable) spans, not buttons, when onOpenRecord is absent", () => {
    const element = HeavyHittersTable({
      heavyHitters: HEAVY_HITTERS,
      sortSpec: DEFAULT_HEAVY_HITTER_SORT,
      onSortChange: () => {},
    });
    expect(collectButtonClicks(element)).toHaveLength(0);
  });

  it("renders rows in resultChars-desc order by default (matches computeHeavyHitters' own order)", () => {
    const element = HeavyHittersTable({
      heavyHitters: HEAVY_HITTERS,
      sortSpec: DEFAULT_HEAVY_HITTER_SORT,
      onSortChange: () => {},
    });
    expect(rowCommandsInOrder(element)).toEqual(["find . -name *.ts", "rg TODO"]);
  });

  it("re-sorts rows when given a different sortSpec (command asc)", () => {
    const element = HeavyHittersTable({
      heavyHitters: HEAVY_HITTERS,
      sortSpec: { key: "command", dir: "asc" },
      onSortChange: () => {},
    });
    expect(rowCommandsInOrder(element)).toEqual(["find . -name *.ts", "rg TODO"]);

    const desc = HeavyHittersTable({
      heavyHitters: HEAVY_HITTERS,
      sortSpec: { key: "command", dir: "desc" },
      onSortChange: () => {},
    });
    expect(rowCommandsInOrder(desc)).toEqual(["rg TODO", "find . -name *.ts"]);
  });

  it("wires each header's click to onSortChange with the right next spec", () => {
    const calls: Array<{ key: string; dir: "asc" | "desc" }> = [];
    const element = HeavyHittersTable({
      heavyHitters: HEAVY_HITTERS,
      sortSpec: DEFAULT_HEAVY_HITTER_SORT, // { key: "resultChars", dir: "desc" }
      onSortChange: (spec) => calls.push(spec),
    });

    findHeaderOnClick(element, "Command")?.();
    findHeaderOnClick(element, "Result chars")?.();
    findHeaderOnClick(element, "#")?.();

    expect(calls).toEqual([
      { key: "command", dir: "asc" },
      { key: "resultChars", dir: "asc" },
      { key: "rank", dir: "desc" },
    ]);
  });
});
