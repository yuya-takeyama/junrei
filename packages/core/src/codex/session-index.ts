import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonlLine } from "../shared/jsonl.js";

/**
 * Reader for Codex's thread-name index (`$CODEX_HOME/session_index.jsonl`).
 *
 * Newer Codex versions no longer write a `thread_name_updated` event into the
 * rollout itself — a thread's name (auto-generated shortly after the first
 * turn, or set by a rename in the Codex UI) is recorded only in this index of
 * `{id, thread_name, updated_at}` JSONL lines. A rename made after the
 * session ended also touches only this file, so the index carries the name
 * the Codex UI actually shows.
 */

interface IndexCacheEntry {
  mtimeMs: number;
  titles: Map<string, string>;
}

// One entry per index file path (different CODEX_HOMEs never collide), so a
// session-list request doesn't re-parse the whole index unless it changed.
const indexCache = new Map<string, IndexCacheEntry>();

/**
 * Map session UUID -> thread name from `<codexHome>/session_index.jsonl`.
 * When the same id appears on multiple lines, the last one wins (the file
 * grows append-style, so later lines are newer). A missing or unreadable
 * index yields an empty map; malformed or fieldless lines are skipped.
 */
export async function loadCodexSessionIndexTitles(codexHome: string): Promise<Map<string, string>> {
  const filePath = join(codexHome, "session_index.jsonl");
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    return new Map();
  }
  const hit = indexCache.get(filePath);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.titles;

  const titles = new Map<string, string>();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return new Map();
  }
  for (const line of raw.split("\n")) {
    const record = parseJsonlLine(line);
    if (typeof record !== "object" || record === null) continue;
    const { id, thread_name: threadName } = record as Record<string, unknown>;
    if (typeof id !== "string" || id === "") continue;
    if (typeof threadName !== "string" || threadName === "") continue;
    titles.set(id, threadName);
  }
  indexCache.set(filePath, { mtimeMs, titles });
  return titles;
}
