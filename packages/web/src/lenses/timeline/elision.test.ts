import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../api.js";
import { ELISION_THRESHOLD, elideEntries, hiddenKindCounts, REVEAL_STEP } from "./elision.js";

/** Generic tool-call entries, one per line — kind doesn't matter for the threshold/stepping tests. */
function tools(count: number, startLine = 1): TimelineEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const line = startLine + i;
    return {
      kind: "tool-call",
      line,
      toolUseId: `t${String(line)}`,
      name: "Read",
      inputSummary: "file.ts",
      status: "ok",
    } satisfies TimelineEntry;
  });
}

function assistant(line: number): TimelineEntry {
  return { kind: "assistant-text", line, text: "hi", truncated: false };
}
function thinking(line: number): TimelineEntry {
  return { kind: "thinking", line, text: "hmm", truncated: false, charCount: 3 };
}
function toolErr(line: number): TimelineEntry {
  return {
    kind: "tool-call",
    line,
    toolUseId: `e${String(line)}`,
    name: "Bash",
    inputSummary: "npm test",
    status: "error",
  };
}
function subagent(line: number): TimelineEntry {
  return { kind: "subagent-launch", line, toolUseId: `s${String(line)}`, promptTruncated: false };
}
function compaction(line: number): TimelineEntry {
  return { kind: "compaction", line };
}
function user(line: number): TimelineEntry {
  return { kind: "user", line, text: "hi", truncated: false };
}

describe("elideEntries", () => {
  it("does not elide at exactly the threshold", () => {
    const entries = tools(ELISION_THRESHOLD);
    const result = elideEntries(entries, 0);
    expect(result.hidden).toEqual([]);
    expect(result.head).toEqual(entries);
    expect(result.tail).toEqual([]);
  });

  it("elides one entry past the threshold, with exactly 2 head and 2 tail anchors", () => {
    const entries = tools(ELISION_THRESHOLD + 1);
    const result = elideEntries(entries, 0);
    expect(result.head).toHaveLength(2);
    expect(result.tail).toHaveLength(2);
    expect(result.hidden).toHaveLength(ELISION_THRESHOLD + 1 - 4);
    expect(result.head).toEqual(entries.slice(0, 2));
    expect(result.tail).toEqual(entries.slice(-2));
  });

  it("keeps head/hidden/tail concatenating back to the full input", () => {
    const entries = tools(40);
    const result = elideEntries(entries, 10);
    expect([...result.head, ...result.hidden, ...result.tail]).toEqual(entries);
  });

  it("reveals the next REVEAL_STEP entries off the top of the hidden middle", () => {
    const entries = tools(60); // middle = 56 entries
    const first = elideEntries(entries, 0);
    expect(first.hidden).toHaveLength(56);

    const second = elideEntries(entries, REVEAL_STEP);
    expect(second.head).toHaveLength(2 + REVEAL_STEP);
    expect(second.hidden).toHaveLength(56 - REVEAL_STEP);
    expect(second.tail).toHaveLength(2);
  });

  it("clamps the final partial reveal step instead of overshooting into the tail", () => {
    const entries = tools(30); // middle = 26 entries
    // Two REVEAL_STEP clicks (50) overshoot the 26-entry middle.
    const result = elideEntries(entries, REVEAL_STEP * 2);
    expect(result.hidden).toEqual([]);
    expect(result.head).toEqual(entries.slice(0, 28));
    expect(result.tail).toEqual(entries.slice(-2));
  });

  it("show-all (Infinity) reveals the entire middle in one step", () => {
    const entries = tools(100);
    const result = elideEntries(entries, Number.POSITIVE_INFINITY);
    expect(result.hidden).toEqual([]);
    expect([...result.head, ...result.tail]).toEqual(entries);
  });
});

describe("hiddenKindCounts", () => {
  it("tallies in descending count order", () => {
    const hidden = [
      ...Array(5)
        .fill(null)
        .map((_, i) => thinking(100 + i)),
      ...Array(12)
        .fill(null)
        .map((_, i) => assistant(200 + i)),
      ...Array(71)
        .fill(null)
        .map((_, i) => tools(1, 300 + i)[0] as TimelineEntry),
    ];
    const { counts, overflow } = hiddenKindCounts(hidden);
    expect(counts).toEqual([
      { kind: "tool", count: 71 },
      { kind: "assistant", count: 12 },
      { kind: "thinking", count: 5 },
    ]);
    expect(overflow).toBe(0);
  });

  it("caps at KIND_COUNT_CAP (3) and reports the rest as overflow", () => {
    const hidden = [
      ...Array(10)
        .fill(null)
        .map((_, i) => assistant(1000 + i)),
      ...Array(8)
        .fill(null)
        .map((_, i) => thinking(2000 + i)),
      ...Array(6)
        .fill(null)
        .map((_, i) => subagent(3000 + i)),
      ...Array(4)
        .fill(null)
        .map((_, i) => compaction(4000 + i)),
      ...Array(2)
        .fill(null)
        .map((_, i) => toolErr(5000 + i)),
    ];
    const { counts, overflow } = hiddenKindCounts(hidden);
    expect(counts).toEqual([
      { kind: "assistant", count: 10 },
      { kind: "thinking", count: 8 },
      { kind: "subagent", count: 6 },
    ]);
    // compaction (4) and error (2) didn't make the top 3.
    expect(overflow).toBe(2);
  });

  it("buckets ok tool-calls and task-notifications together as 'tool', errors separately", () => {
    const hidden = [toolErr(1), ...tools(3, 2)];
    const { counts } = hiddenKindCounts(hidden);
    expect(counts).toEqual(
      expect.arrayContaining([
        { kind: "tool", count: 3 },
        { kind: "error", count: 1 },
      ]),
    );
  });

  it("returns an empty summary for an empty hidden middle", () => {
    expect(hiddenKindCounts([])).toEqual({ counts: [], overflow: 0 });
  });

  it("still counts a user entry inside a hidden middle (compactions/users can appear mid-turn)", () => {
    const { counts } = hiddenKindCounts([user(1), compaction(2)]);
    expect(counts).toEqual(
      expect.arrayContaining([
        { kind: "user", count: 1 },
        { kind: "compaction", count: 1 },
      ]),
    );
  });
});
