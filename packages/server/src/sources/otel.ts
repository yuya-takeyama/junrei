/**
 * Filesystem storage for the Goshuin Phase E OTel receiver (Decision 7, see
 * docs/milestones/goshuin.md) — plain `node:fs` I/O only, no OTel SDK, no
 * parsing knowledge (that lives in `@junrei/core`'s `claude/otel.ts`, per the
 * "no node:fs in core" dependency direction). One JSONL file per
 * `session.id` under the opt-in `JUNREI_OTEL_DIR`; a record whose session id
 * couldn't be resolved (or failed sanitization) lands in `_unassigned.jsonl`
 * instead of being dropped.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Resolve the opt-in OTel storage dir from `JUNREI_OTEL_DIR` — `undefined`
 * (feature OFF) unless the env var is set to a non-blank value. Same
 * override-by-env convention as `JUNREI_TEMPLATES_DIR`/`JUNREI_S3_SOURCE_URI`
 * (see `sources/reconstruction.ts`): unset means byte-for-byte unchanged
 * behavior everywhere else in the server (Decision 7's hard acceptance
 * criterion) — every caller of this function is expected to treat
 * `undefined` as "the OTel receiver/tool doesn't exist", not "use a default
 * dir", unlike the templates dir (which DOES have a `~/.junrei/templates`
 * default) — OTel storage has no implicit default location.
 */
export function resolveOtelDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.JUNREI_OTEL_DIR;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const UNASSIGNED_OTEL_FILE = "_unassigned";

/**
 * Reject (never mangle) a session id that isn't safe to use as a bare file
 * name: empty/blank, `.`/`..`, or containing a path separator or NUL byte.
 * `undefined` in, `undefined` out (nothing to sanitize). A rejected id is
 * the caller's cue to route the record to `_unassigned.jsonl` instead — this
 * function only ever narrows to a safe value or refuses, it never strips/
 * escapes to force one through.
 */
export function sanitizeSessionId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const trimmed = id.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
  return trimmed;
}

function otelFileNameFor(sessionId: string | undefined): string {
  return `${sanitizeSessionId(sessionId) ?? UNASSIGNED_OTEL_FILE}.jsonl`;
}

/**
 * Append one raw OTLP export body as a single JSONL line under `otelDir`,
 * routed by (sanitized) `sessionId` — creates `otelDir` on first write.
 */
export async function appendOtelLine(
  otelDir: string,
  sessionId: string | undefined,
  body: unknown,
): Promise<void> {
  await mkdir(otelDir, { recursive: true });
  const filePath = join(otelDir, otelFileNameFor(sessionId));
  await appendFile(filePath, `${JSON.stringify(body)}\n`, "utf8");
}

/**
 * Read one session's stored OTel JSONL lines, oldest first — `[]` when
 * `sessionId` fails sanitization or no file exists yet (OTel disabled, or
 * simply no data for this session), never a thrown error; the MCP tool
 * (`get_session_observability`) turns an empty result into an explicit
 * `otelAvailable`/`hasData` declaration rather than silently returning
 * nothing.
 */
export async function readOtelLines(otelDir: string, sessionId: string): Promise<string[]> {
  const safe = sanitizeSessionId(sessionId);
  if (safe === undefined) return [];
  const filePath = join(otelDir, `${safe}.jsonl`);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.trim() !== "");
}
