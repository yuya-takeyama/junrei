import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSessionStore } from "@junrei/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedRecord,
  capturedByteSizes,
  createFilesystemCaptureStore,
  extractResponseMeta,
  findCapturedRequest,
  resolveCapturesDir,
} from "./captures.js";

/** Minimal in-memory Claude session store for the logged-requestId join test. */
function fakeSessionStore(
  files: Record<string, string[]>,
  sidecars: string[] = [],
): ClaudeSessionStore {
  return {
    async listSessionFiles() {
      return [];
    },
    async findSessionFileById(sessionId: string) {
      const filePath = `main:${sessionId}`;
      if (!(filePath in files)) return undefined;
      return {
        sessionId,
        filePath,
        projectDirName: "proj",
        mtimeMs: 0,
        birthtimeMs: 0,
        sizeBytes: 0,
        changeToken: "0",
      };
    },
    async *openLines(filePath: string) {
      for (const line of files[filePath] ?? []) yield line;
    },
    async readFile() {
      return "";
    },
    async listSidecarFiles() {
      return sidecars.map((path) => ({ path, mtimeMs: 0, sizeBytes: 0, changeToken: "0" }));
    },
  };
}

describe("resolveCapturesDir", () => {
  it("prefers JUNREI_CAPTURES_DIR, falls back to ~/.junrei/captures", () => {
    expect(resolveCapturesDir({ JUNREI_CAPTURES_DIR: "/tmp/caps" })).toBe("/tmp/caps");
    expect(resolveCapturesDir({}).endsWith(join(".junrei", "captures"))).toBe(true);
  });
});

describe("readSessionCaptures", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("declares captures-dir-missing when the dir does not exist", async () => {
    const store = createFilesystemCaptureStore({ capturesDir: "/no/such/captures/dir/at/all" });
    expect(await store.readSessionCaptures("s1")).toEqual({
      available: false,
      reason: "captures-dir-missing",
    });
  });

  it("declares session-not-captured when the dir exists but the session file does not", async () => {
    dir = await mkdtemp(join(tmpdir(), "junrei-caps-"));
    const store = createFilesystemCaptureStore({ capturesDir: dir });
    expect(await store.readSessionCaptures("s1")).toEqual({
      available: false,
      reason: "session-not-captured",
    });
  });

  it("parses the session's JSONL, tolerating a torn/malformed line", async () => {
    dir = await mkdtemp(join(tmpdir(), "junrei-caps-"));
    await writeFile(
      join(dir, "s1.jsonl"),
      `${JSON.stringify({ requestId: "r1", status: 200 })}\n` +
        "{ this is not json\n" +
        `${JSON.stringify({ requestId: "r2", status: 429 })}\n`,
    );
    const store = createFilesystemCaptureStore({ capturesDir: dir });
    const result = await store.readSessionCaptures("s1");
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.records.map((r) => r.requestId)).toEqual(["r1", "r2"]);
    }
  });
});

describe("collectLoggedRequestIds", () => {
  it("gathers requestIds from the main transcript and sidecars", async () => {
    const sessionStore = fakeSessionStore(
      {
        "main:sess": [
          JSON.stringify({ type: "assistant", requestId: "req_1" }),
          "not-json",
          JSON.stringify({ type: "assistant", requestId: "req_2" }),
        ],
        "sidecar-a.jsonl": [JSON.stringify({ requestId: "req_sa1" })],
      },
      ["sidecar-a.jsonl", "sidecar-b.meta.json"],
    );
    const store = createFilesystemCaptureStore({ capturesDir: "/unused", sessionStore });
    const ids = await store.collectLoggedRequestIds("sess");
    expect(ids).toEqual(new Set(["req_1", "req_2", "req_sa1"]));
  });

  it("returns undefined when the session is not found in the log", async () => {
    const store = createFilesystemCaptureStore({
      capturesDir: "/unused",
      sessionStore: fakeSessionStore({}),
    });
    expect(await store.collectLoggedRequestIds("missing")).toBeUndefined();
  });
});

describe("record helpers", () => {
  const sseRecord: CapturedRecord = {
    requestId: "r1",
    status: 200,
    assembledMessage: { model: "claude-fable-5", usage: { output_tokens: 7 } },
    requestBytes: 120,
    responseBytes: 640,
  };
  const jsonRecord: CapturedRecord = {
    requestId: "r2",
    status: 200,
    responseBody: { model: "claude-haiku", usage: { output_tokens: 2 } },
  };

  it("findCapturedRequest matches on requestId", () => {
    expect(findCapturedRequest([sseRecord, jsonRecord], "r2")).toBe(jsonRecord);
    expect(findCapturedRequest([sseRecord], "nope")).toBeUndefined();
  });

  it("extractResponseMeta reads model/usage from the SSE message, else the JSON body", () => {
    expect(extractResponseMeta(sseRecord)).toEqual({
      status: 200,
      model: "claude-fable-5",
      usage: { output_tokens: 7 },
    });
    expect(extractResponseMeta(jsonRecord)).toEqual({
      status: 200,
      model: "claude-haiku",
      usage: { output_tokens: 2 },
    });
  });

  it("capturedByteSizes defaults missing sizes to 0", () => {
    expect(capturedByteSizes(sseRecord)).toEqual({ requestBytes: 120, responseBytes: 640 });
    expect(capturedByteSizes(jsonRecord)).toEqual({ requestBytes: 0, responseBytes: 0 });
  });
});
