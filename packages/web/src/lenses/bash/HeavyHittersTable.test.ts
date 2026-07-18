import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { BashHeavyHitterJson } from "./bashLensFormat.js";
import { HeavyHittersTable } from "./HeavyHittersTable.js";

/**
 * Collects every `<button onClick>` handler in a React element tree, in
 * document order. This repo has no jsdom/testing-library setup (every other
 * `*.test.ts` file tests extracted pure logic, not rendered output — see
 * `bashLensFormat.test.ts`), so a real DOM click isn't available here.
 * `HeavyHittersTable` has no hooks, so calling it directly as a plain
 * function below is a legitimate function call (not a real React render),
 * and its return value is a genuine React element tree that JSX-authored
 * `onClick` handlers can be pulled out of and invoked directly — no
 * simulated DOM event needed to prove the wiring is correct.
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
    if (n.type === "button" && typeof props.onClick === "function") {
      clicks.push(props.onClick as () => void);
    }
    walk(props.children as ReactNode);
  };
  walk(node);
  return clicks;
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
    const element = HeavyHittersTable({ heavyHitters: HEAVY_HITTERS });
    expect(collectButtonClicks(element)).toHaveLength(0);
  });
});
