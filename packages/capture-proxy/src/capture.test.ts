import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCapture,
  type CaptureEntry,
  captureFileName,
  detectIsSubagent,
  extractRequestId,
  extractSessionId,
  sanitizeSessionId,
  UNASSIGNED_FILENAME,
} from "./capture.js";

function makeEntry(overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    startedAt: "2026-07-18T00:00:00.000Z",
    endedAt: "2026-07-18T00:00:00.100Z",
    latencyMs: 100,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    sessionId: "sess-1",
    requestId: "req_1",
    isSubagent: false,
    requestHeaders: {},
    requestBody: null,
    requestBytes: 0,
    responseHeaders: {},
    contentType: "application/json",
    responseBody: null,
    assembledMessage: null,
    responseBytes: 0,
    ...overrides,
  };
}

describe("sanitizeSessionId", () => {
  it("keeps safe characters and rewrites the rest", () => {
    expect(sanitizeSessionId("abc-123_DEF.4")).toBe("abc-123_DEF.4");
    expect(sanitizeSessionId("a/b\\c:d e")).toBe("a_b_c_d_e");
  });

  it("rejects dot-run (path-traversal) shapes but keeps a slash-sanitized id", () => {
    expect(sanitizeSessionId("..")).toBeNull();
    expect(sanitizeSessionId(".")).toBeNull();
    expect(sanitizeSessionId("...")).toBeNull();
    expect(sanitizeSessionId("/")).toBe("_"); // slash → "_", a safe non-traversal segment
  });
});

describe("captureFileName", () => {
  it("uses <sessionId>.jsonl for a normal id", () => {
    expect(captureFileName("11111111-1111-1111-1111-111111111111")).toBe(
      "11111111-1111-1111-1111-111111111111.jsonl",
    );
  });

  it("falls back to _unassigned.jsonl for missing/empty/traversal ids", () => {
    expect(captureFileName(null)).toBe(UNASSIGNED_FILENAME);
    expect(captureFileName(undefined)).toBe(UNASSIGNED_FILENAME);
    expect(captureFileName("")).toBe(UNASSIGNED_FILENAME);
    expect(captureFileName("..")).toBe(UNASSIGNED_FILENAME);
  });
});

describe("join-key extraction", () => {
  it("reads the session id from x-claude-code-session-id", () => {
    expect(extractSessionId({ "x-claude-code-session-id": "sess-9" })).toBe("sess-9");
    expect(extractSessionId({})).toBeNull();
  });

  it("reads the request id from the response request-id header", () => {
    expect(extractRequestId({ "request-id": "req_42" })).toBe("req_42");
    expect(extractRequestId({})).toBeNull();
  });
});

describe("detectIsSubagent", () => {
  it("is true when the request body's system blocks carry cc_is_subagent=true", () => {
    const body = { system: [{ type: "text", text: "billing cc_is_subagent=true suffix" }] };
    expect(detectIsSubagent(body, {})).toBe(true);
  });

  it("is false for a main-loop request", () => {
    const body = { system: [{ type: "text", text: "billing cc_is_subagent=false" }] };
    expect(detectIsSubagent(body, {})).toBe(false);
    expect(detectIsSubagent({ system: "plain" }, {})).toBe(false);
  });

  it("falls back to the user-agent header", () => {
    expect(detectIsSubagent(null, { "user-agent": "claude cc_is_subagent=true" })).toBe(true);
  });
});

describe("appendCapture", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates the dir, writes one JSONL line to <sessionId>.jsonl", async () => {
    dir = await mkdtemp(join(tmpdir(), "junrei-capture-"));
    const filePath = await appendCapture(dir, makeEntry({ sessionId: "sess-x" }));
    expect(filePath).toBe(join(dir, "sess-x.jsonl"));
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text.trim()).sessionId).toBe("sess-x");
  });

  it("routes a null session id to _unassigned.jsonl", async () => {
    dir = await mkdtemp(join(tmpdir(), "junrei-capture-"));
    const filePath = await appendCapture(dir, makeEntry({ sessionId: null }));
    expect(filePath).toBe(join(dir, UNASSIGNED_FILENAME));
  });
});
