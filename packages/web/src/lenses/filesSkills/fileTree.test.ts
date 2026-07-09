import { describe, expect, it } from "vitest";
import type { FileAccessEntryLike } from "./fileTree.js";
import { buildFileTreeRows, displayPath, shortSubject } from "./fileTree.js";

function entry(overrides: Partial<FileAccessEntryLike> & { path: string }): FileAccessEntryLike {
  return { reads: 0, edits: 0, threads: "main", ...overrides };
}

describe("displayPath", () => {
  it("strips a matching cwd prefix", () => {
    expect(displayPath("/Users/test/proj/src/index.ts", "/Users/test/proj")).toBe("src/index.ts");
  });

  it("leaves a path outside cwd (and outside the home guess) untouched", () => {
    expect(displayPath("/opt/other/file.ts", "/Users/test/proj")).toBe("/opt/other/file.ts");
  });

  it("shortens a home-directory path outside cwd to ~", () => {
    expect(displayPath("/Users/test/notes.md", "/Users/test/proj")).toBe("~/notes.md");
  });

  it("returns the raw path when cwd is unknown", () => {
    expect(displayPath("/a/b.ts", undefined)).toBe("/a/b.ts");
  });
});

describe("buildFileTreeRows", () => {
  it("groups files under directory header rows, sorted lexicographically", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/packages/core/src/parser.ts" }),
      entry({ path: "/proj/packages/core/src/index.ts" }),
      entry({ path: "/proj/README.md" }),
    ];
    const rows = buildFileTreeRows(entries, "/proj");
    expect(rows.map((r) => (r.kind === "dir" ? `dir:${r.label}` : `file:${r.label}`))).toEqual([
      "dir:packages/core/src/",
      "file:index.ts",
      "file:parser.ts",
      "file:README.md",
    ]);
  });

  it("emits each directory header exactly once when a subdirectory sorts between its parent's files", () => {
    // Full-display-path sorting would interleave `pricing/` between
    // `parser.ts` and `session-data.ts` and emit the parent header twice —
    // regression test for the duplicate React key bug.
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/src/parser.ts" }),
      entry({ path: "/proj/src/pricing/prices.json" }),
      entry({ path: "/proj/src/session-data.ts" }),
    ];
    const rows = buildFileTreeRows(entries, "/proj");
    expect(rows.map((r) => (r.kind === "dir" ? `dir:${r.label}` : `file:${r.label}`))).toEqual([
      "dir:src/",
      "file:parser.ts",
      "file:session-data.ts",
      "dir:src/pricing/",
      "file:prices.json",
    ]);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("indents file rows under a directory header but not root-level files", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/src/a.ts" }),
      entry({ path: "/proj/root.ts" }),
    ];
    const rows = buildFileTreeRows(entries, "/proj");
    const fileRows = rows.filter((r) => r.kind === "file");
    expect(fileRows.find((r) => r.label === "a.ts")?.indent).toBe(true);
    expect(fileRows.find((r) => r.label === "root.ts")?.indent).toBe(false);
  });
});

describe("shortSubject", () => {
  it("returns the basename for a path-like subject", () => {
    expect(shortSubject("/Users/test/proj/src/index.ts")).toBe("index.ts");
  });

  it("returns the first 40 chars for a non-path subject", () => {
    const long = "a".repeat(60);
    expect(shortSubject(long)).toBe("a".repeat(40));
  });
});
