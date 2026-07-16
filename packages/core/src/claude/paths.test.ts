import { describe, expect, it } from "vitest";
import { joinPath, subagentsDirFor, workflowsDirFor } from "./paths.js";

describe("joinPath", () => {
  it("joins ordinary absolute local path segments like node:path's join", () => {
    expect(joinPath("/Users/test/proj", "sessionId", "subagents")).toBe(
      "/Users/test/proj/sessionId/subagents",
    );
  });

  it("does NOT collapse the s3:// scheme separator — unlike node:path's join", () => {
    // This is the whole reason this function exists: `path.join("s3://bucket/x",
    // "y")` folds the repeated "//" after "s3:" down to a single slash,
    // corrupting the URI ("s3:/bucket/x/y"). joinPath must leave it intact.
    expect(joinPath("s3://bucket/prefix/projects/dir/sessionId", "subagents")).toBe(
      "s3://bucket/prefix/projects/dir/sessionId/subagents",
    );
  });

  it("trims boundary slashes between segments without touching interior slashes", () => {
    // A trailing slash on the LAST segment is preserved (matches node:path's
    // own `join` behavior) — only the boundary BETWEEN segments is trimmed.
    expect(joinPath("s3://bucket/prefix/", "/subagents/")).toBe("s3://bucket/prefix/subagents/");
  });

  it("drops empty segments", () => {
    expect(joinPath("s3://bucket", "", "key")).toBe("s3://bucket/key");
  });
});

describe("subagentsDirFor / workflowsDirFor", () => {
  it("derive sidecar dirs for a local absolute path", () => {
    const mainFilePath = "/Users/test/proj/11111111-1111-1111-1111-111111111111.jsonl";
    expect(subagentsDirFor(mainFilePath)).toBe(
      "/Users/test/proj/11111111-1111-1111-1111-111111111111/subagents",
    );
    expect(workflowsDirFor(mainFilePath)).toBe(
      "/Users/test/proj/11111111-1111-1111-1111-111111111111/workflows",
    );
  });

  it("derive sidecar dirs for an s3:// store-scoped URI without corrupting the scheme", () => {
    const mainFilePath =
      "s3://my-bucket/agentcore/projects/-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl";
    expect(subagentsDirFor(mainFilePath)).toBe(
      "s3://my-bucket/agentcore/projects/-Users-test-proj/11111111-1111-1111-1111-111111111111/subagents",
    );
    expect(workflowsDirFor(mainFilePath)).toBe(
      "s3://my-bucket/agentcore/projects/-Users-test-proj/11111111-1111-1111-1111-111111111111/workflows",
    );
  });
});
