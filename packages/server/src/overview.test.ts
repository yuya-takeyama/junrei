import { describe, expect, it } from "vitest";
import { computeRepoOverview } from "./overview.js";
import type { AnySessionListItem } from "./sessions.js";
import type { ClaudeSessionListItem } from "./sources/claude.js";
import type { CodexSessionListItem } from "./sources/codex.js";

function claudeItem(overrides: Partial<ClaudeSessionListItem> = {}): ClaudeSessionListItem {
  return {
    source: "claude-code",
    sessionId: "c1",
    projectDirName: "-Users-me-proj",
    subagentCount: 0,
    userTurnCount: 1,
    models: ["claude-sonnet-4"],
    totalCostUsd: 1,
    costIsComplete: true,
    totalTokens: 100,
    cacheReadTokens: 0,
    compactionCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    sizeBytes: 100,
    modelMix: [],
    usageByModel: [],
    delegation: { main: { tokens: 0 }, subagents: { tokens: 0 } },
    ...overrides,
  };
}

function codexItem(overrides: Partial<CodexSessionListItem> = {}): CodexSessionListItem {
  return {
    source: "codex",
    sessionId: "x1",
    subagentCount: 0,
    archived: false,
    userTurnCount: 1,
    models: ["gpt-5"],
    totalCostUsd: 1,
    costIsComplete: true,
    totalTokens: 100,
    cacheReadTokens: 0,
    compactionCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    sizeBytes: 100,
    modelMix: [],
    usageByModel: [],
    delegation: { main: { tokens: 0 }, subagents: { tokens: 0 } },
    ...overrides,
  };
}

const REPO = "/Users/me/junrei";

