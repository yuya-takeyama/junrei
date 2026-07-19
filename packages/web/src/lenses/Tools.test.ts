import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { AnySessionJson, SessionRef } from "../api.js";
import { Bash } from "./Bash.js";
import { Tools } from "./Tools.js";
import { AllView } from "./tools/AllView.js";

/**
 * Dispatch-only test: walk the element tree `Tools` returns and record which
 * function-component elements appear at the top level WITHOUT invoking them
 * (AllView/Bash need full session data + hooks to render). Same
 * call-the-component-directly approach as the sibling table tests.
 */
function topLevelComponentTypes(node: ReactNode): Set<unknown> {
  const types = new Set<unknown>();
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    if (typeof n.type === "function") {
      // A component element — record it, but do NOT descend into it.
      types.add(n.type);
      return;
    }
    // Host element / Fragment — descend into its children only.
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return types;
}

const SESSION = {
  source: "claude-code",
  bashStats: {
    totals: { calls: 5, errors: 0, resultChars: 1000, estimatedTokens: 250, estUsd: 1.27 },
  },
  toolUsageStats: {
    totals: { calls: 20, errors: 0, resultChars: 5000, estimatedTokens: 1250, estUsd: 2.0 },
    byTool: [],
    byThread: [],
    heavyHitters: [],
  },
} as unknown as AnySessionJson;

const REF: SessionRef = { source: "claude-code", id: "abc" };

describe("Tools dispatch", () => {
  it("renders the AllView (not Bash) for the 'all' sub-tab", () => {
    const types = topLevelComponentTypes(Tools({ session: SESSION, sessionRef: REF, sub: "all" }));
    expect(types.has(AllView)).toBe(true);
    expect(types.has(Bash)).toBe(false);
  });

  it("renders the Bash sub-tab component (not AllView) for the 'bash' sub-tab", () => {
    const types = topLevelComponentTypes(Tools({ session: SESSION, sessionRef: REF, sub: "bash" }));
    expect(types.has(Bash)).toBe(true);
    expect(types.has(AllView)).toBe(false);
  });
});
