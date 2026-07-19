import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LearningSource } from "@junrei/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeLearningSourceSessions,
  resolveLearningRepoRoot,
  resolveRepoAgainstRoots,
} from "./insight.js";

const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);

/**
 * Unit tests for the pure repo-key resolution (`resolveRepoAgainstRoots`) —
 * the testable core of `resolveRepoParam`'s bare-name ergonomics fix (PR3).
 * The async `resolveRepoParam` wrapper only adds the `knownRepoRoots()` I/O
 * on top of this pure function, so every resolution rule is exercised here
 * against explicit root arrays.
 */
describe("resolveRepoAgainstRoots", () => {
  const roots = ["/Users/me/junrei", "/Users/me/factorx", "/Users/other/junrei"];

  it("returns no filter for an empty/undefined repo", () => {
    expect(resolveRepoAgainstRoots(undefined, roots)).toEqual({});
    expect(resolveRepoAgainstRoots("", roots)).toEqual({});
  });

  it("passes an absolute repoRoot path through verbatim", () => {
    expect(resolveRepoAgainstRoots("/Users/me/junrei", roots)).toEqual({
      repo: "/Users/me/junrei",
    });
    // Even when it isn't among the known roots — an absolute key is already
    // opaque and unambiguous; it simply matches whatever sessions carry it.
    expect(resolveRepoAgainstRoots("/nowhere/x", [])).toEqual({ repo: "/nowhere/x" });
  });

  it("passes a fallback-bucket key through verbatim (never treated as a bare name)", () => {
    for (const key of [
      "claude-project:-Users-me-proj",
      "codex-repo:git@x",
      "codex-cwd:(unknown cwd)",
    ]) {
      expect(resolveRepoAgainstRoots(key, roots)).toEqual({ repo: key });
    }
  });

  it("resolves a bare name that uniquely matches one root by basename", () => {
    expect(resolveRepoAgainstRoots("factorx", roots)).toEqual({ repo: "/Users/me/factorx" });
  });

  it("returns sorted candidates when a bare name matches several roots", () => {
    expect(resolveRepoAgainstRoots("junrei", roots)).toEqual({
      candidates: ["/Users/me/junrei", "/Users/other/junrei"],
    });
  });

  it("deduplicates identical roots before deciding uniqueness", () => {
    expect(resolveRepoAgainstRoots("junrei", ["/Users/me/junrei", "/Users/me/junrei"])).toEqual({
      repo: "/Users/me/junrei",
    });
  });

  it("passes an unmatched bare name through verbatim (honest empty result, never an error)", () => {
    expect(resolveRepoAgainstRoots("ghost", roots)).toEqual({ repo: "ghost" });
  });
});

/**
 * Unit tests for `mergeLearningSourceSessions` — the pure precedence rule
 * `log_learning`'s create/update path applies to reconcile an explicit
 * `sourceSessions` array (an `analyze_session` recommendation's
 * `logLearningCall.sourceSessions`, passed verbatim) against the legacy
 * top-level `source`+`sessionId` pair.
 */
describe("mergeLearningSourceSessions", () => {
  const a: LearningSource = { source: "claude-code", sessionId: "sess-a", title: "A" };
  const b: LearningSource = { source: "codex", sessionId: "sess-b" };

  it("returns [] when neither sourceSessions nor the top-level pair is given", () => {
    expect(mergeLearningSourceSessions({})).toEqual([]);
  });

  it("falls back to the top-level pair alone when sourceSessions is absent (pre-existing behavior)", () => {
    expect(mergeLearningSourceSessions({ source: "claude-code", sessionId: "sess-a" })).toEqual([
      { source: "claude-code", sessionId: "sess-a" },
    ]);
  });

  it("treats an explicitly empty sourceSessions array the same as absent", () => {
    expect(
      mergeLearningSourceSessions({
        sourceSessions: [],
        source: "claude-code",
        sessionId: "sess-a",
      }),
    ).toEqual([{ source: "claude-code", sessionId: "sess-a" }]);
  });

  it("an explicit sourceSessions array wins when the top-level pair is absent", () => {
    expect(mergeLearningSourceSessions({ sourceSessions: [a, b] })).toEqual([a, b]);
  });

  it("both present, top-level pair NOT already in the array: sourceSessions wins, pair is merged in", () => {
    expect(
      mergeLearningSourceSessions({
        sourceSessions: [a],
        source: "codex",
        sessionId: "sess-c",
      }),
    ).toEqual([a, { source: "codex", sessionId: "sess-c" }]);
  });

  it("both present, top-level pair ALREADY in the array: no duplicate is added", () => {
    expect(
      mergeLearningSourceSessions({
        sourceSessions: [a, b],
        source: b.source,
        sessionId: b.sessionId,
      }),
    ).toEqual([a, b]);
  });
});

/**
 * `resolveLearningRepoRoot`'s repoRoot-derivation precedence:
 * `repoPath` > first `sourceSessions` entry's cwd > top-level `source`+`sessionId`'s cwd.
 * Uses two real fixture sessions with distinct `cwd`s (no `repoPath`
 * override) so each branch is distinguishable by its resolved root — neither
 * branch performs any filesystem write, so this is safe against the fixture
 * paths not existing on disk.
 */
describe("resolveLearningRepoRoot", () => {
  let previousConfigDir: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_FIXTURES_DIR;
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });

  // Fixture session cwds (see packages/core/test/fixtures/projects/-Users-test-proj/*.jsonl):
  // 11111111-... -> /Users/test/proj, 33333333-... -> /Users/test/proj3.
  const sessionA = "11111111-1111-1111-1111-111111111111";
  const sessionB = "33333333-3333-3333-3333-333333333333";

  it("an explicit repoPath always wins", async () => {
    await expect(
      resolveLearningRepoRoot({
        repoPath: "/explicit/root",
        sourceSessions: [{ source: "claude-code", sessionId: sessionA }],
      }),
    ).resolves.toBe("/explicit/root");
  });

  it("falls back to the top-level source+sessionId pair when sourceSessions is absent", async () => {
    await expect(
      resolveLearningRepoRoot({ source: "claude-code", sessionId: sessionA }),
    ).resolves.toBe("/Users/test/proj");
  });

  it("resolves from the FIRST sourceSessions entry's cwd, even when a different top-level pair is also given", async () => {
    await expect(
      resolveLearningRepoRoot({
        source: "claude-code",
        sessionId: sessionA,
        sourceSessions: [
          { source: "claude-code", sessionId: sessionB },
          { source: "claude-code", sessionId: sessionA },
        ],
      }),
    ).resolves.toBe("/Users/test/proj3");
  });

  it("returns undefined when nothing resolvable is given", async () => {
    await expect(resolveLearningRepoRoot({})).resolves.toBeUndefined();
  });
});