describe("computeRepoOverview — repo-key matching", () => {
  it("matches sessions by repoRoot and excludes sessions from other repos", () => {
    const items: AnySessionListItem[] = [
      claudeItem({ sessionId: "a", repoRoot: REPO }),
      claudeItem({ sessionId: "b", repoRoot: "/Users/me/other-repo" }),
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.sessionCount).toBe(1);
    expect(overview.repo).toBe(REPO);
  });

  it("collapses a worktree session's repoRoot into the same key as the repo-root session", () => {
    const items: AnySessionListItem[] = [
      claudeItem({ sessionId: "a", repoRoot: REPO }),
      claudeItem({ sessionId: "b", repoRoot: REPO, worktreeName: "feat-x" }),
    ];
    expect(computeRepoOverview(items, REPO).sessionCount).toBe(2);
  });

  it("falls back to a projectDirName-keyed bucket for a Claude session with no repoRoot", () => {
    const items: AnySessionListItem[] = [
      claudeItem({ sessionId: "a", projectDirName: "-Users-me-proj" }),
      claudeItem({ sessionId: "b", projectDirName: "-Users-other-proj" }),
    ];
    const overview = computeRepoOverview(items, "claude-project:-Users-me-proj");
    expect(overview.sessionCount).toBe(1);
    expect(overview.topSessions.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("falls back to a cwd-keyed bucket for a Codex session with no repoRoot", () => {
    const items: AnySessionListItem[] = [
      codexItem({ sessionId: "a", cwd: "/Users/me/other" }),
      codexItem({ sessionId: "b", cwd: "/Users/me/elsewhere" }),
    ];
    const overview = computeRepoOverview(items, "codex-cwd:/Users/me/other");
    expect(overview.sessionCount).toBe(1);
    expect(overview.topSessions.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("groups Codex sessions with neither repoRoot nor cwd into the fixed unknown-cwd bucket", () => {
    const items: AnySessionListItem[] = [
      codexItem({ sessionId: "a" }),
      codexItem({ sessionId: "b" }),
    ];
    const overview = computeRepoOverview(items, "codex-cwd:(unknown cwd)");
    expect(overview.sessionCount).toBe(2);
  });

  it("returns an empty (zeroed) overview, not an error, for a repo key matching nothing", () => {
    const overview = computeRepoOverview([claudeItem({ repoRoot: REPO })], "/no/such/repo");
    expect(overview.sessionCount).toBe(0);
    expect(overview.totalCostUsd).toBe(0);
    expect(overview.costIsComplete).toBe(true);
    expect(overview.perDay).toEqual([]);
    expect(overview.byModel).toEqual([]);
    expect(overview.topSessions).toEqual([]);
  });
});

describe("computeRepoOverview — totals, sourceCounts", () => {
  it("counts sessions per source and sums cost/tokens across both", () => {
    const items: AnySessionListItem[] = [
      claudeItem({ sessionId: "a", repoRoot: REPO, totalCostUsd: 10, totalTokens: 1000 }),
      claudeItem({ sessionId: "b", repoRoot: REPO, totalCostUsd: 5, totalTokens: 500 }),
      codexItem({ sessionId: "c", repoRoot: REPO, totalCostUsd: 2, totalTokens: 200 }),
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.sessionCount).toBe(3);
    expect(overview.sourceCounts).toEqual({ "claude-code": 2, codex: 1 });
    expect(overview.totalCostUsd).toBe(17);
    expect(overview.totalTokens).toBe(1700);
  });

  it("AND-s costIsComplete across sessions — false if any one session is incomplete", () => {
    const allComplete = computeRepoOverview(
      [
        claudeItem({ repoRoot: REPO, costIsComplete: true }),
        claudeItem({ sessionId: "b", repoRoot: REPO, costIsComplete: true }),
      ],
      REPO,
    );
    expect(allComplete.costIsComplete).toBe(true);

    const oneIncomplete = computeRepoOverview(
      [
        claudeItem({ repoRoot: REPO, costIsComplete: true }),
        claudeItem({ sessionId: "b", repoRoot: REPO, costIsComplete: false }),
      ],
      REPO,
    );
    expect(oneIncomplete.costIsComplete).toBe(false);
  });
});

describe("computeRepoOverview — perDay UTC bucketing", () => {
  it("buckets sessions by the UTC calendar day of startedAt", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        totalCostUsd: 3,
        startedAt: "2026-07-08T23:00:00.000Z",
      }),
      claudeItem({
        sessionId: "b",
        repoRoot: REPO,
        totalCostUsd: 4,
        startedAt: "2026-07-09T01:00:00.000Z",
      }),
      claudeItem({
        sessionId: "c",
        repoRoot: REPO,
        totalCostUsd: 2,
        startedAt: "2026-07-09T20:00:00.000Z",
      }),
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.perDay).toEqual([
      { date: "2026-07-08", costUsd: 3, sessionCount: 1 },
      { date: "2026-07-09", costUsd: 6, sessionCount: 2 },
    ]);
  });

  it("a UTC-late local timestamp still buckets under the earlier UTC day (not the local day)", () => {
    // 23:00 UTC on the 8th is still the 8th in UTC, whatever the local
    // timezone running the test happens to be — the point under test is
    // that bucketing uses `Date#toISOString`, not local wall-clock fields.
    const overview = computeRepoOverview(
      [claudeItem({ repoRoot: REPO, startedAt: "2026-07-08T23:59:59.000Z" })],
      REPO,
    );
    expect(overview.perDay).toEqual([{ date: "2026-07-08", costUsd: 1, sessionCount: 1 }]);
  });

  it("omits sessions with no startedAt from perDay but still counts them in totals", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        totalCostUsd: 5,
        startedAt: "2026-07-09T00:00:00Z",
      }),
      claudeItem({ sessionId: "b", repoRoot: REPO, totalCostUsd: 7 }), // no startedAt
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.sessionCount).toBe(2);
    expect(overview.totalCostUsd).toBe(12);
    expect(overview.perDay).toEqual([{ date: "2026-07-09", costUsd: 5, sessionCount: 1 }]);
  });
});

describe("computeRepoOverview — byModel merge", () => {
  it("merges usageByModel across sessions, summing every field per model", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        usageByModel: [
          {
            model: "claude-sonnet-4",
            costUsd: 3,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
          },
        ],
      }),
      claudeItem({
        sessionId: "b",
        repoRoot: REPO,
        usageByModel: [
          {
            model: "claude-sonnet-4",
            costUsd: 2,
            inputTokens: 40,
            outputTokens: 20,
            cacheReadTokens: 4,
            cacheCreationTokens: 1,
          },
        ],
      }),
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.byModel).toEqual([
      {
        model: "claude-sonnet-4",
        costUsd: 5,
        inputTokens: 140,
        outputTokens: 70,
        cacheReadTokens: 14,
        cacheCreationTokens: 6,
      },
    ]);
    expect(overview.totalOutputTokens).toBe(70);
  });

  it("sorts byModel cost-descending", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        usageByModel: [
          {
            model: "cheap",
            costUsd: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          {
            model: "pricey",
            costUsd: 9,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      }),
    ];
    expect(computeRepoOverview(items, REPO).byModel.map((m) => m.model)).toEqual([
      "pricey",
      "cheap",
    ]);
  });

  it("leaves costUsd undefined for an unpriced model while still summing the priced ones into totalCostUsd", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        totalCostUsd: 4, // this session's own priced total (session-level, separate from the per-model rollup)
        costIsComplete: false,
        usageByModel: [
          {
            model: "priced-model",
            costUsd: 4,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          {
            // No pricing entry for this model — costUsd omitted entirely.
            model: "unpriced-model",
            inputTokens: 20,
            outputTokens: 8,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      }),
    ];
    const overview = computeRepoOverview(items, REPO);
    const unpriced = overview.byModel.find((m) => m.model === "unpriced-model");
    const priced = overview.byModel.find((m) => m.model === "priced-model");
    expect(unpriced?.costUsd).toBeUndefined();
    expect(unpriced?.outputTokens).toBe(8);
    expect(priced?.costUsd).toBe(4);
    // The session-level totalCostUsd (what actually bills) still sums only
    // the priced portion — unaffected by the unpriced model's missing cost.
    expect(overview.totalCostUsd).toBe(4);
    expect(overview.costIsComplete).toBe(false);
  });
});

