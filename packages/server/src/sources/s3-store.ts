/**
 * S3-backed `ClaudeSessionStore` (see `@junrei/core`'s `claude/store.ts`) — a
 * remote Agent SDK environment (AWS AgentCore Runtime) uploads session
 * transcripts to S3 mirroring the local `~/.claude/projects/` layout:
 *
 *   s3://<bucket>/<prefix>/projects/<encoded-cwd>/<sessionId>.jsonl
 *   s3://<bucket>/<prefix>/projects/<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl(+.meta.json)
 *   s3://<bucket>/<prefix>/projects/<encoded-cwd>/<sessionId>/subagents/workflows/<runId>/...
 *   s3://<bucket>/<prefix>/projects/<encoded-cwd>/<sessionId>/workflows/<runId>.json
 *
 * The AWS SDK lives ONLY in `@junrei/server` (never `@junrei/core`, which
 * `@junrei/web` bundles via vite) — this is the one file in the repo that
 * imports `@aws-sdk/client-s3`.
 *
 * One paginated `ListObjectsV2` sweep under `<prefix>projects/` answers every
 * discovery query (`listSessionFiles`/`findSessionFileById`/
 * `listSidecarFiles`) — cached with a TTL (`JUNREI_S3_LIST_TTL_MS`, default
 * `DEFAULT_LIST_TTL_MS`) so a burst of UI requests doesn't hammer LIST, with
 * in-flight de-duplication so concurrent callers during a refresh share one
 * request rather than issuing their own.
 */

import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { ClaudeSessionFileRef, ClaudeSessionStore, ClaudeSidecarFileRef } from "@junrei/core";

export interface S3StoreConfig {
  bucket: string;
  /** Normalized: `""` or ends with `/`. See `parseS3SourceUri`. */
  prefix: string;
  /** Sets the SDK's `endpoint` + `forcePathStyle: true` (MinIO/localstack/kumo). */
  endpoint?: string;
  /** Milliseconds; defaults to `DEFAULT_LIST_TTL_MS`. */
  listTtlMs?: number;
  /** Test-only: inject a client instead of constructing one from `endpoint`. */
  client?: S3Client;
}

export const DEFAULT_LIST_TTL_MS = 10_000;

/**
 * Parse `s3://bucket/` or `s3://bucket/prefix/` (trailing slash optional,
 * empty prefix OK). `undefined` for anything not shaped like an S3 URI.
 */
export function parseS3SourceUri(uri: string): { bucket: string; prefix: string } | undefined {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri.trim());
  if (match === null) return undefined;
  const bucket = match[1];
  if (bucket === undefined || bucket === "") return undefined;
  let prefix = match[2] ?? "";
  if (prefix !== "" && !prefix.endsWith("/")) prefix = `${prefix}/`;
  return { bucket, prefix };
}

/**
 * Resolve `S3StoreConfig` from `JUNREI_S3_SOURCE_URI` / `JUNREI_S3_ENDPOINT` /
 * `JUNREI_S3_LIST_TTL_MS`. `undefined` when `JUNREI_S3_SOURCE_URI` is unset or
 * empty (the feature is off) or isn't a parseable `s3://` URI (logged, feature
 * disabled rather than crashing server startup).
 */
export function resolveS3StoreConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3StoreConfig | undefined {
  const uri = env.JUNREI_S3_SOURCE_URI;
  if (uri === undefined || uri.trim() === "") return undefined;

  const parsed = parseS3SourceUri(uri);
  if (parsed === undefined) {
    console.error(`[junrei][s3-store] JUNREI_S3_SOURCE_URI is not a valid s3:// URI: ${uri}`);
    return undefined;
  }

  const endpoint = env.JUNREI_S3_ENDPOINT;
  const listTtlMsRaw = env.JUNREI_S3_LIST_TTL_MS;
  const listTtlMs =
    listTtlMsRaw !== undefined && listTtlMsRaw !== "" && Number.isFinite(Number(listTtlMsRaw))
      ? Number(listTtlMsRaw)
      : undefined;

  return {
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    ...(endpoint !== undefined && endpoint !== "" && { endpoint }),
    ...(listTtlMs !== undefined && { listTtlMs }),
  };
}

type SidecarKind = "main" | "sidecar";

