import { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createS3ClaudeSessionStore,
  DEFAULT_LIST_TTL_MS,
  parseS3SourceUri,
  resolveS3StoreConfigFromEnv,
} from "./s3-store.js";

/** One `Contents[]` entry shape as returned by a real `ListObjectsV2` call. */
interface FakeObject {
  Key: string;
  Size?: number;
  LastModified?: Date;
  ETag?: string;
}

/**
 * A minimal S3Client fake — `send` inspects the command's constructor
 * (`instanceof`) the same way real integration code never needs to, but a
 * unit test mocking the SDK at the `send` level does (see the feature's test
 * plan: "mock at the S3Client send level"). `pages` feeds successive
 * `ListObjectsV2` calls (one array per page); `getObjectBody` answers
 * `GetObjectCommand` by key.
 */
function fakeClient(
  pages: readonly FakeObject[][],
  opts: { getObjectBody?: (key: string) => string } = {},
): { client: S3Client; send: ReturnType<typeof vi.fn> } {
  let pageIndex = 0;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const contents = pages[pageIndex] ?? [];
      const isLastPage = pageIndex >= pages.length - 1;
      pageIndex += 1;
      return {
        Contents: contents,
        IsTruncated: !isLastPage,
        ...(!isLastPage && { NextContinuationToken: `token-${pageIndex}` }),
      };
    }
    if (command instanceof GetObjectCommand) {
      const key = (command.input as { Key?: string }).Key ?? "";
      const text = opts.getObjectBody?.(key) ?? "";
      // The real SDK's `Body` is a Node `Readable` with helper methods (like
      // `transformToString`) mixed in — so `openLines` (which needs a real
      // `Readable` to hand to `node:readline`) and `readFile` (which just
      // calls `transformToString`) both work against this fake the same way
      // they would against the real SDK.
      const body = Object.assign(Readable.from([text]), {
        transformToString: async () => text,
      });
      return { Body: body };
    }
    throw new Error(`unexpected command: ${String(command)}`);
  });
  return { client: { send } as unknown as S3Client, send };
}

const BUCKET = "my-bucket";
const PREFIX = "agentcore/";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_DIR = "-Users-test-proj";
const MAIN_KEY = `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}.jsonl`;

describe("parseS3SourceUri", () => {
  it("parses bucket + prefix, adding a trailing slash when missing", () => {
    expect(parseS3SourceUri("s3://my-bucket/agentcore/")).toEqual({
      bucket: "my-bucket",
      prefix: "agentcore/",
    });
    expect(parseS3SourceUri("s3://my-bucket/agentcore")).toEqual({
      bucket: "my-bucket",
      prefix: "agentcore/",
    });
  });

  it("allows an empty prefix (bucket alone, with or without trailing slash)", () => {
    expect(parseS3SourceUri("s3://my-bucket")).toEqual({ bucket: "my-bucket", prefix: "" });
    expect(parseS3SourceUri("s3://my-bucket/")).toEqual({ bucket: "my-bucket", prefix: "" });
  });

  it("returns undefined for a non-s3 URI", () => {
    expect(parseS3SourceUri("https://example.com/bucket")).toBeUndefined();
    expect(parseS3SourceUri("not a uri at all")).toBeUndefined();
  });
});