describe("computeRepoOverview — delegation sums", () => {
  it("sums main/subagents tokens and cost across every matched session", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        delegation: { main: { tokens: 100, costUsd: 1 }, subagents: { tokens: 300, costUsd: 3 } },
      }),
      claudeItem({
        sessionId: "b",
        repoRoot: REPO,
        delegation: {
          main: { tokens: 50, costUsd: 0.5 },
          subagents: { tokens: 150, costUsd: 1.5 },
        },
      }),
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.delegation).toEqual({
      main: { tokens: 150, costUsd: 1.5 },
      subagents: { tokens: 450, costUsd: 4.5 },
    });
  });

  it("drops delegation costUsd once any contributing session's slice is unpriced", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        delegation: { main: { tokens: 100, costUsd: 1 }, subagents: { tokens: 300 } },
      }),
    ];
    const overview = computeRepoOverview(items, REPO);
    expect(overview.delegation.main).toEqual({ tokens: 100, costUsd: 1 });
    expect(overview.delegation.subagents).toEqual({ tokens: 300 });
    expect(overview.delegation.subagents.costUsd).toBeUndefined();
  });
});

describe("computeRepoOverview — topSessions", () => {
  it("returns at most the top 5 sessions by cost, descending", () => {
    const items: AnySessionListItem[] = Array.from({ length: 8 }, (_, i) =>
      claudeItem({ sessionId: `s${String(i)}`, repoRoot: REPO, totalCostUsd: i }),
    );
    const overview = computeRepoOverview(items, REPO);
    expect(overview.topSessions).toHaveLength(5);
    expect(overview.topSessions.map((s) => s.sessionId)).toEqual(["s7", "s6", "s5", "s4", "s3"]);
    expect(overview.topSessions.map((s) => s.costUsd)).toEqual([7, 6, 5, 4, 3]);
  });

  it("truncates firstUserPrompt to ~80 chars and carries title/worktreeName/startedAt through", () => {
    const longPrompt = "x".repeat(200);
    const items: AnySessionListItem[] = [
      claudeItem({
        repoRoot: REPO,
        totalCostUsd: 9,
        title: "My session",
        firstUserPrompt: longPrompt,
        startedAt: "2026-07-09T00:00:00Z",
        worktreeName: "feat-x",
      }),
    ];
    const [top] = computeRepoOverview(items, REPO).topSessions;
    expect(top?.title).toBe("My session");
    expect(top?.firstUserPrompt?.length).toBeLessThanOrEqual(81); // 80 chars + ellipsis
    expect(top?.firstUserPrompt?.startsWith("x".repeat(80))).toBe(true);
    expect(top?.startedAt).toBe("2026-07-09T00:00:00Z");
    expect(top?.worktreeName).toBe("feat-x");
  });

  it("carries projectDirName for Claude sessions but omits it for Codex sessions", () => {
    const items: AnySessionListItem[] = [
      claudeItem({
        sessionId: "a",
        repoRoot: REPO,
        totalCostUsd: 5,
        projectDirName: "-Users-me-proj",
      }),
      codexItem({ sessionId: "b", repoRoot: REPO, totalCostUsd: 3 }),
    ];
    const [first, second] = computeRepoOverview(items, REPO).topSessions;
    expect(first?.projectDirName).toBe("-Users-me-proj");
    expect(second?.projectDirName).toBeUndefined();
  });
});
