import { describe, expect, it } from "vitest";
import type { ClaudeSessionListItem, CodexSessionListItem } from "./api.js";
import {
  isEstimatedCost,
  sessionsListQuery,
  sourceBadgeLabel,
  subagentCellText,
} from "./sessionListHelpers.js";

const claudeItem: ClaudeSessionListItem = {
  source: "claude-code",
  sessionId: "s1",
  projectDirName: "-Users-me-proj",
  subagentCount: 3,
  userTurnCount: 5,
  models: ["claude-sonnet-4"],
  totalCostUsd: 1.23,
  costIsComplete: true,
  totalTokens: 1000,
  cacheReadTokens: 200,
  compactionCount: 0,
  toolCallCount: 4,
  toolErrorCount: 0,
  sizeBytes: 4096,
  modelMix: [],
};

const codexItem: CodexSessionListItem = {
  source: "codex",
  sessionId: "s2",
  projectDirName: "codex",
  subagentCount: 0,
  archived: false,
  userTurnCount: 2,
  models: ["gpt-5"],
  totalCostUsd: 0.45,
  costIsComplete: true,
  totalTokens: 500,
  cacheReadTokens: 50,
  compactionCount: 0,
  toolCallCount: 1,
  toolErrorCount: 0,
  sizeBytes: 2048,
  modelMix: [],
};

describe("sessionsListQuery", () => {
  it("passes the active tab through as the `source` query param", () => {
    expect(sessionsListQuery("all", "200")).toEqual({ limit: "200", source: "all" });
    expect(sessionsListQuery("claude-code", "200")).toEqual({
      limit: "200",
      source: "claude-code",
    });
    expect(sessionsListQuery("codex", "200")).toEqual({ limit: "200", source: "codex" });
  });
});

describe("subagentCellText", () => {
  it("shows the real count for Claude Code sessions when > 0", () => {
    expect(subagentCellText(claudeItem)).toBe("3");
  });

  it("shows an em dash instead of a literal 0 (Codex sessions have a real subagentCount too now)", () => {
    expect(subagentCellText(codexItem)).toBe("—");
  });

  it("shows an em dash for a Claude Code session with zero subagents too — 0 and 'not applicable' must read the same", () => {
    expect(subagentCellText({ ...claudeItem, subagentCount: 0 })).toBe("—");
  });

  it("shows the real count for a Codex parent session with sub-agents", () => {
    expect(subagentCellText({ ...codexItem, subagentCount: 2 })).toBe("2");
  });
});

describe("sourceBadgeLabel", () => {
  it("labels each source", () => {
    expect(sourceBadgeLabel("claude-code")).toBe("Claude");
    expect(sourceBadgeLabel("codex")).toBe("Codex");
  });
});

describe("isEstimatedCost", () => {
  it("is true only for Codex rows", () => {
    expect(isEstimatedCost(claudeItem)).toBe(false);
    expect(isEstimatedCost(codexItem)).toBe(true);
  });
});
