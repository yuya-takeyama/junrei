import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../api.js";
import {
  type ChipState,
  computeChipCounts,
  DEFAULT_CHIPS,
  isEntryVisible,
  toggleChip,
} from "./timelineFilters.js";

const USER: TimelineEntry = { kind: "user", line: 1, text: "hi", truncated: false };
const ASSISTANT: TimelineEntry = { kind: "assistant-text", line: 2, text: "hi", truncated: false };
const THINKING: TimelineEntry = { kind: "thinking", line: 3, charCount: 10 };
const TOOL_OK: TimelineEntry = {
  kind: "tool-call",
  line: 4,
  toolUseId: "t1",
  name: "Read",
  inputSummary: "foo.ts",
  status: "ok",
};
const TOOL_ERR: TimelineEntry = {
  kind: "tool-call",
  line: 5,
  toolUseId: "t2",
  name: "Bash",
  inputSummary: "npm test",
  status: "error",
};
const SUBAGENT: TimelineEntry = {
  kind: "subagent-launch",
  line: 6,
  toolUseId: "t3",
  promptTruncated: false,
};
const TASK: TimelineEntry = {
  kind: "task-notification",
  line: 7,
  taskId: "bash_1",
  background: true,
};
const COMPACTION: TimelineEntry = { kind: "compaction", line: 8 };
const API_ERROR: TimelineEntry = { kind: "api-error", line: 9 };

const ALL: TimelineEntry[] = [
  USER,
  ASSISTANT,
  THINKING,
  TOOL_OK,
  TOOL_ERR,
  SUBAGENT,
  TASK,
  COMPACTION,
  API_ERROR,
];

describe("isEntryVisible", () => {
  it("user-only dial shows only user entries, regardless of chips", () => {
    const visible = ALL.filter((e) => isEntryVisible(e, "user-only", DEFAULT_CHIPS));
    expect(visible).toEqual([USER]);
  });

  it("minimal dial shows user/assistant-text/subagent-launch/compaction only", () => {
    const visible = ALL.filter((e) => isEntryVisible(e, "minimal", DEFAULT_CHIPS));
    expect(visible).toEqual([USER, ASSISTANT, SUBAGENT, COMPACTION]);
  });

  it("full dial shows every kind when all chips are on", () => {
    const visible = ALL.filter((e) => isEntryVisible(e, "full", DEFAULT_CHIPS));
    expect(visible).toEqual(ALL);
  });

  it("turning off the tool chip hides ok tool calls but keeps error tool calls", () => {
    const chips: ChipState = { ...DEFAULT_CHIPS, tool: false };
    const visible = ALL.filter((e) => isEntryVisible(e, "full", chips));
    expect(visible).not.toContain(TOOL_OK);
    expect(visible).toContain(TOOL_ERR);
  });

  it("turning off the error chip hides error tool calls and api-errors but keeps ok tool calls", () => {
    const chips: ChipState = { ...DEFAULT_CHIPS, error: false };
    const visible = ALL.filter((e) => isEntryVisible(e, "full", chips));
    expect(visible).toContain(TOOL_OK);
    expect(visible).not.toContain(TOOL_ERR);
    expect(visible).not.toContain(API_ERROR);
  });

  it("thinking and task-notification are ungated by chips (dial-only)", () => {
    const chips: ChipState = {
      user: false,
      assistant: false,
      tool: false,
      subagent: false,
      error: false,
      compaction: false,
    };
    const visible = ALL.filter((e) => isEntryVisible(e, "full", chips));
    expect(visible).toEqual([THINKING, TASK]);
  });
});

describe("computeChipCounts", () => {
  it("tallies each kind into its chip bucket, splitting tool-call by status", () => {
    expect(computeChipCounts(ALL)).toEqual({
      user: 1,
      assistant: 1,
      tool: 1,
      subagent: 1,
      error: 2,
      compaction: 1,
    });
  });
});

describe("toggleChip", () => {
  it("focuses the clicked chip when every chip is enabled", () => {
    expect(toggleChip(DEFAULT_CHIPS, "user")).toEqual({
      user: true,
      assistant: false,
      tool: false,
      subagent: false,
      error: false,
      compaction: false,
    });
  });

  it("adds another chip after the initial focused selection", () => {
    const focused = toggleChip(DEFAULT_CHIPS, "user");

    expect(toggleChip(focused, "assistant")).toEqual({
      ...focused,
      assistant: true,
    });
  });

  it("still removes an enabled chip from a partial selection", () => {
    const focused = toggleChip(DEFAULT_CHIPS, "user");
    const combined = toggleChip(focused, "assistant");

    expect(toggleChip(combined, "user")).toEqual({
      ...combined,
      user: false,
    });
  });
});
