import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CopyButton } from "../recordDetail/CopyButton.js";
import type { BashOpportunityJson } from "./bashLensFormat.js";
import { FixQueue } from "./FixQueue.js";

/**
 * Same "call the component directly, walk the returned element tree"
 * approach every sibling `*.test.ts` file in this folder uses (no
 * jsdom/testing-library). Unlike those walkers, this one must NOT descend
 * into `CopyButton` — it's a genuinely stateful leaf (`useCopyFlash`'s
 * `useState`), and calling it as a plain function outside a real React
 * render throws "Invalid hook call". So every walk below stops at a
 * `CopyButton` element and only inspects its own props (`getText`) instead
 * of recursing into it — see `FixQueue.tsx`'s doc comment for why that's the
 * one intentionally-untested stateful piece here.
 */
function isCopyButton(node: ReactNode): node is React.ReactElement<{ getText: () => string }> {
  return isValidElement(node) && node.type === CopyButton;
}

function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isCopyButton(node)) return ""; // never call into it — see doc comment above.
  if (isValidElement(node)) {
    if (typeof node.type === "function") {
      return flattenText((node.type as (p: unknown) => ReactNode)(node.props));
    }
    return flattenText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Every `CopyButton` element's `getText` prop, in tree order — does NOT call into `CopyButton` itself. */
function collectCopyButtonGetters(node: ReactNode): Array<() => string> {
  const getters: Array<() => string> = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (isCopyButton(n)) {
      getters.push(n.props.getText);
      return; // stop — do not call into CopyButton's own function body.
    }
    if (!isValidElement(n)) return;
    if (typeof n.type === "function") {
      walk((n.type as (p: unknown) => ReactNode)(n.props));
      return;
    }
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return getters;
}

/** Every `.exp-toggle` (evidence-expand toggle) button's onClick, in tree order. */
function collectExpandToggleClicks(node: ReactNode): Array<() => void> {
  const clicks: Array<() => void> = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (isCopyButton(n)) return;
    if (!isValidElement(n)) return;
    const props = n.props as Record<string, unknown>;
    if (
      n.type === "button" &&
      typeof props.className === "string" &&
      props.className.includes("exp-toggle") &&
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

/** Every `.lnbtn` (evidence-row record drill-down) button's onClick, in tree order. */
function collectEvidenceLinkClicks(node: ReactNode): Array<() => void> {
  const clicks: Array<() => void> = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (isCopyButton(n)) return;
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

function opportunity(overrides: Partial<BashOpportunityJson> = {}): BashOpportunityJson {
  return {
    class: "near-duplicate",
    title: "5x repeated command",
    lever: "spawn-prompt",
    fixText: "batch these calls",
    savingsBasis: "measured",
    estUsdSaved: 0.31,
    occurrenceCount: 5,
    totalChars: 12_300,
    threads: ["main", "sub1"],
    evidence: [
      { thread: "main", line: 10, resultChars: 2_000 },
      { thread: "sub1", line: 20, resultChars: 1_000 },
    ],
    ...overrides,
  };
}

describe("FixQueue", () => {
  it("renders the positive empty state when there are no opportunities", () => {
    const element = FixQueue({
      opportunities: [],
      expandedKeys: new Set(),
      onToggleExpand: () => {},
    });
    expect(flattenText(element)).toBe("no recoverable waste detected");
  });

  it("wires each card's CopyButton getText to that card's own fixText", () => {
    const element = FixQueue({
      opportunities: [
        opportunity({ fixText: "fix A" }),
        opportunity({ class: "large-result", fixText: "fix B" }),
      ],
      expandedKeys: new Set(),
      onToggleExpand: () => {},
    });
    const getters = collectCopyButtonGetters(element);
    expect(getters.map((g) => g())).toEqual(["fix A", "fix B"]);
  });

  it("toggles evidence via onToggleExpand(card.key), keyed by class-index", () => {
    const calls: string[] = [];
    const element = FixQueue({
      opportunities: [opportunity(), opportunity({ class: "large-result" })],
      expandedKeys: new Set(),
      onToggleExpand: (key) => calls.push(key),
    });
    const toggles = collectExpandToggleClicks(element);
    expect(toggles).toHaveLength(2);
    toggles[0]?.();
    toggles[1]?.();
    expect(calls).toEqual(["near-duplicate-0", "large-result-1"]);
  });

  it("only renders the evidence list for cards whose key is in expandedKeys", () => {
    const collapsed = FixQueue({
      opportunities: [opportunity()],
      expandedKeys: new Set(),
      onToggleExpand: () => {},
      onOpenRecord: () => {},
    });
    expect(collectEvidenceLinkClicks(collapsed)).toHaveLength(0);

    const expanded = FixQueue({
      opportunities: [opportunity()],
      expandedKeys: new Set(["near-duplicate-0"]),
      onToggleExpand: () => {},
      onOpenRecord: () => {},
    });
    expect(collectEvidenceLinkClicks(expanded)).toHaveLength(2);
  });

  it("wires evidence row clicks to onOpenRecord(line, agentId) — agentId only for a non-main thread", () => {
    const calls: Array<[line: number, agentId: string | undefined]> = [];
    const element = FixQueue({
      opportunities: [
        opportunity({
          evidence: [
            { thread: "main", line: 10, resultChars: 2_000 },
            { thread: "sub1", line: 20, resultChars: 1_000 },
          ],
        }),
      ],
      expandedKeys: new Set(["near-duplicate-0"]),
      onToggleExpand: () => {},
      onOpenRecord: (line, agentId) => calls.push([line, agentId]),
    });
    const clicks = collectEvidenceLinkClicks(element);
    expect(clicks).toHaveLength(2);
    for (const click of clicks) click();
    expect(calls).toEqual([
      [10, undefined],
      [20, "sub1"],
    ]);
  });

  it("renders plain (non-clickable) evidence lines when onOpenRecord is absent", () => {
    const element = FixQueue({
      opportunities: [opportunity()],
      expandedKeys: new Set(["near-duplicate-0"]),
      onToggleExpand: () => {},
    });
    expect(collectEvidenceLinkClicks(element)).toHaveLength(0);
  });

  it("caps to FIX_QUEUE_LIMIT (10), reporting the rest as '+N more not shown'", () => {
    const opportunities = Array.from({ length: 13 }, (_, i) =>
      opportunity({ class: "large-result", fixText: `fix ${i}` }),
    );
    const element = FixQueue({
      opportunities,
      expandedKeys: new Set(),
      onToggleExpand: () => {},
    });
    expect(collectCopyButtonGetters(element)).toHaveLength(10);
    expect(flattenText(element)).toContain("+3 more not shown");
  });
});
