import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLearning,
  listLearnings,
  resolveRepoRoot,
  updateLearning,
} from "./learningsStore.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "junrei-learnings-"));
});

// mkdtemp dirs are unique per test; the OS temp dir is reclaimed by the OS, so
// no explicit teardown is required — but keep a hook for symmetry/future use.
afterEach(() => {});

const FIXED = new Date("2026-07-19T08:00:00.000Z");

describe("resolveRepoRoot", () => {
  it("strips a .claude/worktrees/<name> suffix to the underlying repo root", () => {
    expect(resolveRepoRoot("/Users/y/src/repo/.claude/worktrees/feature-x")).toBe(
      "/Users/y/src/repo",
    );
  });

  it("strips the suffix even from a nested cwd inside the worktree", () => {
    expect(resolveRepoRoot("/Users/y/src/repo/.claude/worktrees/feature-x/packages/core")).toBe(
      "/Users/y/src/repo",
    );
  });

  it("leaves a plain repo cwd unchanged (trailing slash trimmed)", () => {
    expect(resolveRepoRoot("/Users/y/src/repo/")).toBe("/Users/y/src/repo");
  });

  it("falls back to cwd for a Codex central worktree (no repo root derivable)", () => {
    expect(resolveRepoRoot("/Users/y/.codex/worktrees/abcd/repo")).toBe(
      "/Users/y/.codex/worktrees/abcd/repo",
    );
  });
});

describe("createLearning", () => {
  it("writes one file per learning under .junrei/learnings with a derived id", async () => {
    const learning = await createLearning(repoRoot, {
      finding: "Orchestrator re-runs git status",
      change: "Cache git status once per turn",
      now: FIXED,
    });
    expect(learning.id).toBe("L-20260719-orchestrator-re-runs-git-status");
    expect(learning.status).toBe("open");
    expect(learning.proposedBy).toBe("agent");
    expect(learning.createdAt).toBe(FIXED.toISOString());

    const files = await readdir(join(repoRoot, ".junrei", "learnings"));
    expect(files).toEqual([`${learning.id}.json`]);
    const onDisk = JSON.parse(
      await readFile(join(repoRoot, ".junrei", "learnings", `${learning.id}.json`), "utf8"),
    );
    expect(onDisk).toEqual(learning);
  });

  it("defaults repo to the repo root's basename", async () => {
    const learning = await createLearning(repoRoot, { finding: "x", change: "y", now: FIXED });
    // mkdtemp basename is the last path segment of the temp dir.
    expect(learning.repo).toBe(repoRoot.split("/").pop());
  });

  it("de-dupes a colliding id with a numeric suffix instead of overwriting", async () => {
    const a = await createLearning(repoRoot, { finding: "same finding", change: "c1", now: FIXED });
    const b = await createLearning(repoRoot, { finding: "same finding", change: "c2", now: FIXED });
    expect(a.id).toBe("L-20260719-same-finding");
    expect(b.id).toBe("L-20260719-same-finding-2");
    const { learnings } = await listLearnings(repoRoot);
    expect(learnings).toHaveLength(2);
  });

  it("does not leave any temp files behind after an atomic write", async () => {
    await createLearning(repoRoot, { finding: "x", change: "y", now: FIXED });
    const files = await readdir(join(repoRoot, ".junrei", "learnings"));
    expect(files.every((f) => f.endsWith(".json") && !f.includes(".tmp"))).toBe(true);
  });

  it("persists expectedEffect only when provided", async () => {
    const withEffect = await createLearning(repoRoot, {
      finding: "a",
      change: "b",
      expectedEffect: "lower cost",
      now: FIXED,
    });
    expect(withEffect.expectedEffect).toBe("lower cost");
    const without = await createLearning(repoRoot, { finding: "c", change: "d", now: FIXED });
    expect("expectedEffect" in without).toBe(false);
  });
});

