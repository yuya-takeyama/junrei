import { describe, expect, it } from "vitest";
import type { SessionBashPercentileJson } from "../../api.js";
import type {
  BashCommandGroupJson,
  BashHeavyHitterJson,
  BashOpportunityJson,
  BashThreadGroupJson,
} from "./bashLensFormat.js";
import {
  buildCommandRankingRows,
  buildHeaderStrip,
  buildHeavyHitterRows,
  buildOpportunityCards,
  buildThreadMoneyRows,
  capList,
  commandLabel,
  formatEstimatedTokens,
  formatEstUsd,
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

describe("formatEstUsd", () => {
  it("prefixes the ~ estimate marker and reuses formatUsd", () => {
    expect(formatEstUsd(0.42)).toBe("~$0.42");
    expect(formatEstUsd(150)).toBe("~$150");
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

describe("buildHeaderStrip", () => {
  const totalsWithUsd = {
    calls: 5,
    errors: 0,
    inputChars: 100,
    resultChars: 40_000,
    estimatedTokens: 10_000,
    estUsd: 0.42,
  };
  const totalsWithoutUsd = {
    calls: 5,
    errors: 0,
    inputChars: 100,
    resultChars: 40_000,
    estimatedTokens: 10_000,
  };

  it("renders a priced $ headline when totals.estUsd is known", () => {
    const model = buildHeaderStrip(totalsWithUsd, undefined, "claude-code");
    expect(model.costText).toBe("~$0.42 (est)");
    expect(model.isUsd).toBe(true);
  });

  it("falls back to an est-tokens headline when totals.estUsd is unknown", () => {
    const model = buildHeaderStrip(totalsWithoutUsd, undefined, "claude-code");
    expect(model.costText).toBe("~10.0k est tokens");
    expect(model.isUsd).toBe(false);
  });

  it("hides the percentile chip entirely when bashPercentile is undefined", () => {
    const model = buildHeaderStrip(totalsWithUsd, undefined, "claude-code");
    expect(model.percentileText).toBeUndefined();
    expect(model.medianRatioText).toBeUndefined();
    expect(model.tooltip).toBeUndefined();
  });

  it("renders the percentile + median-ratio chip when bashPercentile is present", () => {
    const pct: SessionBashPercentileJson = { pct: 88.3, medianRatio: 3.2, sampleCount: 12 };
    const model = buildHeaderStrip(totalsWithUsd, pct, "claude-code");
    expect(model.percentileText).toBe("p88 for this repo");
    expect(model.medianRatioText).toBe("3.2x median");
  });

  it("omits medianRatioText when the server omitted medianRatio (median was 0)", () => {
    const pct: SessionBashPercentileJson = { pct: 100, sampleCount: 6 };
    const model = buildHeaderStrip(totalsWithUsd, pct, "claude-code");
    expect(model.percentileText).toBe("p100 for this repo");
    expect(model.medianRatioText).toBeUndefined();
  });

  it("adds a main-thread-only caveat to the tooltip for a Codex session, not for Claude", () => {
    const pct: SessionBashPercentileJson = { pct: 50, sampleCount: 5 };
    const codex = buildHeaderStrip(totalsWithUsd, pct, "codex");
    const claude = buildHeaderStrip(totalsWithUsd, pct, "claude-code");
    expect(codex.tooltip).toContain("main-thread-only");
    expect(claude.tooltip).not.toContain("main-thread-only");
  });
});

function thread(overrides: Partial<BashThreadGroupJson> = {}): BashThreadGroupJson {
  return {
    thread: "main",
    calls: 1,
    errors: 0,
    inputChars: 10,
    resultChars: 100,
    estimatedTokens: 25,
    charsSharePct: 0,
    ...overrides,
  };
}

describe("buildThreadMoneyRows", () => {
  it("puts the main thread first, highlighted as the orchestrator", () => {
    const rows = buildThreadMoneyRows([
      thread({ thread: "main", model: "claude-sonnet-4-5", resultChars: 100, estUsd: 0.09 }),
      thread({ thread: "sub1", model: "claude-haiku-4-5", resultChars: 900, estUsd: 0.01 }),
    ]);
    expect(rows[0]?.key).toBe("main");
    expect(rows[0]?.isOrchestrator).toBe(true);
    expect(rows[0]?.label).toBe("main");
  });

  it("groups subagent threads by model, not by raw thread id", () => {
    const rows = buildThreadMoneyRows([
      thread({ thread: "main", resultChars: 10 }),
      thread({ thread: "sub1", model: "claude-haiku-4-5", resultChars: 300, estUsd: 0.01 }),
      thread({ thread: "sub2", model: "claude-haiku-4-5", resultChars: 200, estUsd: 0.005 }),
    ]);
    const haikuRow = rows.find((r) => r.model === "claude-haiku-4-5");
    expect(haikuRow?.threadCount).toBe(2);
    expect(haikuRow?.resultChars).toBe(500);
    expect(haikuRow?.estUsd).toBeCloseTo(0.015);
  });

  it("caps subagent model groups to the top 3, folding the rest into one '+N more' row", () => {
    const rows = buildThreadMoneyRows([
      thread({ thread: "main", resultChars: 10 }),
      thread({ thread: "s1", model: "m1", resultChars: 500 }),
      thread({ thread: "s2", model: "m2", resultChars: 400 }),
      thread({ thread: "s3", model: "m3", resultChars: 300 }),
      thread({ thread: "s4", model: "m4", resultChars: 200 }),
      thread({ thread: "s5", model: "m5", resultChars: 100 }),
    ]);
    // main + top 3 model groups + 1 "more" row = 5 rows total.
    expect(rows).toHaveLength(5);
    const more = rows.at(-1);
    expect(more?.label).toBe("+2 more");
    expect(more?.isAggregate).toBe(true);
    expect(more?.resultChars).toBe(300); // m4 (200) + m5 (100)
  });

  it("computes chars/usd share percentages against the sum of every byThread row", () => {
    const rows = buildThreadMoneyRows([
      thread({ thread: "main", model: "sonnet", resultChars: 20, estUsd: 0.8 }),
      thread({ thread: "sub1", model: "haiku", resultChars: 80, estUsd: 0.2 }),
    ]);
    const main = rows.find((r) => r.isOrchestrator);
    expect(main?.charsSharePct).toBe(20);
    expect(main?.usdSharePct).toBe(80);
  });

  it("leaves usdSharePct undefined when the session total $ is unknown", () => {
    const rows = buildThreadMoneyRows([
      thread({ thread: "main", resultChars: 50 }),
      thread({ thread: "sub1", model: "haiku", resultChars: 50 }),
    ]);
    for (const row of rows) expect(row.usdSharePct).toBeUndefined();
  });

  it("returns just the main row when there are no subagent threads", () => {
    const rows = buildThreadMoneyRows([thread({ thread: "main", resultChars: 100 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isOrchestrator).toBe(true);
  });

  it("returns no rows at all when byThread is empty", () => {
    expect(buildThreadMoneyRows([])).toEqual([]);
  });
});

describe("buildCommandRankingRows", () => {
  const totals = {
    calls: 15,
    errors: 1,
    inputChars: 250,
    resultChars: 54_200,
    estimatedTokens: 13_613,
    estUsd: 0.5,
  };

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
        estUsd: 0.4,
        orchestratorSharePct: 75,
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
        // No estUsd: an unpriced model — must render "—", never "$0".
      },
    ];

    const rows = buildCommandRankingRows(byCommand, totals);
    expect(rows[0]).toEqual({
      key: "git-diff",
      label: "git diff",
      sampleTitle: "git diff --stat\ngit diff HEAD~1",
      calls: 12,
      errors: 0,
      hasErrors: false,
      estUsd: 0.4,
      estUsdText: "~$0.40",
      usdSharePct: 80,
      usdShareText: "80.0%",
      orchSharePct: 75,
      orchShareText: "75.0%",
      estTokens: 11_350,
      estTokensText: "≈ 11.3k",
      totalChars: 45_200,
      totalCharsText: "45.2k",
      avgChars: 3_800,
      avgCharsText: "3.8k",
      share: 32.1,
      shareText: "32.1%",
    });
    expect(rows[1]).toEqual({
      key: "npm-test",
      label: "npm test",
      sampleTitle: undefined,
      calls: 3,
      errors: 1,
      hasErrors: true,
      estUsd: undefined,
      estUsdText: "—",
      usdSharePct: undefined,
      usdShareText: "—",
      orchSharePct: 0,
      orchShareText: "0.0%",
      estTokens: 2_263,
      estTokensText: "≈ 2.3k",
      totalChars: 9_000,
      totalCharsText: "9.0k",
      avgChars: 3_000,
      avgCharsText: "3.0k",
      share: 6.4,
      shareText: "6.4%",
    });
  });

  it("leaves usdSharePct undefined when the session total $ is unknown, even for a priced command", () => {
    const byCommand: BashCommandGroupJson[] = [
      {
        family: "cat",
        calls: 1,
        errors: 0,
        totalInputChars: 5,
        totalResultChars: 100,
        avgResultChars: 100,
        estimatedTokens: 25,
        sharePct: 100,
        sampleCommands: [],
        estUsd: 0.01,
      },
    ];
    const noUsdTotals = { ...totals, estUsd: undefined };
    const [row] = buildCommandRankingRows(byCommand, noUsdTotals);
    expect(row?.estUsd).toBe(0.01);
    expect(row?.usdSharePct).toBeUndefined();
  });
});

describe("buildHeavyHitterRows", () => {
  it("assigns 1-based rank in the given (already core-ranked) order and carries estUsd through", () => {
    const heavyHitters: BashHeavyHitterJson[] = [
      {
        command: "find . -name *.ts",
        family: "find",
        resultChars: 12_000,
        line: 204,
        toolUseId: "toolu_1",
        thread: "main",
        estUsd: 0.03,
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
        estUsd: 0.03,
        estUsdText: "~$0.03",
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
        estUsd: undefined,
        estUsdText: "—",
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

describe("buildOpportunityCards", () => {
  function opportunity(overrides: Partial<BashOpportunityJson> = {}): BashOpportunityJson {
    return {
      class: "near-duplicate",
      title: '5× "git diff <PATH>" repeated across main and sub1',
      lever: "spawn-prompt",
      fixText: "Batch or cache `git diff <PATH>` — it ran 5 times with the same shape.",
      savingsBasis: "measured",
      occurrenceCount: 5,
      totalChars: 12_300,
      threads: ["main", "sub1"],
      evidence: [
        { thread: "main", line: 10, resultChars: 2_000, estUsd: 0.01 },
        { thread: "sub1", line: 20, resultChars: 1_000 },
      ],
      ...overrides,
    };
  }

  it("assigns 1-based rank in the given (already core-ranked) order", () => {
    const cards = buildOpportunityCards([opportunity(), opportunity({ class: "large-result" })]);
    expect(cards.map((c) => c.rank)).toEqual([1, 2]);
    expect(cards.map((c) => c.class)).toEqual(["near-duplicate", "large-result"]);
  });

  it("renders a plain $ figure for a measured, priced opportunity", () => {
    const [card] = buildOpportunityCards([
      opportunity({ savingsBasis: "measured", estUsdSaved: 0.31 }),
    ]);
    expect(card?.savingsText).toBe("~$0.31");
    expect(card?.savingsIsCandidate).toBe(false);
    expect(card?.savingsIsHeuristic).toBe(false);
  });

  it("renders a $ figure + heuristic marker for a heuristic, priced opportunity", () => {
    const [card] = buildOpportunityCards([
      opportunity({
        savingsBasis: "heuristic",
        estUsdSaved: 0.09,
        heuristicNote: "Assumes 70% is avoidable.",
      }),
    ]);
    expect(card?.savingsText).toBe("~$0.09");
    expect(card?.savingsIsHeuristic).toBe(true);
    expect(card?.heuristicNote).toBe("Assumes 70% is avoidable.");
  });

  it("renders the candidate chip when estUsdSaved is unresolved (all-or-nothing rule), regardless of basis", () => {
    const [measured] = buildOpportunityCards([
      opportunity({ savingsBasis: "measured", estUsdSaved: undefined }),
    ]);
    expect(measured?.savingsText).toBe("candidate");
    expect(measured?.savingsIsCandidate).toBe(true);

    const [heuristic] = buildOpportunityCards([
      opportunity({ savingsBasis: "heuristic", estUsdSaved: undefined }),
    ]);
    expect(heuristic?.savingsText).toBe("candidate");
  });

  it("renders the candidate chip for savingsBasis 'none' even if estUsdSaved were somehow set", () => {
    const [card] = buildOpportunityCards([opportunity({ savingsBasis: "none", estUsdSaved: 5 })]);
    expect(card?.savingsText).toBe("candidate");
    expect(card?.savingsIsCandidate).toBe(true);
  });

  it("passes title/fixText through verbatim — never generates its own advice text", () => {
    const [card] = buildOpportunityCards([
      opportunity({ title: "custom title", fixText: "custom fix text" }),
    ]);
    expect(card?.title).toBe("custom title");
    expect(card?.fixText).toBe("custom fix text");
  });

  it("formats occurrenceCount/totalChars and maps threads to thread badges", () => {
    const [card] = buildOpportunityCards([
      opportunity({ occurrenceCount: 5, totalChars: 12_300, threads: ["main", "agent-a"] }),
    ]);
    expect(card?.occurrenceCount).toBe(5);
    expect(card?.totalCharsText).toBe("12.3k");
    expect(card?.threads).toEqual([
      { text: "main", isMain: true },
      { text: "agent-a", isMain: false },
    ]);
  });

  it("builds evidence rows with agentId undefined for main, set for a subagent, and estUsdText only when priced", () => {
    const [card] = buildOpportunityCards([
      opportunity({
        evidence: [
          { thread: "main", line: 10, resultChars: 2_000, estUsd: 0.01 },
          { thread: "agent-a", line: 20, resultChars: 1_000 },
        ],
      }),
    ]);
    expect(card?.evidence).toEqual([
      {
        key: "main-10",
        thread: { text: "main", isMain: true },
        agentId: undefined,
        line: 10,
        resultChars: 2_000,
        resultCharsText: "2.0k",
        estUsdText: "~$0.01",
      },
      {
        key: "agent-a-20",
        thread: { text: "agent-a", isMain: false },
        agentId: "agent-a",
        line: 20,
        resultChars: 1_000,
        resultCharsText: "1.0k",
        estUsdText: undefined,
      },
    ]);
  });
});
