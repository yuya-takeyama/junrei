import { describe, expect, it } from "vitest";
import { deriveRepoIdentity, normalizeRepoUrl } from "./repo.js";

describe("deriveRepoIdentity", () => {
  it("returns both fields undefined for an undefined cwd", () => {
    expect(deriveRepoIdentity(undefined)).toEqual({});
  });

  it("returns both fields undefined for an empty cwd", () => {
    expect(deriveRepoIdentity("")).toEqual({});
  });

  it("treats a plain repo cwd as its own repo root with no worktree", () => {
    expect(deriveRepoIdentity("/Users/y/src/repo")).toEqual({ repoRoot: "/Users/y/src/repo" });
  });

  it("splits repoRoot/worktreeName at the .claude/worktrees marker", () => {
    expect(deriveRepoIdentity("/Users/y/src/repo/.claude/worktrees/foo-123")).toEqual({
      repoRoot: "/Users/y/src/repo",
      worktreeName: "foo-123",
    });
  });

  it("still resolves worktreeName when cwd is a subdirectory inside the worktree", () => {
    expect(deriveRepoIdentity("/Users/y/src/repo/.claude/worktrees/foo-123/packages/web")).toEqual({
      repoRoot: "/Users/y/src/repo",
      worktreeName: "foo-123",
    });
  });

  it("tolerates a trailing slash on cwd", () => {
    expect(deriveRepoIdentity("/Users/y/src/repo/")).toEqual({ repoRoot: "/Users/y/src/repo" });
    expect(deriveRepoIdentity("/Users/y/src/repo/.claude/worktrees/foo-123/")).toEqual({
      repoRoot: "/Users/y/src/repo",
      worktreeName: "foo-123",
    });
  });

  it("treats the worktrees dir itself (no name segment) as having no worktree", () => {
    expect(deriveRepoIdentity("/Users/y/src/repo/.claude/worktrees")).toEqual({
      repoRoot: "/Users/y/src/repo/.claude/worktrees",
    });
    expect(deriveRepoIdentity("/Users/y/src/repo/.claude/worktrees/")).toEqual({
      repoRoot: "/Users/y/src/repo/.claude/worktrees",
    });
  });

  it("splits at the FIRST worktrees marker for a nested worktree-in-worktree cwd", () => {
    expect(
      deriveRepoIdentity("/Users/y/src/repo/.claude/worktrees/outer/.claude/worktrees/inner"),
    ).toEqual({
      repoRoot: "/Users/y/src/repo",
      worktreeName: "outer",
    });
  });

  it("yields only worktreeName for a Codex central worktree cwd (no repoRoot derivable)", () => {
    expect(deriveRepoIdentity("/Users/y/.codex/worktrees/05c4/secure-infra")).toEqual({
      worktreeName: "05c4",
    });
  });

  it("still resolves a Codex worktree when cwd is a subdirectory inside it", () => {
    expect(deriveRepoIdentity("/Users/y/.codex/worktrees/05c4/secure-infra/packages/web")).toEqual({
      worktreeName: "05c4",
    });
  });

  it("tolerates a trailing slash on a Codex worktree cwd", () => {
    expect(deriveRepoIdentity("/Users/y/.codex/worktrees/05c4/secure-infra/")).toEqual({
      worktreeName: "05c4",
    });
  });

  it("treats a cwd AT the Codex hash dir (no repo segment) as its own repo root", () => {
    expect(deriveRepoIdentity("/Users/y/.codex/worktrees/05c4")).toEqual({
      repoRoot: "/Users/y/.codex/worktrees/05c4",
    });
  });

  it("treats a .claude worktree nested inside a Codex worktree as the Codex worktree", () => {
    expect(
      deriveRepoIdentity("/Users/y/.codex/worktrees/05c4/repo/.claude/worktrees/inner"),
    ).toEqual({ worktreeName: "05c4" });
  });
});

describe("normalizeRepoUrl", () => {
  it("keeps an already-canonical https URL as-is", () => {
    expect(normalizeRepoUrl("https://github.com/x/junrei")).toBe("https://github.com/x/junrei");
  });

  it("strips a trailing .git suffix", () => {
    expect(normalizeRepoUrl("https://github.com/x/junrei.git")).toBe("https://github.com/x/junrei");
  });

  it("strips trailing slashes (before the .git check)", () => {
    expect(normalizeRepoUrl("https://github.com/x/junrei/")).toBe("https://github.com/x/junrei");
    expect(normalizeRepoUrl("https://github.com/x/junrei.git/")).toBe(
      "https://github.com/x/junrei",
    );
  });

  it("normalizes an scp-style remote the same way", () => {
    expect(normalizeRepoUrl("git@github.com:x/junrei.git")).toBe("git@github.com:x/junrei");
  });
});
