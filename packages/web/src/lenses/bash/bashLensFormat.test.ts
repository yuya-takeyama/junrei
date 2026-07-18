import { describe, expect, it } from "vitest";
import type {
  BashAsReadCallJson,
  BashCommandGroupJson,
  BashHeavyHitterJson,
  BashLargeResultJson,
  BashNearDuplicateGroupJson,
  BashRerunAfterErrorJson,
} from "./bashLensFormat.js";
import {
  buildCommandRankingRows,
  buildFlatWasteRows,
  buildHeavyHitterRows,
  buildNearDuplicateRows,
  buildRerunAfterErrorRows,
  capList,
  commandLabel,
  formatEstimatedTokens,
  formatOccurrence,
  formatRerunOccurrence,
  hasBashActivity,
  sampleCommandsTitle,
  threadLabel,
} from "./bashLensFormat.js";

describe("commandLabel", () => {
  it("joins family + subcommand when present", () => {
    expect(commandLabel({ family: "git", subcommand: "diff" })).toBe("git diff");
  });

  it("falls back to family alone when there's no subcommand", () => {
    expect(commandLabel({ family: "node" })).toBe("node");
    expect(commandLabel({ family: "(unparsed)" })).toBe("(unparsed)");
  });
});

describe("sampleCommandsTitle", () => {
  it("joins samples with newlines", () => {
    expect(sampleCommandsTitle(["git diff --stat", "git diff HEAD~1"])).toBe(
      "git diff --stat\ngit diff HEAD~1",
    );
  });

  it("returns undefined for an empty sample list", () => {
    expect(sampleCommandsTitle([])).toBeUndefined();
  });
});

describe("formatEstimatedTokens", () => {
  it("prefixes the ≈ estimate marker and reuses formatTokens' abbreviation", () => {
    expect(formatEstimatedTokens(25_300)).toBe("≈ 25.3k");
    expect(formatEstimatedTokens(0)).toBe("≈ 0");
  });
});

describe("threadLabel", () => {
  it("labels the main thread plainly", () => {
    expect(threadLabel("main")).toEqual({ text: "main", isMain: true });
  });

  it("shortens a long agentId (tool_use id) and flags it as not-main", () => {
    expect(threadLabel("toolu_01AbCdEfGhIjKlMnOpQrStUv")).toEqual({
      text: "tool…StUv",
      isMain: false,
    });
  });

  it("leaves a short thread id unshortened", () => {
    expect(threadLabel("agent1")).toEqual({ text: "agent1", isMain: false });
  });
});

describe("capList", () => {
  it("caps to the limit and reports how many were hidden", () => {
    expect(capList([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], hiddenCount: 2 });
  });

  it("reports zero hidden when under the limit", () => {
    expect(capList([1, 2], 5)).toEqual({ shown: [1, 2], hiddenCount: 0 });
  });
});

describe("formatOccurrence", () => {
  it("formats thread + line", () => {
    expect(formatOccurrence({ thread: "main", line: 42 })).toBe("main L42");
  });
});

describe("formatRerunOccurrence", () => {
  it("formats thread + errorLine → rerunLine", () => {
    expect(formatRerunOccurrence({ thread: "main", errorLine: 20, rerunLine: 23 })).toBe(
      "main L20→L23",
    );
  });
});

describe("hasBashActivity", () => {
  it("is false for a zero-call session (Bash.tsx's empty-state gate)", () => {
    expect(
      hasBashActivity({ calls: 0, errors: 0, inputChars: 0, resultChars: 0, estimatedTokens: 0 }),
    ).toBe(false);
  });

  it("is true once there's at least one call", () => {
    expect(
      hasBashActivity({
        calls: 1,
        errors: 0,
        inputChars: 10,
        resultChars: 20,
        estimatedTokens: 8,
      }),
    ).toBe(true);
  });
});

describe("buildCommandRankingRows", () => {
  it("builds expected rows from a fixture byCommand, in the order given (already core-ranked)", () => {
    const byCommand: BashCommandGroupJson[] = [
      {
        family: "git",
        subcommand: "diff",
        calls: 12,
        errors: 0,
        totalInputChars: 200,
        totalResultChars: 45_200,
        avgResultChars: 3_800,
        estimatedTokens: 11_350,
        sharePct: 32.1,
        sampleCommands: ["git diff --stat", "git diff HEAD~1"],
      },
      {
        family: "npm",
        subcommand: "test",
        calls: 3,
        errors: 1,
        totalInputChars: 50,
        totalResultChars: 9_000,
        avgResultChars: 3_000,
        estimatedTokens: 2_263,
        sharePct: 6.4,
        sampleCommands: [],
      },
    ];

    expect(buildCommandRankingRows(byCommand)).toEqual([
      {
        key: "git-diff",
        label: "git diff",
        sampleTitle: "git diff --stat\ngit diff HEAD~1",
        calls: 12,
        errors: 0,
        hasErrors: false,
        totalChars: 45_200,
        totalCharsText: "45.2k",
        avgChars: 3_800,
        avgCharsText: "3.8k",
        estTokens: 11_350,
        estTokensText: "≈ 11.3k",
        share: 32.1,
        shareText: "32.1%",
      },
      {
        key: "npm-test",
        label: "npm test",
        sampleTitle: undefined,
        calls: 3,
        errors: 1,
        hasErrors: true,
        totalChars: 9_000,
        totalCharsText: "9.0k",
        avgChars: 3_000,
        avgCharsText: "3.0k",
        estTokens: 2_263,
        estTokensText: "≈ 2.3k",
        share: 6.4,
        shareText: "6.4%",
      },
    ]);
  });
});