describe("updateLearning", () => {
  it("timestamps appliedAt on the transition to applied", async () => {
    const created = await createLearning(repoRoot, { finding: "a", change: "b", now: FIXED });
    const applied = await updateLearning(repoRoot, created.id, {
      status: "applied",
      now: new Date("2026-07-20T00:00:00.000Z"),
    });
    expect(applied.status).toBe("applied");
    expect(applied.appliedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(applied.resolvedAt).toBeUndefined();
  });

  it("timestamps resolvedAt on the transition to verified and records verification", async () => {
    const created = await createLearning(repoRoot, { finding: "a", change: "b", now: FIXED });
    const verified = await updateLearning(repoRoot, created.id, {
      status: "verified",
      verification: { metric: "avgSessionCostUsd", before: 2, after: 1, windowDays: 7 },
      now: new Date("2026-07-25T00:00:00.000Z"),
    });
    expect(verified.status).toBe("verified");
    expect(verified.resolvedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(verified.verification).toEqual({
      metric: "avgSessionCostUsd",
      before: 2,
      after: 1,
      windowDays: 7,
    });
  });

  it("persists the update atomically (re-read matches returned object)", async () => {
    const created = await createLearning(repoRoot, { finding: "a", change: "b", now: FIXED });
    const updated = await updateLearning(repoRoot, created.id, { change: "b2", now: FIXED });
    const { learnings } = await listLearnings(repoRoot);
    expect(learnings[0]).toEqual(updated);
    expect(learnings[0]?.change).toBe("b2");
  });

  it("throws for an unknown id rather than silently creating one", async () => {
    await expect(updateLearning(repoRoot, "L-nope", { status: "applied" })).rejects.toThrow(
      /not found/,
    );
  });
});

describe("listLearnings", () => {
  it("returns an empty result when the ledger directory does not exist", async () => {
    const result = await listLearnings(repoRoot);
    expect(result).toEqual({ learnings: [], warnings: [] });
  });

  it("skips a corrupt JSON file with a warning but still returns the valid ones", async () => {
    const good = await createLearning(repoRoot, { finding: "good", change: "c", now: FIXED });
    const dir = join(repoRoot, ".junrei", "learnings");
    await writeFile(join(dir, "broken.json"), "{ not valid json", "utf8");
    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ hello: "world" }), "utf8");

    const { learnings, warnings } = await listLearnings(repoRoot);
    expect(learnings.map((l) => l.id)).toEqual([good.id]);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("broken.json"))).toBe(true);
    expect(warnings.some((w) => w.includes("wrong-shape.json"))).toBe(true);
  });

  it("filters by status and by repo", async () => {
    await createLearning(repoRoot, { finding: "one", change: "c", repo: "alpha", now: FIXED });
    const two = await createLearning(repoRoot, {
      finding: "two",
      change: "c",
      repo: "alpha",
      status: "applied",
      now: FIXED,
    });
    await createLearning(repoRoot, { finding: "three", change: "c", repo: "beta", now: FIXED });

    const applied = await listLearnings(repoRoot, { status: "applied" });
    expect(applied.learnings.map((l) => l.id)).toEqual([two.id]);

    const beta = await listLearnings(repoRoot, { repo: "beta" });
    expect(beta.learnings.map((l) => l.finding)).toEqual(["three"]);
  });

  it("returns learnings newest-first by createdAt", async () => {
    await createLearning(repoRoot, {
      finding: "older",
      change: "c",
      id: "L-a",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    await createLearning(repoRoot, {
      finding: "newer",
      change: "c",
      id: "L-b",
      now: new Date("2026-07-10T00:00:00.000Z"),
    });
    const { learnings } = await listLearnings(repoRoot);
    expect(learnings.map((l) => l.finding)).toEqual(["newer", "older"]);
  });

  it("tolerates a pre-existing empty ledger directory", async () => {
    await mkdir(join(repoRoot, ".junrei", "learnings"), { recursive: true });
    const result = await listLearnings(repoRoot);
    expect(result).toEqual({ learnings: [], warnings: [] });
  });
});
