import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FileAccessEntry } from "../metrics.js";
import {
  computeCodexFileAccess,
  computeCodexSkillInvocations,
  mergeCodexFileAccess,
} from "./files-skills.js";
import { parseCodexTranscriptFile } from "./parser.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/codex/files-skills/rollout-2026-07-04T09-00-00-dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl",
);

async function loadFixture() {
  const transcript = await parseCodexTranscriptFile(FIXTURE);
  expect(transcript.format).toBe("current");
  return transcript;
}

describe("computeCodexFileAccess", () => {
  it("counts a deterministic apply_patch edit for every '*** Update/Add File:' header, including repeats across separate calls", async () => {
    const transcript = await loadFixture();
    const map = computeCodexFileAccess(transcript);

    const foo = map.get("/Users/test/files-skills-proj/src/foo.ts");
    expect(foo?.edits).toBe(2); // line 8 (Update) + line 10 (Update again)
    const newfile = map.get("/Users/test/files-skills-proj/src/newfile.ts");
    expect(newfile?.edits).toBe(1); // line 8's "Add File"
  });

  it("counts heuristic reads from recognized commands (cat/rg), resolving relative paths against the turn's cwd", async () => {
    const transcript = await loadFixture();
    const map = computeCodexFileAccess(transcript);

    const foo = map.get("/Users/test/files-skills-proj/src/foo.ts");
    expect(foo?.reads).toBe(2); // line 4 (workdir-qualified) + line 12 (bare, falls back to turn_context cwd)
    const bar = map.get("/Users/test/files-skills-proj/src/bar.ts");
    expect(bar?.reads).toBe(1); // line 6, "shell" with an array-form "command"
    expect(bar?.edits).toBe(0);
  });

  it("only counts 'sed' as a read when invoked with -n, never -i (edit-in-place)", async () => {
    const transcript = await loadFixture();
    const map = computeCodexFileAccess(transcript);

    const baz = map.get("/Users/test/files-skills-proj/src/baz.ts");
    expect(baz?.reads).toBe(1); // line 14 ("sed -n"); line 16 ("sed -i") must NOT count
    expect(baz?.edits).toBe(0); // apply_patch is the only edit signal — sed -i is never treated as one
  });

  it("ignores commands not on the recognized-read list, even with a path-looking argument (pytest)", async () => {
    const transcript = await loadFixture();
    const map = computeCodexFileAccess(transcript);
    // Line 18 runs "pytest src/foo.ts" — must not add a 3rd read to foo.ts.
    expect(map.get("/Users/test/files-skills-proj/src/foo.ts")?.reads).toBe(2);
  });

  it("skips a function_call whose arguments aren't valid JSON, without throwing", async () => {
    const transcript = await loadFixture();
    // Line 20 carries `"not valid json"` as arguments — computeCodexFileAccess
    // must tolerate it silently rather than crash the whole computation.
    expect(() => computeCodexFileAccess(transcript)).not.toThrow();
  });

  it("earliest touch (by line) sets firstLine/firstTimestamp, regardless of read vs edit", async () => {
    const transcript = await loadFixture();
    const map = computeCodexFileAccess(transcript);
    const foo = map.get("/Users/test/files-skills-proj/src/foo.ts");
    // foo.ts is first touched by the line-4 read, before the line-8 edit.
    expect(foo?.firstLine).toBe(4);
    expect(foo?.firstTimestamp).toBe("2026-07-04T09:00:03.000Z");
  });

  it("returns an empty map for a transcript with no tool calls at all", async () => {
    const map = computeCodexFileAccess({
      filePath: "synthetic",
      format: "current",
      records: [],
      warnings: [],
    });
    expect(map.size).toBe(0);
  });
});

describe("computeCodexSkillInvocations", () => {
  it("extracts every '[$plugin:skill](path)' marker from user_message text, in line order", async () => {
    const transcript = await loadFixture();
    const invocations = computeCodexSkillInvocations(transcript);

    expect(invocations).toEqual([
      {
        kind: "skill",
        name: "superpowers:brainstorming",
        line: 3,
        userTurn: 1,
        timestamp: "2026-07-04T09:00:02.000Z",
      },
      {
        kind: "skill",
        name: "foo-bar:baz-qux",
        line: 3,
        userTurn: 1,
        timestamp: "2026-07-04T09:00:02.000Z",
      },
      {
        kind: "skill",
        name: "superpowers:executing-plans",
        line: 22,
        userTurn: 2,
        timestamp: "2026-07-04T09:00:12.000Z",
      },
    ]);
  });

  it("returns an empty array for a transcript with no user_message events", async () => {
    const invocations = computeCodexSkillInvocations({
      filePath: "synthetic",
      format: "current",
      records: [],
      warnings: [],
    });
    expect(invocations).toEqual([]);
  });
});

describe("mergeCodexFileAccess", () => {
  const mainOnly: FileAccessEntry = {
    path: "/proj/main-only.ts",
    reads: 1,
    edits: 0,
    threads: "main",
  };
  const shared: FileAccessEntry = {
    path: "/proj/shared.ts",
    reads: 0,
    edits: 1,
    firstTouchTimestamp: "2026-01-01T00:00:00.000Z",
    firstTouchLine: 5,
    threads: "main",
  };
  const subOnly: FileAccessEntry = {
    path: "/proj/sub-only.ts",
    reads: 2,
    edits: 0,
    threads: "main", // "main" from the sub-agent's OWN perspective — recomputed once merged.
  };
  const sharedFromChild: FileAccessEntry = {
    path: "/proj/shared.ts",
    reads: 3,
    edits: 0,
    threads: "main",
  };

  it("keeps a main-only path tagged 'main'", () => {
    const { fileAccess } = mergeCodexFileAccess([mainOnly], []);
    expect(fileAccess).toEqual([{ ...mainOnly }]);
  });

  it("tags a path only a descendant touched as 'subagent', summing across multiple descendants", () => {
    const { fileAccess } = mergeCodexFileAccess([], [[subOnly], [subOnly]]);
    const entry = fileAccess.find((e) => e.path === "/proj/sub-only.ts");
    expect(entry).toMatchObject({ reads: 4, edits: 0, threads: "subagent" });
  });

  it("tags a path touched by both the session itself and a descendant as 'both', summing reads/edits", () => {
    const { fileAccess } = mergeCodexFileAccess([shared], [[sharedFromChild]]);
    const entry = fileAccess.find((e) => e.path === "/proj/shared.ts");
    expect(entry).toMatchObject({ reads: 3, edits: 1, threads: "both" });
    // firstTouchLine only ever comes from the main-side entry — matches
    // Claude's `mergeFileAccess` semantics exactly (see metrics.ts).
    expect(entry?.firstTouchLine).toBe(5);
  });

  it("returns entries sorted by path, main + subagents combined", () => {
    const { fileAccess } = mergeCodexFileAccess([mainOnly, shared], [[subOnly]]);
    expect(fileAccess.map((e) => e.path)).toEqual([
      "/proj/main-only.ts",
      "/proj/shared.ts",
      "/proj/sub-only.ts",
    ]);
  });
});
