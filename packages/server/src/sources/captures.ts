/**
 * Read side of the Goshuin Phase D wire capture (docs/milestones/goshuin.md).
 * The `@junrei/capture-proxy` bin WRITES capture JSONL under
 * `~/.junrei/captures/`; this module READS it — strictly read-only, never
 * writing or mutating a capture — to back the `get_actual_request` /
 * `get_hidden_calls` MCP tools.
 *
 * A missing captures directory is NOT an error: it just means the user never
 * opted into capture, so every lookup degrades to a declared "unavailable"
 * result the tools surface as `captureAvailable: false`. The captures dir is
 * injectable (constructor arg / `JUNREI_CAPTURES_DIR`) so tests never touch a
 * real `~/.junrei`.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureFileName } from "@junrei/capture-proxy";
import { type ClaudeSessionStore, localClaudeSessionStore } from "@junrei/core";

/**
 * Resolve the captures directory: `JUNREI_CAPTURES_DIR`, else
 * `~/.junrei/captures` — the SAME resolution the writer uses
 * (`@junrei/capture-proxy`'s `resolveCapturesDir`), so reader and writer always
 * agree on location.
 */
export function resolveCapturesDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.JUNREI_CAPTURES_DIR;
  return fromEnv !== undefined && fromEnv.trim() !== ""
    ? fromEnv
    : join(homedir(), ".junrei", "captures");
}

/**
 * The read view of one captured exchange. Deliberately all-optional (except
 * the raw `requestId` join key we look up on): capture files are written by a
 * separate process and may be partial/older-schema, so the reader tolerates
 * missing fields rather than trusting a fixed shape. Shape mirrors
 * `@junrei/capture-proxy`'s `CaptureEntry`.
 */
export interface CapturedRecord {
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  method?: string;
  path?: string;
  status?: number;
  sessionId?: string | null;
  requestId?: string | null;
  isSubagent?: boolean;
  requestHeaders?: Record<string, unknown>;
  requestBody?: unknown;
  requestBytes?: number;
  responseHeaders?: Record<string, unknown>;
  contentType?: string;
  responseBody?: unknown;
  assembledMessage?: Record<string, unknown> | null;
  responseBytes?: number;
  error?: string;
}

/**
 * A capture lookup outcome. `available: false` (dir missing, or this session
 * has no capture file) is a DECLARED non-error the tools report as
 * `captureAvailable: false`, never a thrown/crash path.
 */
export type CaptureLookup =
  | { available: false; reason: "captures-dir-missing" | "session-not-captured" }
  | { available: true; records: CapturedRecord[] };

export interface CaptureStoreOptions {
  /** Override the captures root — for tests. Defaults to `resolveCapturesDir()`. */
  capturesDir?: string;
  /** Override the Claude session store used for the logged-requestId join — for tests. */
  sessionStore?: ClaudeSessionStore;
}

export interface CaptureStore {
  /** The captured exchanges for one session, or a declared-unavailable result. */
  readSessionCaptures(sessionId: string): Promise<CaptureLookup>;
  /**
   * The set of `requestId`s recorded ANYWHERE in the session's own log (main
   * transcript + subagent sidecars). `undefined` when the session isn't found
   * in the local log at all. Used to compute `get_hidden_calls`: a captured
   * request whose id is absent from this set never appeared in the log.
   */
  collectLoggedRequestIds(sessionId: string): Promise<Set<string> | undefined>;
}

/** Parse JSONL text into records, skipping blank and malformed lines defensively. */
function parseCaptureJsonl(text: string): CapturedRecord[] {
  const records: CapturedRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed) as CapturedRecord);
    } catch {
      // A torn last line (proxy mid-write) or corrupt line is skipped, not fatal.
    }
  }
  return records;
}

async function collectRequestIdsFromFile(
  store: ClaudeSessionStore,
  filePath: string,
  into: Set<string>,
): Promise<void> {
  try {
    for await (const line of store.openLines(filePath)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const record = JSON.parse(trimmed) as { requestId?: unknown };
        if (typeof record.requestId === "string") into.add(record.requestId);
      } catch {
        // Skip malformed lines.
      }
    }
  } catch {
    // Unreadable file (race with deletion, etc.) — contributes no ids.
  }
}

/** Filesystem-backed capture reader. */
export function createFilesystemCaptureStore(opts: CaptureStoreOptions = {}): CaptureStore {
  const capturesDir = opts.capturesDir ?? resolveCapturesDir();
  const sessionStore = opts.sessionStore ?? localClaudeSessionStore;

  return {
    async readSessionCaptures(sessionId: string): Promise<CaptureLookup> {
      try {
        const info = await stat(capturesDir);
        if (!info.isDirectory()) return { available: false, reason: "captures-dir-missing" };
      } catch {
        return { available: false, reason: "captures-dir-missing" };
      }
      const filePath = join(capturesDir, captureFileName(sessionId));
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        return { available: false, reason: "session-not-captured" };
      }
      return { available: true, records: parseCaptureJsonl(text) };
    },

    async collectLoggedRequestIds(sessionId: string): Promise<Set<string> | undefined> {
      const ref = await sessionStore.findSessionFileById(sessionId);
      if (ref === undefined) return undefined;
      const ids = new Set<string>();
      await collectRequestIdsFromFile(sessionStore, ref.filePath, ids);
      const sidecars = await sessionStore.listSidecarFiles(ref.filePath);
      for (const sidecar of sidecars) {
        if (sidecar.path.endsWith(".jsonl")) {
          await collectRequestIdsFromFile(sessionStore, sidecar.path, ids);
        }
      }
      return ids;
    },
  };
}

/** Find the captured exchange whose response `request-id` matches `requestId`. */
export function findCapturedRequest(
  records: readonly CapturedRecord[],
  requestId: string,
): CapturedRecord | undefined {
  return records.find((record) => record.requestId === requestId);
}

/**
 * Pull response meta (status, model, usage) from a captured record — from the
 * reassembled SSE message when present, else the parsed non-SSE JSON body.
 * Every field is optional: an error/partial capture may carry none.
 */
export function extractResponseMeta(record: CapturedRecord): {
  status?: number;
  model?: string;
  usage?: unknown;
} {
  const body =
    record.assembledMessage ??
    (record.responseBody !== null && typeof record.responseBody === "object"
      ? (record.responseBody as Record<string, unknown>)
      : undefined);
  const model = typeof body?.model === "string" ? body.model : undefined;
  const usage = body?.usage;
  return {
    ...(record.status !== undefined && { status: record.status }),
    ...(model !== undefined && { model }),
    ...(usage !== undefined && { usage }),
  };
}

/** The captured request/response byte sizes, defaulting to 0 when a record omits them. */
export function capturedByteSizes(record: CapturedRecord): {
  requestBytes: number;
  responseBytes: number;
} {
  return {
    requestBytes: record.requestBytes ?? 0,
    responseBytes: record.responseBytes ?? 0,
  };
}