describe("buildHeavyHitterRows", () => {
  it("assigns 1-based rank in the given (already core-ranked) order and carries the raw line through for link wiring", () => {
    const heavyHitters: BashHeavyHitterJson[] = [
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

    expect(buildHeavyHitterRows(heavyHitters)).toEqual([
      {
        key: "toolu_1",
        rank: 1,
        command: "find . -name *.ts",
        thread: { text: "main", isMain: true },
        agentId: undefined,
        resultChars: 12_000,
        resultCharsText: "12.0k",
        line: 204,
      },
      {
        key: "toolu_2",
        rank: 2,
        command: "rg TODO",
        thread: { text: "agent-a", isMain: false },
        agentId: "agent-a",
        resultChars: 8_000,
        resultCharsText: "8.0k",
        line: 55,
      },
    ]);
  });

  it("carries the RAW (untruncated) agentId separately from the shortened display thread label", () => {
    // A long tool_use-id-shaped agentId gets shortened for `thread.text`
    // (see `threadLabel`/`shortenThreadId`), but `agentId` must stay the
    // full id — it's what routes the record slide-over into the right
    // subagent transcript (`agentRecordPath` in `SessionShell.tsx`), and a
    // shortened id can't resolve there.
    const heavyHitters: BashHeavyHitterJson[] = [
      {
        command: "pnpm test",
        family: "pnpm",
        resultChars: 5_000,
        line: 12,
        toolUseId: "toolu_3",
        thread: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
      },
    ];

    const [row] = buildHeavyHitterRows(heavyHitters);
    expect(row?.thread).toEqual({ text: "tool…StUv", isMain: false });
    expect(row?.agentId).toBe("toolu_01AbCdEfGhIjKlMnOpQrStUv");
  });
});

describe("HeavyHittersTable wiring — onOpenRecord(line, agentId)", () => {
  // `HeavyHittersTable.tsx`'s click handler is a direct passthrough —
  // `onClick={() => onOpenRecord(row.line, row.agentId)}` — so the row
  // model's `line`/`agentId` fields ARE the exact args the callback
  // receives per row. This asserts that pairing directly, main row vs.
  // subagent row, without needing to render the component.
  it("pairs (line, undefined) for a main-thread row and (line, agentId) for a subagent row", () => {
    const heavyHitters: BashHeavyHitterJson[] = [
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

    const calls: Array<[line: number, agentId: string | undefined]> = [];
    const onOpenRecord = (line: number, agentId?: string) => calls.push([line, agentId]);

    for (const row of buildHeavyHitterRows(heavyHitters)) {
      onOpenRecord(row.line, row.agentId);
    }

    expect(calls).toEqual([
      [204, undefined],
      [55, "agent-a"],
    ]);
  });
});

describe("buildNearDuplicateRows", () => {
  it("formats pattern/count/examples and caps the occurrence thread+line list", () => {
    const groups: BashNearDuplicateGroupJson[] = [
      {
        pattern: "git commit -m <STR>",
        count: 4,
        examples: ["git commit -m 'fix'", "git commit -m 'wip'"],
        occurrences: [
          { thread: "main", line: 4 },
          { thread: "main", line: 9 },
          { thread: "agent-a", line: 12 },
          { thread: "main", line: 20 },
        ],
      },
    ];

    expect(buildNearDuplicateRows(groups, 3)).toEqual([
      {
        key: "git commit -m <STR>",
        pattern: "git commit -m <STR>",
        count: 4,
        examplesText: "git commit -m 'fix' · git commit -m 'wip'",
        occurrencesText: "main L4, main L9, agent-a L12, +1 more",
      },
    ]);
  });

  it("omits the examples line when there are none", () => {
    const groups: BashNearDuplicateGroupJson[] = [
      { pattern: "ls <PATH>", count: 3, examples: [], occurrences: [{ thread: "main", line: 1 }] },
    ];
    expect(buildNearDuplicateRows(groups, 5)[0]?.examplesText).toBeUndefined();
  });
});

describe("buildRerunAfterErrorRows", () => {
  it("formats pattern/count and caps the errorLine→rerunLine occurrence list, thread included", () => {
    const groups: BashRerunAfterErrorJson[] = [
      {
        pattern: "git push",
        count: 2,
        occurrences: [
          { thread: "main", errorLine: 20, rerunLine: 23 },
          { thread: "agent-a", errorLine: 40, rerunLine: 41 },
        ],
      },
    ];

    expect(buildRerunAfterErrorRows(groups, 5)).toEqual([
      {
        key: "git push",
        pattern: "git push",
        count: 2,
        examplesText: undefined,
        occurrencesText: "main L20→L23, agent-a L40→L41",
      },
    ]);
  });
});

describe("buildFlatWasteRows", () => {
  it("formats large-results and bash-as-read rows identically (shared shape)", () => {
    const largeResults: BashLargeResultJson[] = [
      {
        command: "cat huge.log",
        resultChars: 30_000,
        line: 88,
        thread: "main",
        truncatedByHarness: false,
      },
    ];
    const bashAsRead: BashAsReadCallJson[] = [
      { command: "head -n 50 notes.md", resultChars: 1_200, line: 12, thread: "agent-b" },
    ];

    expect(buildFlatWasteRows(largeResults)).toEqual([
      {
        key: "main-88",
        command: "cat huge.log",
        resultChars: 30_000,
        resultCharsText: "30.0k",
        thread: { text: "main", isMain: true },
        line: 88,
      },
    ]);
    expect(buildFlatWasteRows(bashAsRead)).toEqual([
      {
        key: "agent-b-12",
        command: "head -n 50 notes.md",
        resultChars: 1_200,
        resultCharsText: "1.2k",
        thread: { text: "agent-b", isMain: false },
        line: 12,
      },
    ]);
  });
});
