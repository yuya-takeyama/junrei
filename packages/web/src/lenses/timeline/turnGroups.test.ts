import { describe, expect, it } from "vitest";
import type { CodexSessionJson, SessionJson, TimelineEntry } from "../../api.js";
import { visibleTurnColumns } from "./turnColumns.js";
import {
  buildClaudeTurnGroups,
  buildCodexTurnGroups,
  isOutlierTurn,
  sumTurnCosts,
  turnsUpToBudget,
} from "./turnGroups.js";

type TurnUsage = SessionJson["turnUsage"][number];
type CodexTurn = CodexSessionJson["codex"]["turns"][number];

function turn(line: number, overrides: Partial<TurnUsage> = {}): TurnUsage {
  return {
    line,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    apiMessageCount: 0,
    ...overrides,
  };
}

function user(line: number, text = "hi", timestamp?: string): TimelineEntry {
  return {
    kind: "user",
    line,
    text,
    truncated: false,
    ...(timestamp !== undefined && { timestamp }),
  };
}

function assistantText(
  line: number,
  overrides: Partial<Extract<TimelineEntry, { kind: "assistant-text" }>> = {},
): TimelineEntry {
  return { kind: "assistant-text", line, text: "ok", truncated: false, ...overrides };
}

function toolCall(line: number, status: "ok" | "error" | "missing-result" = "ok"): TimelineEntry {
  return {
    kind: "tool-call",
    line,
    toolUseId: `t${String(line)}`,
    name: "Bash",
    inputSummary: "x",
    status,
  };
}

function compaction(line: number): TimelineEntry {
  return { kind: "compaction", line };
}

function codexTurn(overrides: Partial<CodexTurn> = {}): CodexTurn {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides,
  };
}

describe("buildClaudeTurnGroups", () => {
  it("returns an empty array when there is no turn usage", () => {
    expect(buildClaudeTurnGroups([user(1)], [], { costIsComplete: true })).toEqual([]);
  });

  it("assigns 1-based display indices in turn order", () => {
    const turns = [turn(1), turn(5), turn(9)];
    const groups = buildClaudeTurnGroups([user(1), user(5), user(9)], turns, {
      costIsComplete: true,
    });
    expect(groups.map((g) => g.index)).toEqual([1, 2, 3]);
  });

  it("sets anchorLine to the turn's own line, for use as the expand-override key", () => {
    const turns = [turn(1), turn(5)];
    const groups = buildClaudeTurnGroups([user(1), user(5)], turns, { costIsComplete: true });
    expect(groups.map((g) => g.anchorLine)).toEqual([1, 5]);
  });

  it("flattens the turn's usage onto the group — no nested usage object", () => {
    const turns = [
      turn(1, {
        inputTokens: 12,
        cacheReadTokens: 34,
        cacheCreationTokens: 56,
        outputTokens: 78,
        apiMessageCount: 3,
      }),
    ];
    const groups = buildClaudeTurnGroups([user(1)], turns, { costIsComplete: true });
    expect(groups[0]).toMatchObject({
      inputTokens: 12,
      cacheReadTokens: 34,
      cacheCreationTokens: 56,
      outputTokens: 78,
      stepCount: 3,
    });
    expect(groups[0]).not.toHaveProperty("usage");
    expect(groups[0]?.reasoningTokens).toBeUndefined();
  });

  it("attributes an entry exactly at the next turn's line to that next turn", () => {
    const turns = [turn(1), turn(10)];
    const entries: TimelineEntry[] = [user(1), assistantText(5), user(10)];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.entries.map((e) => e.line)).toEqual([1, 5]);
    expect(groups[1]?.entries.map((e) => e.line)).toEqual([10]);
  });

  it("folds entries before the first turn's line into the first turn", () => {
    const turns = [turn(5), turn(10)];
    const entries: TimelineEntry[] = [assistantText(1), user(5)];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.entries.map((e) => e.line)).toEqual([1, 5]);
  });

  it("includes a compaction entry in the turn preceding it", () => {
    const turns = [turn(1), turn(20)];
    const entries: TimelineEntry[] = [user(1), assistantText(5), compaction(10), user(20)];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.entries.map((e) => e.kind)).toEqual(["user", "assistant-text", "compaction"]);
    expect(groups[1]?.entries.map((e) => e.kind)).toEqual(["user"]);
  });

  it("sums assistant-text costUsd and flags costIncomplete when one is missing", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [
      user(1),
      assistantText(2, { costUsd: 0.5 }),
      assistantText(3),
    ];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.costUsd).toBe(0.5);
    expect(groups[0]?.costIncomplete).toBe(true);
  });

  it("leaves costUsd undefined when no assistant-text entry carries a cost", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [user(1), toolCall(2)];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.costUsd).toBeUndefined();
    expect(groups[0]?.costIncomplete).toBe(false);
  });

  it("folds the session-level costIsComplete flag into every turn's costIncomplete", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [user(1), assistantText(2, { costUsd: 1 })];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: false });
    expect(groups[0]?.costIncomplete).toBe(true);
  });

  it("derives durationMs from startedAt to the last entry's timestamp", () => {
    const turns = [turn(1, { timestamp: "2026-01-01T00:00:00.000Z" })];
    const entries: TimelineEntry[] = [
      user(1, "hi", "2026-01-01T00:00:00.000Z"),
      assistantText(2, { timestamp: "2026-01-01T00:01:00.000Z" }),
    ];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.durationMs).toBe(60_000);
  });

  it("leaves durationMs (and startedAt) undefined when neither the turn nor its user entry has a timestamp", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [
      user(1, "hi"),
      assistantText(2, { timestamp: "2026-01-01T00:01:00.000Z" }),
    ];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.startedAt).toBeUndefined();
    expect(groups[0]?.durationMs).toBeUndefined();
  });

  it("leaves durationMs undefined when the last entry in the turn has no timestamp", () => {
    const turns = [turn(1, { timestamp: "2026-01-01T00:00:00.000Z" })];
    const entries: TimelineEntry[] = [user(1, "hi", "2026-01-01T00:00:00.000Z"), toolCall(2)];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.durationMs).toBeUndefined();
  });

  it("dedupes models across assistant-text entries in first-seen order", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [
      user(1),
      assistantText(2, { model: "claude-sonnet-4-5" }),
      assistantText(3, { model: "claude-3-5-haiku" }),
      assistantText(4, { model: "claude-sonnet-4-5" }),
    ];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.models).toEqual(["claude-sonnet-4-5", "claude-3-5-haiku"]);
  });

  it("counts tool-call entries with status error as toolErrorCount", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [
      user(1),
      toolCall(2, "ok"),
      toolCall(3, "error"),
      toolCall(4, "error"),
    ];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.toolErrorCount).toBe(2);
  });
});