describe("resolveS3StoreConfigFromEnv", () => {
  it("returns undefined when JUNREI_S3_SOURCE_URI is unset or empty", () => {
    expect(resolveS3StoreConfigFromEnv({})).toBeUndefined();
    expect(resolveS3StoreConfigFromEnv({ JUNREI_S3_SOURCE_URI: "" })).toBeUndefined();
  });

  it("resolves bucket/prefix/endpoint/listTtlMs from env", () => {
    const config = resolveS3StoreConfigFromEnv({
      JUNREI_S3_SOURCE_URI: "s3://my-bucket/agentcore/",
      JUNREI_S3_ENDPOINT: "http://localhost:4566",
      JUNREI_S3_LIST_TTL_MS: "5000",
    });
    expect(config).toEqual({
      bucket: "my-bucket",
      prefix: "agentcore/",
      endpoint: "http://localhost:4566",
      listTtlMs: 5000,
    });
  });

  it("omits endpoint/listTtlMs when not set, rather than including them as undefined", () => {
    const config = resolveS3StoreConfigFromEnv({ JUNREI_S3_SOURCE_URI: "s3://my-bucket/" });
    expect(config).toEqual({ bucket: "my-bucket", prefix: "" });
  });

  it("logs an error and returns undefined for a malformed URI, rather than throwing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(resolveS3StoreConfigFromEnv({ JUNREI_S3_SOURCE_URI: "not-a-uri" })).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});

describe("createS3ClaudeSessionStore — key structure derivation", () => {
  it("derives main transcript vs. subagent vs. workflow-run sidecars, including the nested workflow layout", async () => {
    const { client } = fakeClient([
      [
        {
          Key: MAIN_KEY,
          Size: 1000,
          LastModified: new Date("2026-01-01T00:00:00Z"),
          ETag: '"main"',
        },
        {
          Key: `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/agent-aaa.jsonl`,
          Size: 100,
          LastModified: new Date("2026-01-01T00:01:00Z"),
        },
        {
          Key: `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/agent-aaa.meta.json`,
          Size: 20,
          LastModified: new Date("2026-01-01T00:01:05Z"),
        },
        {
          Key: `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/workflows/wf_run1/agent-bbb.jsonl`,
          Size: 200,
          LastModified: new Date("2026-01-01T00:02:00Z"),
        },
        {
          Key: `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/workflows/wf_run1.json`,
          Size: 300,
          LastModified: new Date("2026-01-01T00:03:00Z"),
        },
      ],
    ]);
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });

    const refs = await store.listSessionFiles();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sessionId: SESSION_ID,
      projectDirName: PROJECT_DIR,
      filePath: `s3://${BUCKET}/${MAIN_KEY}`,
      changeToken: '"main"',
      sizeBytes: 1000,
    });

    const byId = await store.findSessionFileById(SESSION_ID);
    expect(byId?.filePath).toBe(`s3://${BUCKET}/${MAIN_KEY}`);

    const sidecars = await store.listSidecarFiles(refs[0]?.filePath ?? "");
    expect(sidecars.map((s) => s.path).sort()).toEqual(
      [
        `s3://${BUCKET}/${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/agent-aaa.jsonl`,
        `s3://${BUCKET}/${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/agent-aaa.meta.json`,
        `s3://${BUCKET}/${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/workflows/wf_run1/agent-bbb.jsonl`,
        `s3://${BUCKET}/${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/workflows/wf_run1.json`,
      ].sort(),
    );
  });

  it("ignores keys with path traversal or an unexpected structure, logging a warning for each", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient([
      [
        { Key: `${PREFIX}projects/../escape.jsonl`, Size: 1, LastModified: new Date() },
        { Key: `${PREFIX}projects/dir-with-no-session-segment`, Size: 1, LastModified: new Date() },
        { Key: MAIN_KEY, Size: 1, LastModified: new Date(), ETag: '"main"' },
      ],
    ]);
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });

    const refs = await store.listSessionFiles();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sessionId).toBe(SESSION_ID);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("skips zero-byte folder-marker keys (ending in /) silently, without warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient([
      [
        { Key: `${PREFIX}projects/`, Size: 0, LastModified: new Date() },
        { Key: `${PREFIX}projects/${PROJECT_DIR}/`, Size: 0, LastModified: new Date() },
        {
          Key: `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/`,
          Size: 0,
          LastModified: new Date(),
        },
        { Key: MAIN_KEY, Size: 1, LastModified: new Date(), ETag: '"main"' },
      ],
    ]);
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });

    const refs = await store.listSessionFiles();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sessionId).toBe(SESSION_ID);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("createS3ClaudeSessionStore — pagination", () => {
  it("paginates ListObjectsV2 across multiple pages and merges every entry", async () => {
    const secondSessionId = "22222222-2222-2222-2222-222222222222";
    const { client, send } = fakeClient([
      [{ Key: MAIN_KEY, Size: 1, LastModified: new Date(), ETag: '"a"' }],
      [
        {
          Key: `${PREFIX}projects/${PROJECT_DIR}/${secondSessionId}.jsonl`,
          Size: 2,
          LastModified: new Date(),
          ETag: '"b"',
        },
      ],
    ]);
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });

    const refs = await store.listSessionFiles();
    expect(refs.map((r) => r.sessionId).sort()).toEqual([SESSION_ID, secondSessionId].sort());
    expect(send).toHaveBeenCalledTimes(2);

    const secondCall = send.mock.calls[1]?.[0] as ListObjectsV2Command;
    expect(secondCall.input.ContinuationToken).toBe("token-1");
    const firstCall = send.mock.calls[0]?.[0] as ListObjectsV2Command;
    expect(firstCall.input.ContinuationToken).toBeUndefined();
  });
});

