import { describe, expect, it } from "vitest";
import type { ClaudeSessionListItem, CodexSessionListItem } from "./api.js";
import {
  disambiguateBasenames,
  projectFilterKey,
  repoFilterKey,
  repoOptionsFor,
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
  usageByModel: [],
  delegation: { main: { tokens: 0 }, subagents: { tokens: 0 } },
};

const codexItem: CodexSessionListItem = {
  source: "codex",
  sessionId: "s2",
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
  usageByModel: [],
  delegation: { main: { tokens: 0 }, subagents: { tokens: 0 } },
};

describe("sessionsListQuery", () => {
  it("passes the active tab through as the `source` query param, plus the fetch window", () => {
    expect(sessionsListQuery("all", "500", "0")).toEqual({
      limit: "500",
      offset: "0",
      source: "all",
    });
    expect(sessionsListQuery("claude-code", "500", "0")).toEqual({
      limit: "500",
      offset: "0",
      source: "claude-code",
    });
    expect(sessionsListQuery("codex", "500", "0")).toEqual({
      limit: "500",
      offset: "0",
      source: "codex",
    });
  });

  it("omits sinceMs/untilMs entirely when bounds is omitted or has neither set (an 'all dates' filter)", () => {
    expect(sessionsListQuery("all", "500", "0")).toEqual({
      limit: "500",
      offset: "0",
      source: "all",
    });
    expect(sessionsListQuery("all", "500", "0", {})).toEqual({
      limit: "500",
      offset: "0",
      source: "all",
    });
  });

  it("includes sinceMs/untilMs as strings only when defined", () => {
    expect(sessionsListQuery("all", "500", "0", { sinceMs: 1000 })).toEqual({
      limit: "500",
      offset: "0",
      source: "all",
      sinceMs: "1000",
    });
    expect(sessionsListQuery("all", "500", "0", { untilMs: 2000 })).toEqual({
      limit: "500",
      offset: "0",
      source: "all",
      untilMs: "2000",
    });
    expect(sessionsListQuery("all", "500", "0", { sinceMs: 1000, untilMs: 2000 })).toEqual({
      limit: "500",
      offset: "0",
      source: "all",
      sinceMs: "1000",
      untilMs: "2000",
    });
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

describe("projectFilterKey", () => {
  it("returns the real projectDirName for a Claude row", () => {
    expect(projectFilterKey(claudeItem)).toBe("-Users-me-proj");
  });

  it("returns the fixed 'codex' label for a Codex row (no project-dir concept)", () => {
    expect(projectFilterKey(codexItem)).toBe("codex");
  });
});

describe("repoFilterKey", () => {
  it("uses repoRoot directly when present, for either source", () => {
    expect(repoFilterKey({ ...claudeItem, repoRoot: "/Users/me/proj" })).toBe("/Users/me/proj");
    expect(repoFilterKey({ ...codexItem, repoRoot: "/Users/me/proj" })).toBe("/Users/me/proj");
  });

  it("collapses a worktree session's repoRoot to the same key as the repo-root session — the whole point of the repo filter", () => {
    const rootSession = { ...claudeItem, repoRoot: "/Users/me/proj" };
    const worktreeSession = {
      ...claudeItem,
      sessionId: "s1-wt",
      repoRoot: "/Users/me/proj",
      worktreeName: "feat-x",
    };
    expect(repoFilterKey(worktreeSession)).toBe(repoFilterKey(rootSession));
  });

  it("falls back to a bucket keyed by projectDirName for a Claude row with no repoRoot", () => {
    expect(repoFilterKey(claudeItem)).toBe("claude-project:-Users-me-proj");
  });

  it("falls back to a bucket keyed by cwd for a Codex row with no repoRoot", () => {
    expect(repoFilterKey({ ...codexItem, cwd: "/Users/me/other" })).toBe(
      "codex-cwd:/Users/me/other",
    );
  });

  it("buckets a Codex row with a repoUrl but no repoRoot by the URL, not the per-worktree cwd", () => {
    const worktreeA = {
      ...codexItem,
      sessionId: "wt-a",
      cwd: "/Users/me/.codex/worktrees/ab12/junrei",
      worktreeName: "ab12",
      repoUrl: "https://github.com/x/junrei",
    };
    const worktreeB = {
      ...codexItem,
      sessionId: "wt-b",
      cwd: "/Users/me/.codex/worktrees/cd34/junrei",
      worktreeName: "cd34",
      repoUrl: "https://github.com/x/junrei",
    };
    expect(repoFilterKey(worktreeA)).toBe("codex-repo:https://github.com/x/junrei");
    expect(repoFilterKey(worktreeA)).toBe(repoFilterKey(worktreeB));
  });

  it("groups Codex rows with neither repoRoot nor cwd into one fixed 'unknown' bucket", () => {
    expect(repoFilterKey(codexItem)).toBe(repoFilterKey({ ...codexItem, sessionId: "s3" }));
  });

  it("never collides a fallback bucket key with a real repoRoot (fallback prefixes aren't absolute paths)", () => {
    expect(repoFilterKey(claudeItem)).not.toBe("-Users-me-proj");
  });
});

describe("disambiguateBasenames", () => {
  it("labels a single path with its bare basename", () => {
    expect(disambiguateBasenames(["/Users/me/junrei"])).toEqual(
      new Map([["/Users/me/junrei", "junrei"]]),
    );
  });

  it("uses bare basenames when they don't collide", () => {
    const result = disambiguateBasenames(["/Users/me/junrei", "/Users/me/other-repo"]);
    expect(result.get("/Users/me/junrei")).toBe("junrei");
    expect(result.get("/Users/me/other-repo")).toBe("other-repo");
  });

  it("extends the label by one path segment when two repos share a basename", () => {
    const result = disambiguateBasenames([
      "/Users/yuya-takeyama/junrei",
      "/Users/someone-else/junrei",
    ]);
    expect(result.get("/Users/yuya-takeyama/junrei")).toBe("yuya-takeyama/junrei");
    expect(result.get("/Users/someone-else/junrei")).toBe("someone-else/junrei");
  });

  it("extends as far as needed for a three-way basename collision", () => {
    const result = disambiguateBasenames([
      "/Users/a/org/junrei",
      "/Users/b/org/junrei",
      "/Users/c/other/junrei",
    ]);
    expect(result.get("/Users/a/org/junrei")).toBe("a/org/junrei");
    expect(result.get("/Users/b/org/junrei")).toBe("b/org/junrei");
    expect(result.get("/Users/c/other/junrei")).toBe("other/junrei");
  });
});

describe("repoOptionsFor", () => {
  it("returns one option per repo, grouping a worktree session under its repo root", () => {
    const rootSession = { ...claudeItem, repoRoot: "/Users/me/junrei" };
    const worktreeSession = {
      ...claudeItem,
      sessionId: "s1-wt",
      repoRoot: "/Users/me/junrei",
      worktreeName: "feat-x",
    };
    const options = repoOptionsFor([rootSession, worktreeSession]);
    expect(options).toEqual([
      { key: "/Users/me/junrei", label: "junrei", title: "/Users/me/junrei" },
    ]);
  });

  it("includes a fallback option for sessions with no repoRoot, labeled with their available identifier", () => {
    const options = repoOptionsFor([claudeItem]);
    expect(options).toEqual([
      {
        key: "claude-project:-Users-me-proj",
        label: "me-proj",
        title: "-Users-me-proj",
      },
    ]);
  });

  it("disambiguates two repoRoots that share a basename", () => {
    const a = { ...claudeItem, sessionId: "s1", repoRoot: "/Users/yuya-takeyama/junrei" };
    const b = { ...claudeItem, sessionId: "s2", repoRoot: "/Users/someone-else/junrei" };
    const options = repoOptionsFor([a, b]);
    expect(options.map((o) => o.label).sort()).toEqual([
      "someone-else/junrei",
      "yuya-takeyama/junrei",
    ]);
  });

  it("sorts options by label", () => {
    const a = { ...claudeItem, sessionId: "s1", repoRoot: "/x/zeta" };
    const b = { ...claudeItem, sessionId: "s2", repoRoot: "/x/alpha" };
    const options = repoOptionsFor([a, b]);
    expect(options.map((o) => o.label)).toEqual(["alpha", "zeta"]);
  });

  it("collapses Codex worktree sessions sharing a repoUrl into one URL-labeled option", () => {
    const a = {
      ...codexItem,
      sessionId: "wt-a",
      cwd: "/Users/me/.codex/worktrees/ab12/junrei",
      repoUrl: "https://github.com/x/junrei",
    };
    const b = {
      ...codexItem,
      sessionId: "wt-b",
      cwd: "/Users/me/.codex/worktrees/cd34/junrei",
      repoUrl: "https://github.com/x/junrei",
    };
    const options = repoOptionsFor([a, b]);
    expect(options).toEqual([
      {
        key: "codex-repo:https://github.com/x/junrei",
        label: "junrei",
        title: "https://github.com/x/junrei",
      },
    ]);
  });

  it("disambiguates a URL-keyed bucket against a same-named path repo instead of showing two identical labels", () => {
    const pathRepo = { ...claudeItem, sessionId: "s1", repoRoot: "/Users/me/src/junrei" };
    const urlRepo = {
      ...codexItem,
      sessionId: "wt-a",
      cwd: "/Users/me/.codex/worktrees/ab12/junrei",
      repoUrl: "https://github.com/x/junrei",
    };
    const labels = repoOptionsFor([pathRepo, urlRepo]).map((o) => o.label);
    expect(new Set(labels).size).toBe(2);
    // The URL bucket's extended label sheds its scheme (github.com/…, never
    // the https:/… junk raw segment-splitting would produce).
    for (const label of labels) {
      expect(label).not.toMatch(/^https?:/);
    }
  });
});