interface ParsedKey {
  projectDirName: string;
  sessionId: string;
  kind: SidecarKind;
}

/**
 * Derive `{projectDirName, sessionId, kind}` from a key already known to start
 * with `<prefix>projects/` (the sweep's own `Prefix` guarantees this).
 * `undefined` for path traversal (`.`/`..`/empty segments) or a key shape
 * that doesn't match `<dir>/<sessionId>.jsonl` (main) or
 * `<dir>/<sessionId>/...` (sidecar, at least one segment past the session id).
 */
function parseObjectKey(key: string, projectsPrefix: string): ParsedKey | undefined {
  const rest = key.slice(projectsPrefix.length);
  const parts = rest.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  const projectDirName = parts[0];
  const second = parts[1];
  if (projectDirName === undefined || second === undefined) return undefined;
  if (parts.length === 2 && second.endsWith(".jsonl")) {
    return { projectDirName, sessionId: second.slice(0, -".jsonl".length), kind: "main" };
  }
  if (parts.length >= 3) {
    return { projectDirName, sessionId: second, kind: "sidecar" };
  }
  return undefined;
}

interface RawObject {
  key: string;
  size: number;
  lastModifiedMs: number;
  etag?: string;
}

interface SweptEntry extends RawObject {
  parsed: ParsedKey;
}

async function collectAllObjects(
  client: S3Client,
  bucket: string,
  projectsPrefix: string,
): Promise<RawObject[]> {
  const objects: RawObject[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: projectsPrefix,
        ...(continuationToken !== undefined && { ContinuationToken: continuationToken }),
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key === undefined) continue;
      objects.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModifiedMs: obj.LastModified !== undefined ? obj.LastModified.getTime() : 0,
        ...(obj.ETag !== undefined && { etag: obj.ETag }),
      });
    }
    continuationToken = res.IsTruncated === true ? res.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return objects;
}

