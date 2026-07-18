import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { BashAsReadCallJson, BashLargeResultJson, BashWasteJson } from "./bashLensFormat.js";
import {
  DEFAULT_BASH_AS_READ_SORT,
  DEFAULT_LARGE_RESULTS_SORT,
  WasteDetectionPanel,
} from "./WasteDetectionPanel.js";

/**
 * Flattens every string/number leaf of a React element tree into one
 * space-joined string. Same "call the component directly, walk the
 * returned element tree" approach `HeavyHittersTable.test.ts` uses (no
 * jsdom/testing-library in this repo) — `WasteDetectionPanel` composes
 * further function components (`NearDuplicatesSubsection`, `WasteGroupList`,
 * `SortableHeaderCell`, ...), none of which use hooks, so a custom-component
 * element is resolved by calling its `type` directly with its `props`, same
 * as a host element's `children` is walked directly — this isn't a real
 * React render, just function calls all the way down.
 */
function renderedText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (isValidElement(node)) {
    if (typeof node.type === "function") {
      const component = node.type as (props: unknown) => ReactNode;
      return renderedText(component(node.props));
    }
    const props = node.props as Record<string, unknown>;
    return renderedText(props.children as ReactNode);
  }
  return "";
}

/** Every `.bflat` body row's Command-cell text, in rendered order. */
function bflatCommandsInOrder(node: ReactNode): string[] {
  const commands: string[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (n.type === "div" && props.className === "bflat") {
      const children = Array.isArray(props.children) ? props.children : [props.children];
      commands.push(renderedText(children[0] as ReactNode));
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
      if (renderedText(btnProps.children).startsWith(labelPrefix)) {
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

const EMPTY_WASTE: BashWasteJson = {
  nearDuplicates: [],
  largeResults: [],
  rerunAfterError: [],
  bashAsRead: [],
};

const LARGE_RESULTS: BashLargeResultJson[] = [
  {
    command: "cat huge.log",
    resultChars: 30_000,
    line: 88,
    thread: "main",
    truncatedByHarness: false,
  },
  { command: "find /", resultChars: 50_000, line: 3, thread: "main", truncatedByHarness: false },
  {
    command: "rg TODO",
    resultChars: 40_000,
    line: 12,
    thread: "agent-a",
    truncatedByHarness: false,
  },
];

const WASTE_WITH_LARGE_RESULTS: BashWasteJson = { ...EMPTY_WASTE, largeResults: LARGE_RESULTS };

const BASH_AS_READ: BashAsReadCallJson[] = [
  { command: "head -n 50 notes.md", resultChars: 1_200, line: 40, thread: "agent-b" },
  { command: "tail -n 5 log.txt", resultChars: 300, line: 5, thread: "main" },
  { command: "wc -l file.txt", resultChars: 20, line: 22, thread: "main" },
];

const WASTE_WITH_BASH_AS_READ: BashWasteJson = { ...EMPTY_WASTE, bashAsRead: BASH_AS_READ };

const defaultProps = {
  largeResultsSortSpec: DEFAULT_LARGE_RESULTS_SORT,
  onLargeResultsSortChange: () => {},
  bashAsReadSortSpec: DEFAULT_BASH_AS_READ_SORT,
  onBashAsReadSortChange: () => {},
};

describe("WasteDetectionPanel", () => {
  it("renders all four subsections' empty-state text when every waste list is empty", () => {
    const text = renderedText(WasteDetectionPanel({ waste: EMPTY_WASTE, ...defaultProps }));

    expect(text).toContain("no near-duplicate commands found");
    expect(text).toContain("no unusually large results");
    expect(text).toContain("no reruns after an error found");
    expect(text).toContain("no Bash calls standing in for Read");
  });

  it("renders the large-results grid in resultChars-desc order by default (matches computeLargeResults' own order)", () => {
    const element = WasteDetectionPanel({ waste: WASTE_WITH_LARGE_RESULTS, ...defaultProps });
    expect(bflatCommandsInOrder(element)).toEqual(["find /", "rg TODO", "cat huge.log"]);
  });

  it("re-sorts the large-results grid when given a different sortSpec (command asc)", () => {
    const element = WasteDetectionPanel({
      waste: WASTE_WITH_LARGE_RESULTS,
      ...defaultProps,
      largeResultsSortSpec: { key: "command", dir: "asc" },
    });
    expect(bflatCommandsInOrder(element)).toEqual(["cat huge.log", "find /", "rg TODO"]);
  });

  it("wires the large-results header's click to onLargeResultsSortChange with the right next spec", () => {
    const calls: Array<{ key: string; dir: "asc" | "desc" }> = [];
    const element = WasteDetectionPanel({
      waste: WASTE_WITH_LARGE_RESULTS,
      ...defaultProps,
      onLargeResultsSortChange: (spec) => calls.push(spec),
    });

    // DEFAULT_LARGE_RESULTS_SORT is { key: "resultChars", dir: "desc" }.
    findHeaderOnClick(element, "Command")?.();
    findHeaderOnClick(element, "Result chars")?.();

    expect(calls).toEqual([
      { key: "command", dir: "asc" },
      { key: "resultChars", dir: "asc" },
    ]);
  });

  it("renders the bash-as-read grid in resultChars-desc order by default (biggest waste first, matching DEFAULT_LARGE_RESULTS_SORT — computeBashAsRead's own collection order isn't itself a sortable column)", () => {
    const element = WasteDetectionPanel({ waste: WASTE_WITH_BASH_AS_READ, ...defaultProps });
    expect(bflatCommandsInOrder(element)).toEqual([
      "head -n 50 notes.md",
      "tail -n 5 log.txt",
      "wc -l file.txt",
    ]);
  });

  it("re-sorts the bash-as-read grid when given a different sortSpec (line asc)", () => {
    const element = WasteDetectionPanel({
      waste: WASTE_WITH_BASH_AS_READ,
      ...defaultProps,
      bashAsReadSortSpec: { key: "line", dir: "asc" },
    });
    expect(bflatCommandsInOrder(element)).toEqual([
      "tail -n 5 log.txt",
      "wc -l file.txt",
      "head -n 50 notes.md",
    ]);
  });

  it("does not leak large-results clicks into the bash-as-read grid's onSortChange, and vice versa", () => {
    const largeResultsCalls: unknown[] = [];
    const bashAsReadCalls: unknown[] = [];
    const element = WasteDetectionPanel({
      waste: WASTE_WITH_LARGE_RESULTS,
      largeResultsSortSpec: DEFAULT_LARGE_RESULTS_SORT,
      onLargeResultsSortChange: (spec) => largeResultsCalls.push(spec),
      bashAsReadSortSpec: DEFAULT_BASH_AS_READ_SORT,
      onBashAsReadSortChange: (spec) => bashAsReadCalls.push(spec),
    });

    findHeaderOnClick(element, "Command")?.();

    expect(largeResultsCalls).toHaveLength(1);
    expect(bashAsReadCalls).toHaveLength(0);
  });
});