describe("buildCodexTurnGroups", () => {
  it("returns an empty array when there are no turns", () => {
    expect(buildCodexTurnGroups([user(1)], [])).toEqual([]);
  });

  it("sorts turns by startedAt and assigns 1-based display indices in that order, regardless of input order", () => {
    const turns = [
      codexTurn({ startedAt: "2026-01-01T00:10:00.000Z" }),
      codexTurn({ startedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const groups = buildCodexTurnGroups([], turns);
    expect(groups.map((g) => g.startedAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:10:00.000Z",
    ]);
    expect(groups.map((g) => g.index)).toEqual([1, 2]);
  });

  it("attributes an entry to the last turn whose startedAt is <= the entry's timestamp", () => {
    const turns = [
      codexTurn({ startedAt: "2026-01-01T00:00:00.000Z" }),
      codexTurn({ startedAt: "2026-01-01T00:10:00.000Z" }),
    ];
    const entries: TimelineEntry[] = [
      user(1, "hi", "2026-01-01T00:00:00.000Z"),
      assistantText(2, { timestamp: "2026-01-01T00:05:00.000Z" }),
      user(3, "next", "2026-01-01T00:10:00.000Z"),
    ];
    const groups = buildCodexTurnGroups(entries, turns);
    expect(groups[0]?.entries.map((e) => e.line)).toEqual([1, 2]);
    expect(groups[1]?.entries.map((e) => e.line)).toEqual([3]);
  });

  it("folds an entry with no timestamp into the current bucket rather than advancing", () => {
    const turns = [
      codexTurn({ startedAt: "2026-01-01T00:00:00.000Z" }),
      codexTurn({ startedAt: "2026-01-01T00:10:00.000Z" }),
    ];
    const entries: TimelineEntry[] = [
      user(1, "hi", "2026-01-01T00:00:00.000Z"),
      assistantText(2), // no timestamp — must not push the pointer into turn 2
      user(3, "next", "2026-01-01T00:10:00.000Z"),
    ];
    const groups = buildCodexTurnGroups(entries, turns);
    expect(groups[0]?.entries.map((e) => e.line)).toEqual([1, 2]);
    expect(groups[1]?.entries.map((e) => e.line)).toEqual([3]);
  });

  it("folds entries before the first turn's startedAt into the first turn's bucket", () => {
    const turns = [codexTurn({ startedAt: "2026-01-01T00:05:00.000Z" })];
    const entries: TimelineEntry[] = [
      assistantText(1, { timestamp: "2026-01-01T00:00:00.000Z" }),
      user(2, "hi", "2026-01-01T00:05:00.000Z"),
    ];
    const groups = buildCodexTurnGroups(entries, turns);
    expect(groups[0]?.entries.map((e) => e.line)).toEqual([1, 2]);
  });

  it("leaves userEntry undefined for an agent-initiated turn with no user-kind entry", () => {
    const turns = [codexTurn({ startedAt: "2026-01-01T00:00:00.000Z" })];
    const entries: TimelineEntry[] = [
      assistantText(1, { timestamp: "2026-01-01T00:00:00.000Z" }),
      toolCall(2),
    ];
    const groups = buildCodexTurnGroups(entries, turns);
    expect(groups[0]?.userEntry).toBeUndefined();
  });

  it("falls back to a unique negative anchorLine per turn when a turn's bucket is empty", () => {
    const turns = [
      codexTurn({ startedAt: "2026-01-01T00:00:00.000Z" }),
      codexTurn({ startedAt: "2026-01-01T00:10:00.000Z" }),
      codexTurn({ startedAt: "2026-01-01T00:20:00.000Z" }),
    ];
    // Only one entry, timestamped at turn 1 — turns 2 and 3 never receive
    // anything (the pointer never advances into them).
    const entries: TimelineEntry[] = [user(1, "hi", "2026-01-01T00:00:00.000Z")];
    const groups = buildCodexTurnGroups(entries, turns);
    expect(groups[1]?.entries).toEqual([]);
    expect(groups[2]?.entries).toEqual([]);
    const anchors = groups.map((g) => g.anchorLine);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(groups[1]?.anchorLine).toBeLessThan(0);
    expect(groups[2]?.anchorLine).toBeLessThan(0);
  });

  it("dedupes models with turn.model first, then assistant-entry models in first-seen order", () => {
    const turns = [codexTurn({ startedAt: "2026-01-01T00:00:00.000Z", model: "gpt-5.6-sol" })];
    const entries: TimelineEntry[] = [
      user(1, "hi", "2026-01-01T00:00:00.000Z"),
      assistantText(2, { timestamp: "2026-01-01T00:00:01.000Z", model: "gpt-5.6-sol" }),
      assistantText(3, { timestamp: "2026-01-01T00:00:02.000Z", model: "gpt-5.6-terra" }),
    ];
    const groups = buildCodexTurnGroups(entries, turns);
    expect(groups[0]?.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("maps native duration/token fields and leaves the Claude-only fields (cacheCreationTokens/stepCount/costUsd) undefined", () => {
    const turns = [
      codexTurn({
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 42_000,
        inputTokens: 100,
        cacheReadTokens: 200,
        outputTokens: 300,
        reasoningOutputTokens: 400,
      }),
    ];
    const groups = buildCodexTurnGroups([user(1, "hi", "2026-01-01T00:00:00.000Z")], turns);
    expect(groups[0]).toMatchObject({
      durationMs: 42_000,
      inputTokens: 100,
      cacheReadTokens: 200,
      outputTokens: 300,
      reasoningTokens: 400,
      costIncomplete: false,
    });
    expect(groups[0]?.cacheCreationTokens).toBeUndefined();
    expect(groups[0]?.stepCount).toBeUndefined();
    expect(groups[0]?.costUsd).toBeUndefined();
  });

  it("produces exactly the 2c column set (Started/Dur/Input/C·Read/Output/Reasoning) — reasoning visible, steps/c·write/cost hidden", () => {
    const turns = [
      codexTurn({ startedAt: "2026-01-01T00:00:00.000Z", reasoningOutputTokens: 100 }),
    ];
    const groups = buildCodexTurnGroups([user(1, "hi", "2026-01-01T00:00:00.000Z")], turns);
    expect(visibleTurnColumns(groups).map((c) => c.key)).toEqual([
      "started",
      "dur",
      "input",
      "cread",
      "output",
      "reasoning",
    ]);
  });
});

describe("isOutlierTurn", () => {
  it("is not an outlier at exactly 25% share — the share must exceed, not equal", () => {
    expect(isOutlierTurn(1, 4)).toBe(false);
  });

  it("is not an outlier below the $0.10 absolute floor, even with a large share", () => {
    expect(isOutlierTurn(0.09, 0.1)).toBe(false);
  });

  it("is an outlier once both the share and the absolute floor are met", () => {
    expect(isOutlierTurn(2, 4)).toBe(true);
  });

  it("is never an outlier without cost data", () => {
    expect(isOutlierTurn(undefined, 4)).toBe(false);
  });

  it("is never an outlier when the session's per-turn total is zero", () => {
    expect(isOutlierTurn(0.5, 0)).toBe(false);
  });
});

describe("sumTurnCosts", () => {
  it("sums defined costUsd values, treating turns with no cost data as 0", () => {
    expect(sumTurnCosts([{ costUsd: 1 }, {}, { costUsd: 2.5 }])).toBe(3.5);
  });
});

describe("turnsUpToBudget", () => {
  it("includes whole turns until the cumulative entry count reaches the budget", () => {
    const groups = [
      { entries: new Array(3) },
      { entries: new Array(3) },
      { entries: new Array(3) },
    ];
    expect(turnsUpToBudget(groups, 5)).toBe(2);
  });

  it("returns every turn when the budget covers them all", () => {
    const groups = [{ entries: new Array(2) }, { entries: new Array(2) }];
    expect(turnsUpToBudget(groups, 10)).toBe(2);
  });

  it("always includes at least one whole turn, even if it alone exceeds the budget", () => {
    const groups = [{ entries: new Array(50) }, { entries: new Array(1) }];
    expect(turnsUpToBudget(groups, 5)).toBe(1);
  });
});
