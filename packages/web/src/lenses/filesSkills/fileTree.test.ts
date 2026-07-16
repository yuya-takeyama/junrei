import { describe, expect, it } from "vitest";
import {
  buildFileScopeSections,
  buildScopeFileTree,
  type FileAccessEntryLike,
  type FileTreeDirRow,
  type FileTreeFileRow,
  flattenSections,
  rootHintFor,
  scopeOf,
  shortSubject,
} from "./fileTree.js";

function entry(overrides: Partial<FileAccessEntryLike> & { path: string }): FileAccessEntryLike {
  return { reads: 0, edits: 0, threads: "main", ...overrides };
}

describe("scopeOf", () => {
  it("classifies a path under cwd as repo", () => {
    expect(scopeOf("/Users/test/proj/src/a.ts", "/Users/test/proj", undefined)).toBe("repo");
    expect(scopeOf("/Users/test/proj", "/Users/test/proj", undefined)).toBe("repo");
  });

  it("classifies a home-prefixed path outside cwd as home", () => {
    expect(scopeOf("/Users/test/notes.md", "/Users/test/proj", "/Users/test")).toBe("home");
  });

  it("classifies everything else as system", () => {
    expect(scopeOf("/opt/other/file.ts", "/Users/test/proj", "/Users/test")).toBe("system");
    expect(scopeOf("/a/b.ts", undefined, undefined)).toBe("system");
  });

  it("prefers repo over home when cwd is itself nested under the home prefix", () => {
    const cwd = "/Users/test/proj";
    const home = "/Users/test";
    // A repo file is also technically under `home` — repo must win, or it'd
    // double-count into the Home section too.
    expect(scopeOf("/Users/test/proj/src/a.ts", cwd, home)).toBe("repo");
    // A real home file (outside the repo) still lands in Home.
    expect(scopeOf("/Users/test/other.txt", cwd, home)).toBe("home");
  });
});

describe("rootHintFor", () => {
  it("shortens cwd to its last two segments for repo", () => {
    expect(rootHintFor("repo", "/Users/yuya/src/github.com/yuya-takeyama/junrei")).toBe(
      "yuya-takeyama/junrei",
    );
  });

  it("uses a fixed hint for home and system", () => {
    expect(rootHintFor("home", undefined)).toBe("~");
    expect(rootHintFor("system", undefined)).toBe("/");
  });
});

describe("buildFileScopeSections", () => {
  it("splits entries into repo / home / system sections, in that order", () => {
    const cwd = "/Users/test/proj";
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/Users/test/proj/src/index.ts" }),
      entry({ path: "/Users/test/notes.md" }),
      entry({ path: "/opt/other/file.ts" }),
    ];
    const sections = buildFileScopeSections(entries, cwd, "");
    expect(sections.map((s) => s.scope)).toEqual(["repo", "home", "system"]);
    expect(sections.map((s) => s.label)).toEqual(["Repository", "Home", "System"]);
    expect(sections.map((s) => s.fileCount)).toEqual([1, 1, 1]);
  });

  it("omits sections with no entries", () => {
    const sections = buildFileScopeSections([entry({ path: "/proj/a.ts" })], "/proj", "");
    expect(sections.map((s) => s.scope)).toEqual(["repo"]);
  });
});

describe("buildScopeFileTree — compression", () => {
  it("compresses a single-child directory chain into one row", () => {
    const entries: FileAccessEntryLike[] = [entry({ path: "/proj/a/b/c/file.ts" })];
    const nodes = buildScopeFileTree(entries, entries, "repo", "/proj", undefined);
    expect(nodes).toHaveLength(1);
    const dir = nodes[0] as FileTreeDirRow;
    expect(dir.kind).toBe("dir");
    expect(dir.label).toBe("a/b/c/");
    expect(dir.depth).toBe(0);
    expect(dir.children).toHaveLength(1);
    const file = dir.children[0] as FileTreeFileRow;
    expect(file.kind).toBe("file");
    expect(file.name).toBe("file.ts");
    expect(file.depth).toBe(1);
  });

  it("stops compressing at a directory that has files of its own", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/a/b/c/file.ts" }),
      entry({ path: "/proj/a/other.ts" }),
    ];
    const nodes = buildScopeFileTree(entries, entries, "repo", "/proj", undefined);
    // "a" has a file of its own (other.ts), so it can't fold into "b" —
    // stays its own row; the chain compression resumes one level down.
    expect(nodes).toHaveLength(1);
    const aNode = nodes[0] as FileTreeDirRow;
    expect(aNode.label).toBe("a/");
    expect(aNode.children.map((c) => (c.kind === "dir" ? c.label : c.name))).toEqual([
      "b/c/",
      "other.ts",
    ]);
    const bcNode = aNode.children.find((c) => c.kind === "dir") as FileTreeDirRow;
    expect(bcNode.depth).toBe(1);
    expect(bcNode.children).toHaveLength(1);
    expect((bcNode.children[0] as FileTreeFileRow).name).toBe("file.ts");
  });
});