describe("createS3ClaudeSessionStore — change token (ETag-based cache invalidation)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the object's ETag as the change token, reflecting a new ETag after the sweep refreshes", async () => {
    vi.useFakeTimers();
    let etag = '"v1"';
    const send = vi.fn(async () => ({
      Contents: [{ Key: MAIN_KEY, Size: 10, LastModified: new Date(), ETag: etag }],
      IsTruncated: false,
    }));
    const client = { send } as unknown as S3Client;
    const store = createS3ClaudeSessionStore({
      bucket: BUCKET,
      prefix: PREFIX,
      client,
      listTtlMs: 1000,
    });

    const first = await store.listSessionFiles();
    expect(first[0]?.changeToken).toBe('"v1"');

    etag = '"v2"';
    vi.advanceTimersByTime(1001);
    const second = await store.listSessionFiles();
    expect(second[0]?.changeToken).toBe('"v2"');
  });

  it("falls back to LastModified+Size as an opaque change token when the backend returns no ETag", async () => {
    const lastModified = new Date("2026-01-01T00:00:00Z");
    const { client } = fakeClient([[{ Key: MAIN_KEY, Size: 42, LastModified: lastModified }]]);
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });

    const refs = await store.listSessionFiles();
    expect(refs[0]?.changeToken).toBe(`${lastModified.getTime()}:42`);
  });
});

describe("createS3ClaudeSessionStore — listing TTL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches the LIST sweep for listTtlMs, issuing a fresh LIST only once it elapses", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ Contents: [], IsTruncated: false }));
    const client = { send } as unknown as S3Client;
    const store = createS3ClaudeSessionStore({
      bucket: BUCKET,
      prefix: PREFIX,
      client,
      listTtlMs: 5000,
    });

    await store.listSessionFiles();
    await store.listSessionFiles();
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5001);
    await store.listSessionFiles();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("defaults to DEFAULT_LIST_TTL_MS when listTtlMs isn't given", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ Contents: [], IsTruncated: false }));
    const client = { send } as unknown as S3Client;
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });

    await store.listSessionFiles();
    vi.advanceTimersByTime(DEFAULT_LIST_TTL_MS - 1);
    await store.listSessionFiles();
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await store.listSessionFiles();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("createS3ClaudeSessionStore — size-decrease warning", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a warning when an object's size decreases versus the previously seen listing", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let size = 1000;
    const send = vi.fn(async () => ({
      Contents: [{ Key: MAIN_KEY, Size: size, LastModified: new Date(), ETag: '"e"' }],
      IsTruncated: false,
    }));
    const client = { send } as unknown as S3Client;
    const store = createS3ClaudeSessionStore({
      bucket: BUCKET,
      prefix: PREFIX,
      client,
      listTtlMs: 100,
    });

    await store.listSessionFiles();
    expect(warnSpy).not.toHaveBeenCalled();

    size = 500;
    vi.advanceTimersByTime(101);
    await store.listSessionFiles();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("size decreased"));

    warnSpy.mockRestore();
  });

  it("does not warn when size stays the same or grows", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let size = 1000;
    const send = vi.fn(async () => ({
      Contents: [{ Key: MAIN_KEY, Size: size, LastModified: new Date(), ETag: '"e"' }],
      IsTruncated: false,
    }));
    const client = { send } as unknown as S3Client;
    const store = createS3ClaudeSessionStore({
      bucket: BUCKET,
      prefix: PREFIX,
      client,
      listTtlMs: 100,
    });

    await store.listSessionFiles();
    size = 2000;
    vi.advanceTimersByTime(101);
    await store.listSessionFiles();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("createS3ClaudeSessionStore — reading file contents", () => {
  it("reads a whole small file via readFile", async () => {
    const metaKey = `${PREFIX}projects/${PROJECT_DIR}/${SESSION_ID}/subagents/agent-aaa.meta.json`;
    const { client } = fakeClient([[]], {
      getObjectBody: (key) => (key === metaKey ? '{"agentType":"Explore"}' : ""),
    });
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });
    const content = await store.readFile(`s3://${BUCKET}/${metaKey}`);
    expect(JSON.parse(content)).toEqual({ agentType: "Explore" });
  });

  it("streams a transcript's lines via openLines, dropping only the final trailing empty line", async () => {
    const { client } = fakeClient([[]], {
      getObjectBody: (key) => (key === MAIN_KEY ? '{"a":1}\n{"b":2}\n' : ""),
    });
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, client });
    const lines: string[] = [];
    for await (const line of store.openLines(`s3://${BUCKET}/${MAIN_KEY}`)) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
