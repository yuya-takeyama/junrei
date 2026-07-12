import { describe, expect, it } from "vitest";
import { deriveRepoIdentity } from "./repo.js";

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
});