/** The S3-backed `ClaudeSessionStore` implementation — see this file's doc comment. */
export function createS3ClaudeSessionStore(config: S3StoreConfig): ClaudeSessionStore {
  const { bucket, prefix } = config;
  const projectsPrefix = `${prefix}projects/`;
  const uriPrefix = `s3://${bucket}/`;
  const listTtlMs = config.listTtlMs ?? DEFAULT_LIST_TTL_MS;
  const client =
    config.client ??
    new S3Client({
      ...(config.endpoint !== undefined && { endpoint: config.endpoint, forcePathStyle: true }),
    });

  const keyToFilePath = (key: string): string => `${uriPrefix}${key}`;
  const filePathToKey = (filePath: string): string => {
    if (!filePath.startsWith(uriPrefix)) {
      throw new Error(`not an s3 URI for bucket "${bucket}": ${filePath}`);
    }
    return filePath.slice(uriPrefix.length);
  };

  /** Last-seen size per key, ACROSS sweep refreshes — how a shrink is detected. */
  const lastSeenSize = new Map<string, number>();
  let cached: { entries: SweptEntry[]; fetchedAtMs: number } | undefined;
  let inFlight: Promise<SweptEntry[]> | undefined;

  async function refreshSweep(): Promise<SweptEntry[]> {
    const raw = await collectAllObjects(client, bucket, projectsPrefix);
    const entries: SweptEntry[] = [];
    for (const obj of raw) {
      // Zero-byte "folder marker" keys — created by the S3 console, MinIO,
      // kumo, and similar tooling to make an empty "directory" visible —
      // show up on EVERY sweep for a console-provisioned bucket (as often as
      // every `listTtlMs`). They're not a real file in this store's model,
      // so skip them silently rather than warning every ~10s forever; a key
      // that's malformed for any OTHER reason (path traversal, unparseable
      // structure) still warns below.
      if (obj.key.endsWith("/")) continue;
      const parsed = parseObjectKey(obj.key, projectsPrefix);
      if (parsed === undefined) {
        console.warn(
          `[junrei][s3-store] ignoring key with unexpected structure or path traversal: ${keyToFilePath(obj.key)}`,
        );
        continue;
      }
      const prevSize = lastSeenSize.get(obj.key);
      if (prevSize !== undefined && obj.size < prevSize) {
        console.warn(
          `[junrei][s3-store] object size decreased (${prevSize} -> ${obj.size} bytes) — possible remote history rollback: ${keyToFilePath(obj.key)}`,
        );
      }
      lastSeenSize.set(obj.key, obj.size);
      entries.push({ ...obj, parsed });
    }
    return entries;
  }

  async function getSweep(): Promise<SweptEntry[]> {
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAtMs < listTtlMs) return cached.entries;
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        const entries = await refreshSweep();
        cached = { entries, fetchedAtMs: Date.now() };
        return entries;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  function toFileRef(entry: SweptEntry): ClaudeSessionFileRef {
    const mtimeMs = entry.lastModifiedMs;
    return {
      sessionId: entry.parsed.sessionId,
      filePath: keyToFilePath(entry.key),
      projectDirName: entry.parsed.projectDirName,
      mtimeMs,
      // S3 has no birth-time equivalent — LastModified doubles as both
      // ordering proxies (see `ClaudeSessionFileRef.birthtimeMs`'s doc
      // comment); a session's real `startedAt`, once parsed, takes over as
      // the authoritative sort key (see `@junrei/server`'s `sources/claude.ts`).
      birthtimeMs: mtimeMs,
      sizeBytes: entry.size,
      // ETag is an OPAQUE change token, never a content hash (multipart
      // uploads' ETags aren't MD5) — fallback to LastModified+Size when a
      // backend doesn't return one at all.
      changeToken: entry.etag ?? `${mtimeMs}:${entry.size}`,
    };
  }

  return {
    async listSessionFiles(): Promise<ClaudeSessionFileRef[]> {
      const entries = await getSweep();
      return entries
        .filter((e) => e.parsed.kind === "main")
        .map(toFileRef)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    },

    async findSessionFileById(sessionId: string): Promise<ClaudeSessionFileRef | undefined> {
      const entries = await getSweep();
      let best: ClaudeSessionFileRef | undefined;
      for (const entry of entries) {
        if (entry.parsed.kind !== "main" || entry.parsed.sessionId !== sessionId) continue;
        const ref = toFileRef(entry);
        if (best === undefined || ref.mtimeMs > best.mtimeMs) best = ref;
      }
      return best;
    },

    openLines(filePath: string): AsyncIterable<string> {
      const key = filePathToKey(filePath);
      return (async function* () {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (res.Body === undefined) {
          throw new Error(`s3 object has no body: ${filePath}`);
        }
        // In every Node.js runtime/http-handler the SDK supports, `Body` is a
        // Node `Readable` (with helper methods like `transformToString`
        // mixed in) — never a web `ReadableStream` or `Blob`, which only
        // show up in browser/edge runtimes this server never runs in. Piped
        // through `node:readline` so a large transcript is read line-by-line
        // rather than fully buffered in memory first (unlike `readFile`
        // below, which is only ever used for small meta/workflow JSON).
        if (!(res.Body instanceof Readable)) {
          throw new Error(`s3 object body is not a Node Readable stream: ${filePath}`);
        }
        const rl = createInterface({ input: res.Body, crlfDelay: Number.POSITIVE_INFINITY });
        for await (const line of rl) yield line;
      })();
    },

    async readFile(filePath: string): Promise<string> {
      const key = filePathToKey(filePath);
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (res.Body === undefined) {
        throw new Error(`s3 object has no body: ${filePath}`);
      }
      return res.Body.transformToString("utf-8");
    },

    async listSidecarFiles(mainFilePath: string): Promise<ClaudeSidecarFileRef[]> {
      const mainKey = filePathToKey(mainFilePath);
      const sessionDirPrefix = mainKey.endsWith(".jsonl")
        ? `${mainKey.slice(0, -".jsonl".length)}/`
        : `${mainKey}/`;
      const entries = await getSweep();
      return entries
        .filter((e) => e.parsed.kind === "sidecar" && e.key.startsWith(sessionDirPrefix))
        .map((e) => ({
          path: keyToFilePath(e.key),
          mtimeMs: e.lastModifiedMs,
          sizeBytes: e.size,
          // Same ETag-first, LastModified+Size-fallback convention as
          // `toFileRef` — see `ClaudeSidecarFileRef.changeToken`'s doc comment.
          changeToken: e.etag ?? `${e.lastModifiedMs}:${e.size}`,
        }));
    },
  };
}
