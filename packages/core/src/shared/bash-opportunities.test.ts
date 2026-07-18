import { describe, expect, it } from "vitest";
import {
  BASH_AS_READ_AVOIDABLE,
  type BashOpportunity,
  computeBashOpportunities,
  LARGE_RESULT_AVOIDABLE,
} from "./bash-opportunities.js";
import type { BashThreadGroup, BashWaste } from "./bash-stats.js";

/** `claude-fable-5`'s `input_cost_per_token` — see `./pricing/prices.json` (also used by `bash-stats.test.ts` and `pricing.test.ts`). */
const FABLE_INPUT_RATE = 0.00001;

/** Minimal, fully-populated `BashThreadGroup` row — `computeBashOpportunities` only reads `thread`/`model` off these, so every other field is a filler zero. */
function threadRow(thread: string, model?: string): BashThreadGroup {
  return {
    thread,
    ...(model !== undefined && { model }),
    calls: 0,
    errors: 0,
    inputChars: 0,
    resultChars: 0,
    estimatedTokens: 0,
    charsSharePct: 0,
  };
}

const EMPTY_WASTE: BashWaste = {
  nearDuplicates: [],
  largeResults: [],
  rerunAfterError: [],
  bashAsRead: [],
};

describe("computeBashOpportunities", () => {
  it("classifies near-duplicate and rerun-after-error as MEASURED, bash-as-read and large-result as HEURISTIC", () => {
    const byThread = [threadRow("main", "claude-fable-5")];
    const waste: BashWaste = {
      ...EMPTY_WASTE,
      nearDuplicates: [
        {
          pattern: "pnpm test",
          count: 3,
          examples: ["pnpm test"],
          occurrences: [
            { thread: "main", line: 1, resultChars: 40 },
            { thread: "main", line: 2, resultChars: 40 },
            { thread: "main", line: 3, resultChars: 40 },
          ],
        },
      ],
      rerunAfterError: [
        {
          pattern: "pnpm build",
          count: 1,
          occurrences: [{ thread: "main", errorLine: 1, rerunLine: 2, resultChars: 40 }],
        },
      ],
      bashAsRead: [{ command: "cat foo.log", resultChars: 24_000, line: 1, thread: "main" }],
      largeResults: [
        {
          command: "pnpm run build:verbose",
          resultChars: 30_000,
          line: 1,
          thread: "main",
          truncatedByHarness: false,
        },
      ],
    };
    const opportunities = computeBashOpportunities({ byThread, waste });
    const basisOf = (cls: BashOpportunity["class"]) =>
      opportunities.find((o) => o.class === cls)?.savingsBasis;
    expect(basisOf("near-duplicate")).toBe("measured");
    expect(basisOf("rerun-after-error")).toBe("measured");
    expect(basisOf("bash-as-read")).toBe("heuristic");
    expect(basisOf("large-result")).toBe("heuristic");

    // heuristicNote present iff basis === "heuristic".
    for (const o of opportunities) {
      if (o.savingsBasis === "heuristic") expect(o.heuristicNote).toBeDefined();
      else expect(o.heuristicNote).toBeUndefined();
    }
  });

  it("produces the exact fixText for one near-duplicate case", () => {
    const byThread = [threadRow("main", "claude-fable-5")];
    const waste: BashWaste = {
      ...EMPTY_WASTE,
      nearDuplicates: [
        {
          pattern: "pnpm test",
          count: 3,
          examples: ["pnpm test"],
          occurrences: [
            { thread: "main", line: 6, resultChars: 40 },
            { thread: "main", line: 8, resultChars: 40 },
            { thread: "main", line: 10, resultChars: 40 },
          ],
        },
      ],
    };
    const [opportunity] = computeBashOpportunities({ byThread, waste });
    expect(opportunity?.fixText).toBe(
      "Batch or cache `pnpm test` in main — it ran 3 times with the same shape; combine the calls into one, or reuse the first result instead of re-running it.",
    );
    expect(opportunity?.lever).toBe("spawn-prompt");
    expect(opportunity?.occurrenceCount).toBe(3);
    expect(opportunity?.totalChars).toBe(120);
    expect(opportunity?.threads).toEqual(["main"]);
    // First occurrence forgiven; the other 2 (40 chars each) are the measured waste.
    expect(opportunity?.estUsdSaved).toBe(2 * Math.ceil(40 / 4) * FABLE_INPUT_RATE);
  });

  it("produces the exact fixText for one rerun-after-error case", () => {
    const byThread = [threadRow("main", "claude-fable-5")];
    const waste: BashWaste = {
      ...EMPTY_WASTE,
      rerunAfterError: [
        {
          pattern: "pnpm test",
          count: 2,
          occurrences: [
            { thread: "main", errorLine: 5, rerunLine: 6, resultChars: 40 },
            { thread: "main", errorLine: 20, rerunLine: 21, resultChars: 80 },
          ],
        },
      ],
    };
    const [opportunity] = computeBashOpportunities({ byThread, waste });
    expect(opportunity?.fixText).toBe(
      "Read the failure output before re-running `pnpm test` — it failed then was immediately re-run 2 time(s) in main; investigating the error first can avoid the repeat call entirely.",
    );
    expect(opportunity?.lever).toBe("investigate");
    // Every occurrence is already a repeat call, so BOTH price as avoidable.
    expect(opportunity?.estUsdSaved).toBe(
      (Math.ceil(40 / 4) + Math.ceil(80 / 4)) * FABLE_INPUT_RATE,
    );
  });

  it("produces the exact fixText for one bash-as-read case", () => {
    const byThread = [threadRow("sub1", "claude-fable-5")];
    const waste: BashWaste = {
      ...EMPTY_WASTE,
      bashAsRead: [{ command: "cat foo.log", resultChars: 24_000, line: 3, thread: "sub1" }],
    };
    const [opportunity] = computeBashOpportunities({ byThread, waste });
    expect(opportunity?.title).toBe("24k-char cat inside sub1 (claude-fable-5)");
    expect(opportunity?.fixText).toBe(
      "Add a CLAUDE.md rule for sub1: use the Read tool (with offset/limit) instead of `cat` — `cat foo.log` alone returned 24,000 chars (1 call(s) of this shape, 24,000 chars total).",
    );
    expect(opportunity?.lever).toBe("claude-md-rule");
    expect(opportunity?.heuristicNote).toBe(
      "Assumes a targeted Read recovers the rest of the value — 70% of resultChars is booked as avoidable (BASH_AS_READ_AVOIDABLE=0.7).",
    );
    expect(opportunity?.estUsdSaved).toBe(
      Math.ceil(24_000 / 4) * FABLE_INPUT_RATE * BASH_AS_READ_AVOIDABLE,
    );
  });

  it("produces the exact fixText for one large-result case", () => {
    const byThread = [threadRow("main", "claude-fable-5")];
    const waste: BashWaste = {
      ...EMPTY_WASTE,
      largeResults: [
        {
          command: "pnpm run build:verbose",
          resultChars: 30_000,
          line: 10,
          thread: "main",
          truncatedByHarness: false,
        },
      ],
    };
    const [opportunity] = computeBashOpportunities({ byThread, waste });
    expect(opportunity?.title).toBe("30k-char pnpm result inside main (claude-fable-5)");
    expect(opportunity?.fixText).toBe(
      "Pipe `pnpm run build:verbose` through a quiet reporter or add a `--quiet`/`| tail` filter — it returned 30,000 chars (1 call(s) of this shape totaling 30,000 chars in main).",
    );
    expect(opportunity?.lever).toBe("command-flag");
    expect(opportunity?.heuristicNote).toBe(
      "Assumes a quiet/tail'd version keeps ~10% of the volume — 90% of resultChars is booked as avoidable (LARGE_RESULT_AVOIDABLE=0.9).",
    );
    expect(opportunity?.estUsdSaved).toBe(
      Math.ceil(30_000 / 4) * FABLE_INPUT_RATE * LARGE_RESULT_AVOIDABLE,
    );
  });

  it("sorts priced opportunities by estUsdSaved desc, then unpriced ones by basis tier (measured before heuristic) then totalChars desc", () => {
    const byThread = [threadRow("known", "claude-fable-5"), threadRow("unknown")];
    const waste: BashWaste = {
      nearDuplicates: [
        {
          pattern: "nd-known",
          count: 3,
          examples: ["nd-known"],
          occurrences: [
            { thread: "known", line: 1, resultChars: 40 },
            { thread: "known", line: 2, resultChars: 40 },
            { thread: "known", line: 3, resultChars: 40 },
          ],
        },
        {
          pattern: "nd-unknown",
          count: 3,
          examples: ["nd-unknown"],
          occurrences: [
            { thread: "unknown", line: 1, resultChars: 1000 },
            { thread: "unknown", line: 2, resultChars: 1000 },
            { thread: "unknown", line: 3, resultChars: 1000 },
          ],
        },
      ],
      rerunAfterError: [
        {
          pattern: "rr-unknown",
          count: 2,
          occurrences: [
            { thread: "unknown", errorLine: 1, rerunLine: 2, resultChars: 50 },
            { thread: "unknown", errorLine: 10, rerunLine: 11, resultChars: 50 },
          ],
        },
      ],
      bashAsRead: [{ command: "cat big.log", resultChars: 24_000, line: 1, thread: "known" }],
      largeResults: [
        {
          command: "pnpm run build",
          resultChars: 9_999,
          line: 1,
          thread: "unknown",
          truncatedByHarness: false,
        },
      ],
    };

    const opportunities = computeBashOpportunities({ byThread, waste });

    // Structured identity per opportunity, in final sorted order — avoids
    // any ambiguity from title/fixText string matching.
    expect(
      opportunities.map((o) => ({
        class: o.class,
        basis: o.savingsBasis,
        priced: o.estUsdSaved !== undefined,
      })),
    ).toEqual([
      { class: "bash-as-read", basis: "heuristic", priced: true }, // estUsdSaved 0.042
      { class: "near-duplicate", basis: "measured", priced: true }, // estUsdSaved 0.0002 (nd-known)
      { class: "near-duplicate", basis: "measured", priced: false }, // nd-unknown, totalChars 3000
      { class: "rerun-after-error", basis: "measured", priced: false }, // rr-unknown, totalChars 100
      { class: "large-result", basis: "heuristic", priced: false }, // totalChars 9999
    ]);

    const [bashAsRead, ndKnown, ndUnknown, rerun, largeResult] = opportunities;
    expect(bashAsRead?.estUsdSaved).toBeGreaterThan(ndKnown?.estUsdSaved ?? 0);
    expect(ndUnknown?.totalChars).toBe(3000);
    expect(rerun?.totalChars).toBe(100);
    expect(largeResult?.totalChars).toBe(9999);
  });

  it("caps evidence at 10 entries, largest resultChars first", () => {
    const byThread = [threadRow("main")];
    const occurrences = Array.from({ length: 12 }, (_, i) => ({
      thread: "main",
      line: i + 1,
      resultChars: (i + 1) * 10,
    }));
    const waste: BashWaste = {
      ...EMPTY_WASTE,
      nearDuplicates: [{ pattern: "x", count: 12, examples: ["x"], occurrences }],
    };
    const [opportunity] = computeBashOpportunities({ byThread, waste });
    expect(opportunity?.evidence).toHaveLength(10);
    expect(opportunity?.evidence[0]?.resultChars).toBe(120);
    expect(opportunity?.evidence[9]?.resultChars).toBe(30);
  });

  it("exports the heuristic coefficients as documented judgment constants", () => {
    expect(BASH_AS_READ_AVOIDABLE).toBe(0.7);
    expect(LARGE_RESULT_AVOIDABLE).toBe(0.9);
  });

  it("returns an empty list for empty waste", () => {
    expect(computeBashOpportunities({ byThread: [], waste: EMPTY_WASTE })).toEqual([]);
  });
});
