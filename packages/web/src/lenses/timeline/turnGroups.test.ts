import { describe, expect, it } from "vitest";
import type { CodexSessionJson, SessionJson, SubagentNodeJson, TimelineEntry } from "../../api.js";
import { visibleTurnColumns } from "./turnColumns.js";
import {
  buildClaudeTurnGroups,
  buildCodexTurnGroups,
  buildSubagentSubtreeCosts,
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
    steps: [],
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

function subagentLaunch(
  line: number,
  overrides: Partial<Extract<TimelineEntry, { kind: "subagent-launch" }>> = {},
): TimelineEntry {
  return {
    kind: "subagent-launch",
    line,
    toolUseId: `su${String(line)}`,
    promptTruncated: false,
    ...overrides,
  };
}

function usageTotal(costUsd: number, costIsComplete = true): SubagentNodeJson["usage"] {
  return {
    byModel: [],
    total: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
      costIsComplete,
    },
  };
}

function subagentNode(
  agentId: string,
  overrides: Partial<SubagentNodeJson> = {},
): SubagentNodeJson {
  return {
    agentId,
    usage: usageTotal(0),
    toolCallCount: 0,
    toolErrorCount: 0,
    children: [],
    ...overrides,
  };
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
        // stepCount is derived from steps.length, not apiMessageCount — see
        // the dedicated "sets stepCount from steps.length" test below for
        // that distinction; here the two agree so this test stays focused on
        // the plain field-flattening behavior.
        steps: [
          { line: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { line: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { line: 4, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
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

  it("maps usage.steps onto the group, dropping line/timestamp (not needed by the view) but passing costUsd through", () => {
    const turns = [
      turn(1, {
        apiMessageCount: 2,
        steps: [
          {
            line: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
            model: "claude-fable-5",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 1,
            cacheCreationTokens: 2,
            costUsd: 0.05,
          },
          {
            line: 4,
            model: "claude-sonnet-4-5",
            inputTokens: 20,
            outputTokens: 8,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            // No costUsd here — unpriced step, must stay absent on the group's step too.
          },
        ],
      }),
    ];
    const groups = buildClaudeTurnGroups([user(1)], turns, { costIsComplete: true });
    expect(groups[0]?.steps).toEqual([
      {
        model: "claude-fable-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheCreationTokens: 2,
        costUsd: 0.05,
      },
      {
        model: "claude-sonnet-4-5",
        inputTokens: 20,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
  });

  it("sets stepCount from steps.length (single source, not a separate apiMessageCount read)", () => {
    const turns = [
      turn(1, {
        apiMessageCount: 99, // deliberately mismatched — stepCount must ignore this
        steps: [
          {
            line: 2,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      }),
    ];
    const groups = buildClaudeTurnGroups([user(1)], turns, { costIsComplete: true });
    expect(groups[0]?.stepCount).toBe(1);
  });

  it("leaves a step's model undefined when the source step has none", () => {
    const turns = [
      turn(1, {
        steps: [
          { line: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      }),
    ];
    const groups = buildClaudeTurnGroups([user(1)], turns, { costIsComplete: true });
    expect(groups[0]?.steps?.[0]).not.toHaveProperty("model");
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

  it("sums costUsd from EVERY step, not just ones with a text-bearing assistant entry (regression: the old assistant-text-only sum silently dropped tool-only calls)", () => {
    const turns = [
      turn(1, {
        steps: [
          // A text-bearing call — has both an assistant-text entry AND a step.
          {
            line: 2,
            model: "claude-fable-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.3,
          },
          // A tool-only call — a step, but NO assistant-text entry (no text
          // block emitted). This is exactly the cost the old assistant-text
          // sum silently dropped.
          {
            line: 3,
            model: "claude-fable-5",
            inputTokens: 200,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.2,
          },
        ],
      }),
    ];
    const entries: TimelineEntry[] = [
      user(1),
      assistantText(2, { model: "claude-fable-5", costUsd: 0.3 }),
      toolCall(3),
    ];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.costUsd).toBe(0.5);
    expect(groups[0]?.costIncomplete).toBe(false);
  });

  it("flags costIncomplete when the turn mixes priced and unpriced steps", () => {
    const turns = [
      turn(1, {
        steps: [
          {
            line: 2,
            model: "claude-fable-5",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.1,
          },
          // Unpriced — no costUsd (model missing/unpriced upstream).
          {
            line: 3,
            model: "totally-unknown-model-xyz",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      }),
    ];
    const groups = buildClaudeTurnGroups([user(1)], turns, { costIsComplete: true });
    expect(groups[0]?.costUsd).toBe(0.1);
    expect(groups[0]?.costIncomplete).toBe(true);
  });

  it("leaves costUsd undefined when the turn has zero priced steps (no steps at all)", () => {
    const turns = [turn(1)];
    const entries: TimelineEntry[] = [user(1), toolCall(2)];
    const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true });
    expect(groups[0]?.costUsd).toBeUndefined();
    expect(groups[0]?.costIncomplete).toBe(false);
  });

  it("folds the session-level costIsComplete flag into every turn's costIncomplete, even when the turn's own steps are fully priced", () => {
    const turns = [
      turn(1, {
        steps: [
          {
            line: 2,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 1,
          },
        ],
      }),
    ];
    const groups = buildClaudeTurnGroups([user(1)], turns, { costIsComplete: false });
    expect(groups[0]?.costUsd).toBe(1);
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

  it("adds a step's model to the list even when its call has no assistant-text entry (tool-only call), after the assistant-text-seen models", () => {
    const turns = [
      turn(1, {
        steps: [
          {
            line: 2,
            model: "claude-sonnet-4-5",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          // Tool-only call — no matching assistant-text entry below, so this
          // model would never have surfaced under the old assistant-text-only
          // collection.
          {
            line: 3,
            model: "claude-3-5-haiku",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      }),
    ];
    const entries: TimelineEntry[] = [
      user(1),
      assistantText(2, { model: "claude-sonnet-4-5" }),
      toolCall(3),
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

  describe("delegatedCostUsd (subagent subtree join)", () => {
    it("joins a launch by agentId to the subtree-cost map, not the launch entry's own costUsd", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [
        user(1),
        // Own costUsd (0.1) deliberately understates the real subtree cost
        // (0.1 + 0.4 nested) — the join must use the latter.
        subagentLaunch(2, { agentId: "a1", costUsd: 0.1, costIsComplete: true }),
      ];
      const subagents = [
        subagentNode("a1", {
          usage: usageTotal(0.1),
          children: [subagentNode("a1-1", { usage: usageTotal(0.4) })],
        }),
      ];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents });
      expect(groups[0]?.delegatedCostUsd).toBeCloseTo(0.5);
      expect(groups[0]?.delegatedCostIncomplete).toBe(false);
    });

    it("falls back to the launch entry's own costUsd and flags incomplete when agentId is missing", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [user(1), subagentLaunch(2, { costUsd: 0.2 })];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents: [] });
      expect(groups[0]?.delegatedCostUsd).toBe(0.2);
      expect(groups[0]?.delegatedCostIncomplete).toBe(true);
    });

    it("falls back and flags incomplete when the agentId isn't in the subagent forest", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [
        user(1),
        subagentLaunch(2, { agentId: "ghost", costUsd: 0.3 }),
      ];
      const subagents = [subagentNode("a1", { usage: usageTotal(1) })];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents });
      expect(groups[0]?.delegatedCostUsd).toBe(0.3);
      expect(groups[0]?.delegatedCostIncomplete).toBe(true);
    });

    it("leaves delegatedCostUsd undefined for a turn with no subagent-launch entries", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [user(1), toolCall(2)];
      const subagents = [subagentNode("a1", { usage: usageTotal(1) })];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents });
      expect(groups[0]?.delegatedCostUsd).toBeUndefined();
      expect(groups[0]?.delegatedCostIncomplete).toBeUndefined();
    });

    it("sums multiple launches in the same turn together", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [
        user(1),
        subagentLaunch(2, { agentId: "a1" }),
        subagentLaunch(3, { agentId: "a2" }),
      ];
      const subagents = [
        subagentNode("a1", { usage: usageTotal(0.3) }),
        subagentNode("a2", { usage: usageTotal(0.7) }),
      ];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents });
      expect(groups[0]?.delegatedCostUsd).toBeCloseTo(1.0);
      expect(groups[0]?.delegatedCostIncomplete).toBe(false);
    });

    it("flags incomplete when a joined subtree itself has incomplete pricing, even with no fallback", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [user(1), subagentLaunch(2, { agentId: "a1" })];
      const subagents = [subagentNode("a1", { usage: usageTotal(0.5, false) })];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents });
      expect(groups[0]?.delegatedCostIncomplete).toBe(true);
    });

    it("flags incomplete from session-level costIsComplete even when the joined subtree is fully priced", () => {
      const turns = [turn(1)];
      const entries: TimelineEntry[] = [user(1), subagentLaunch(2, { agentId: "a1" })];
      const subagents = [subagentNode("a1", { usage: usageTotal(0.5, true) })];
      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: false, subagents });
      expect(groups[0]?.delegatedCostUsd).toBe(0.5);
      expect(groups[0]?.delegatedCostIncomplete).toBe(true);
    });

    it("reconciles: Σ(costUsd) + Σ(delegatedCostUsd) equals main + subagent totals for a two-turn fixture with one nested subagent", () => {
      // Turn 1: two priced main-loop API steps, no delegation.
      // Turn 2: one priced step, plus a launch of "a1" (own cost 0.2) which
      // itself launched a nested "a1-1" (cost 0.15) — the KNOWN PITFALL this
      // whole feature exists to correct: summing the launch entry's own
      // costUsd (0.2) alone would silently drop the nested 0.15.
      const turns = [
        turn(1, {
          steps: [
            {
              line: 2,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0.4,
            },
          ],
        }),
        turn(10, {
          steps: [
            {
              line: 11,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0.1,
            },
          ],
        }),
      ];
      const entries: TimelineEntry[] = [
        user(1),
        assistantText(2, { costUsd: 0.4 }),
        user(10),
        assistantText(11, { costUsd: 0.1 }),
        subagentLaunch(12, { agentId: "a1", costUsd: 0.2, costIsComplete: true }),
      ];
      const nested = subagentNode("a1-1", { usage: usageTotal(0.15) });
      const subagents = [subagentNode("a1", { usage: usageTotal(0.2), children: [nested] })];

      const groups = buildClaudeTurnGroups(entries, turns, { costIsComplete: true, subagents });

      const sumCost = groups.reduce((sum, g) => sum + (g.costUsd ?? 0), 0);
      const sumDelegated = groups.reduce((sum, g) => sum + (g.delegatedCostUsd ?? 0), 0);
      // Main total: 0.4 (turn 1) + 0.1 (turn 2) = 0.5. Subagent total: the
      // full a1 subtree, 0.2 + 0.15 = 0.35. Session grand total: 0.85.
      const mainTotal = 0.5;
      const subagentTotal = 0.35;
      expect(sumCost).toBeCloseTo(mainTotal);
      expect(sumDelegated).toBeCloseTo(subagentTotal);
      expect(sumCost + sumDelegated).toBeCloseTo(mainTotal + subagentTotal);
      expect(groups[1]?.delegatedCostIncomplete).toBe(false);
    });
  });
});

