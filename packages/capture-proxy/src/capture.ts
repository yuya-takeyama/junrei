/**
 * Capture-record shape, storage-path resolution, and the JSONL writer for the
 * wire-capture proxy (Goshuin Phase D). Every field written here has already
 * passed through `redactHeaders` at the call site in `proxy.ts` — this module
 * assumes header maps are pre-redacted and never redacts again, so the
 * security property lives in exactly one place.
 */

import { appendFile, mkdir } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

/** Header name Claude Code stamps with the session id (join key → session). */
export const SESSION_ID_HEADER = "x-claude-code-session-id";
/** Response header carrying the id the session log records as `requestId` (join key → turn). */
export const REQUEST_ID_HEADER = "request-id";
/** Fallback capture file for requests that carry no resolvable session id. */
export const UNASSIGNED_FILENAME = "_unassigned.jsonl";

/**
 * One proxied HTTP exchange, as written to `<dir>/<sessionId>.jsonl`. Header
 * maps are ALWAYS the redacted copies. `responseBody` holds the parsed JSON
 * body for a normal response, or — for an SSE (`text/event-stream`) response —
 * the FULL RAW event-stream text (byte-faithful, the calibration ground truth);
 * `assembledMessage` additionally carries the SDK-style reassembled message for
 * that SSE case, so the read side gets `model`/`usage` without re-parsing.
 */
export interface CaptureEntry {
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  method: string;
  path: string;
  status: number;
  sessionId: string | null;
  requestId: string | null;
  isSubagent: boolean;
  requestHeaders: Record<string, string | string[]>;
  requestBody: unknown;
  requestBytes: number;
  responseHeaders: Record<string, string | string[]>;
  contentType: string;
  responseBody: unknown;
  assembledMessage: Record<string, unknown> | null;
  responseBytes: number;
  error?: string;
}

/**
 * Make a session id safe to use as a path segment: keep only
 * `[A-Za-z0-9._-]`, mapping everything else to `_`. A value that sanitizes to
 * empty or to a dot-run (`.`/`..`, i.e. path-traversal shapes) is rejected
 * (`null`) so it can never escape the captures dir — the caller routes those
 * to the `_unassigned` file.
 */
export function sanitizeSessionId(sessionId: string): string | null {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned === "" || /^\.+$/.test(cleaned)) return null;
  return cleaned;
}

/** The capture file name for a (possibly absent/unsafe) session id — `_unassigned.jsonl` fallback. */
export function captureFileName(sessionId: string | null | undefined): string {
  if (sessionId === null || sessionId === undefined || sessionId === "") {
    return UNASSIGNED_FILENAME;
  }
  const safe = sanitizeSessionId(sessionId);
  return safe === null ? UNASSIGNED_FILENAME : `${safe}.jsonl`;
}

/** First value of a possibly-array header, lowercased-name lookup done by the caller. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Extract the join-key session id from the request headers (`x-claude-code-session-id`). */
export function extractSessionId(requestHeaders: IncomingHttpHeaders): string | null {
  return headerValue(requestHeaders, SESSION_ID_HEADER) ?? null;
}

/** Extract the join-key request id from the response headers (`request-id`). */
export function extractRequestId(responseHeaders: IncomingHttpHeaders): string | null {
  return headerValue(responseHeaders, REQUEST_ID_HEADER) ?? null;
}

/**
 * Whether this request is a Task-tool subagent call. Follows what the
 * experiment observed (`experiments/claude-code-capture/recon/lib.mjs`): the
 * marker `cc_is_subagent=true` appears in the request body's `system` blocks
 * (Claude Code's per-request billing-header block). A `user-agent` fallback is
 * also scanned in case a harness version surfaces the flag there instead.
 */
export function detectIsSubagent(
  requestBody: unknown,
  requestHeaders: IncomingHttpHeaders,
): boolean {
  const marker = "cc_is_subagent=true";
  const systemText = systemBlocksText(requestBody);
  if (systemText.includes(marker)) return true;
  const ua = headerValue(requestHeaders, "user-agent");
  return typeof ua === "string" && ua.includes(marker);
}

function systemBlocksText(requestBody: unknown): string {
  if (requestBody !== null && typeof requestBody === "object" && "system" in requestBody) {
    return JSON.stringify((requestBody as { system?: unknown }).system ?? "");
  }
  return typeof requestBody === "string" ? requestBody : "";
}

/**
 * Append one capture entry as a JSONL line under `dir`, in the file named for
 * its session id (`captureFileName`). The directory is created if missing.
 * Returns the absolute file path written to.
 */
export async function appendCapture(dir: string, entry: CaptureEntry): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, captureFileName(entry.sessionId));
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
}