describe("buildScopeFileTree — aggregation", () => {
  it("sums reads/edits over every descendant file, recursively up a compressed chain", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/a/b/x.ts", reads: 2, edits: 1 }),
      entry({ path: "/proj/a/b/y.ts", reads: 3, edits: 0 }),
    ];
    const nodes = buildScopeFileTree(entries, entries, "repo", "/proj", undefined);
    const dir = nodes[0] as FileTreeDirRow;
    expect(dir.label).toBe("a/b/");
    expect(dir.reads).toBe(5);
    expect(dir.edits).toBe(1);
  });
});

describe("buildScopeFileTree — sort order", () => {
  it("sorts directory rows before file rows, each lexicographically", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/zeta.ts" }),
      entry({ path: "/proj/alpha/file.ts" }),
      entry({ path: "/proj/beta.ts" }),
    ];
    const nodes = buildScopeFileTree(entries, entries, "repo", "/proj", undefined);
    expect(nodes.map((n) => (n.kind === "dir" ? n.label : n.name))).toEqual([
      "alpha/",
      "beta.ts",
      "zeta.ts",
    ]);
  });
});

describe("buildScopeFileTree — isDirectory proof", () => {
  it("flags an entry as a directory when another entry's path lies beneath it", () => {
    // The corp-dev case: rg took the directory as its search root, and files
    // under it were also read individually — the co-listed children prove
    // the entry is a directory.
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/terraform/aws/corp-dev", reads: 6 }),
      entry({ path: "/proj/terraform/aws/corp-dev/jobs-site/dns.tf", reads: 1 }),
    ];
    const nodes = buildScopeFileTree(entries, entries, "repo", "/proj", undefined);
    const awsNode = nodes[0] as FileTreeDirRow;
    expect(awsNode.label).toBe("terraform/aws/");
    const fileRow = awsNode.children.find((c) => c.kind === "file") as FileTreeFileRow;
    expect(fileRow.name).toBe("corp-dev");
    expect(fileRow.isDirectory).toBe(true);
    const dirRow = awsNode.children.find((c) => c.kind === "dir") as FileTreeDirRow;
    expect(dirRow.label).toBe("corp-dev/jobs-site/");
  });

  it("does not flag a sibling that merely shares a string prefix (src/foo vs src/foobar.ts)", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/src/foo", reads: 1 }),
      entry({ path: "/proj/src/foobar.ts", reads: 1 }),
    ];
    const nodes = buildScopeFileTree(entries, entries, "repo", "/proj", undefined);
    const srcNode = nodes[0] as FileTreeDirRow;
    const files = srcNode.children as FileTreeFileRow[];
    expect(files.find((f) => f.name === "foo")?.isDirectory).toBe(false);
    expect(files.find((f) => f.name === "foobar.ts")?.isDirectory).toBe(false);
  });
});

describe("buildFileScopeSections — fuzzy filter pruning", () => {
  it("rebuilds the tree from only the matching files, aggregates narrowed to the matched set", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/src/index.ts", reads: 2 }),
      entry({ path: "/proj/src/util.ts", reads: 5 }),
      entry({ path: "/proj/README.md", reads: 1 }),
    ];
    // "ind" is a subsequence of "src/index.ts" (via index.ts) but not of
    // "src/util.ts" (no "n") or "README.md" (no "i").
    const sections = buildFileScopeSections(entries, "/proj", "ind");
    expect(sections).toHaveLength(1);
    const repo = sections[0];
    if (repo === undefined) throw new Error("expected a repo section");
    expect(repo.fileCount).toBe(1);
    expect(repo.nodes).toHaveLength(1);
    const dir = repo.nodes[0] as FileTreeDirRow;
    expect(dir.label).toBe("src/");
    expect(dir.reads).toBe(2);
    expect(dir.children).toHaveLength(1);
    const file = dir.children[0] as FileTreeFileRow;
    expect(file.name).toBe("index.ts");
    expect(file.matchedIndices).toBeDefined();
  });

  it("omits a section entirely when nothing in it matches", () => {
    const entries: FileAccessEntryLike[] = [entry({ path: "/proj/README.md" })];
    expect(buildFileScopeSections(entries, "/proj", "zzz")).toEqual([]);
  });
});

describe("flattenSections", () => {
  it("hides a collapsed directory's descendants", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/src/a.ts" }),
      entry({ path: "/proj/src/b.ts" }),
    ];
    const sections = buildFileScopeSections(entries, "/proj", "");
    const dirNode = sections[0]?.nodes[0] as FileTreeDirRow;
    const rows = flattenSections(sections, new Set([dirNode.key]), false);
    expect(rows.map((r) => r.kind)).toEqual(["section", "dir"]);
  });

  it("force-expands every directory while filtering, regardless of collapsed state", () => {
    const entries: FileAccessEntryLike[] = [
      entry({ path: "/proj/src/a.ts" }),
      entry({ path: "/proj/src/b.ts" }),
    ];
    const sections = buildFileScopeSections(entries, "/proj", "");
    const dirNode = sections[0]?.nodes[0] as FileTreeDirRow;
    const rows = flattenSections(sections, new Set([dirNode.key]), true);
    expect(rows.map((r) => r.kind)).toEqual(["section", "dir", "file", "file"]);
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