describe("buildSubagentSubtreeCosts", () => {
  it("sums a root's own cost with every nested descendant's, recursively", () => {
    const root = subagentNode("a1", {
      usage: usageTotal(1),
      children: [
        subagentNode("a1-1", {
          usage: usageTotal(0.5),
          children: [subagentNode("a1-1-1", { usage: usageTotal(0.25) })],
        }),
      ],
    });
    const map = buildSubagentSubtreeCosts([root]);
    expect(map.get("a1")).toEqual({ costUsd: 1.75, costIsComplete: true });
  });

  it("keys only top-level roots, never a nested descendant's own agentId", () => {
    const root = subagentNode("a1", { children: [subagentNode("a1-1")] });
    const map = buildSubagentSubtreeCosts([root]);
    expect(map.has("a1-1")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("ANDs costIsComplete across the whole subtree — one incomplete descendant makes the whole subtree incomplete", () => {
    const root = subagentNode("a1", {
      usage: usageTotal(1, true),
      children: [subagentNode("a1-1", { usage: usageTotal(0.5, false) })],
    });
    const map = buildSubagentSubtreeCosts([root]);
    expect(map.get("a1")?.costIsComplete).toBe(false);
  });

  it("returns an empty map for an empty forest", () => {
    expect(buildSubagentSubtreeCosts([]).size).toBe(0);
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
    // No step layer for Codex — StepsRow.tsx never mounts for these groups.
    expect(groups[0]?.steps).toBeUndefined();
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
