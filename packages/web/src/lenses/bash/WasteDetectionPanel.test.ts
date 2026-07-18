import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { BashWasteJson } from "./bashLensFormat.js";
import { WasteDetectionPanel } from "./WasteDetectionPanel.js";

/**
 * Flattens every string/number leaf of a React element tree into one
 * space-joined string. Same "call the component directly, walk the
 * returned element tree" approach `HeavyHittersTable.test.ts` uses (no
 * jsdom/testing-library in this repo) — `WasteDetectionPanel` composes
 * further function components (`NearDuplicatesSubsection`, `WasteGroupList`,
 * ...), none of which use hooks, so a custom-component element is resolved
 * by calling its `type` directly with its `props`, same as a host element's
 * `children` is walked directly — this isn't a real React render, just
 * function calls all the way down.
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

const EMPTY_WASTE: BashWasteJson = {
  nearDuplicates: [],
  largeResults: [],
  rerunAfterError: [],
  bashAsRead: [],
};

describe("WasteDetectionPanel", () => {
  it("renders all four subsections' empty-state text when every waste list is empty", () => {
    const text = renderedText(WasteDetectionPanel({ waste: EMPTY_WASTE }));

    expect(text).toContain("no near-duplicate commands found");
    expect(text).toContain("no unusually large results");
    expect(text).toContain("no reruns after an error found");
    expect(text).toContain("no Bash calls standing in for Read");
  });
});
