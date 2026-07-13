import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the Claude Code Desktop app's per-session metadata store.
 *
 * Desktop sessions never write `ai-title`/`custom-title` records into the
 * transcript JSONL — their title (the one shown in the Desktop session list,
 * e.g. "Orchestration cost percentage display") lives only in
 * `claude-code-sessions/<install>/<scope>/local_<desktopId>.json` under the
 * app's userData dir. Each file's `cliSessionId` field is the transcript
 * session UUID, which is the join key back to `projects/<dir>/<uuid>.jsonl`.
 */

const DESKTOP_META_FILENAME = /^local_.*\.json$/;
// Observed layout nests meta files exactly two directories deep; allow one
// extra level so a future re-bucketing doesn't silently drop every title.
const MAX_SCAN_DEPTH = 3;

/**
 * Resolve Claude Desktop dirs containing session metadata (`local_*.json`).
 * `JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR` (comma-separated) wins; otherwise the
 * platform's Electron userData location for the "Claude" app is used.
 * Only dirs that actually exist are returned — no Desktop app, no titles.
 */
export async function resolveClaudeDesktopSessionsDirs(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const home = homedir();
  const candidates =
    env.JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR !== undefined
      ? env.JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR.split(",").map((dir) =>
          dir.trim().replace(/^~/, home),
        )
      : defaultDirs(env, platform, home);

  const result: string[] = [];
  for (const dir of candidates) {
    try {
      const info = await stat(dir);
      if (info.isDirectory()) result.push(dir);
    } catch {
      // Missing dir — skip.
    }
  }
  return result;
}

function defaultDirs(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  switch (platform) {
    case "darwin":
      return [join(home, "Library", "Application Support", "Claude", "claude-code-sessions")];
    case "win32":
      return env.APPDATA !== undefined ? [join(env.APPDATA, "Claude", "claude-code-sessions")] : [];
    default:
      return [join(home, ".config", "Claude", "claude-code-sessions")];
  }
}

interface DesktopTitleEntry {
  cliSessionId: string;
  title: string;
}

interface MetaCacheEntry {
  mtimeMs: number;
  /** undefined = parsed but unusable (missing cliSessionId/title, bad JSON). */
  entry: DesktopTitleEntry | undefined;
}

// Meta files are ~80KB each (they embed full MCP tool schemas), so re-parsing
// the whole store on every session-list request would cost ~10MB of JSON.parse.
// Keyed by path + mtime, so edits (e.g. a rename in the Desktop app) re-read.
const metaCache = new Map<string, MetaCacheEntry>();

/**
 * Map transcript session UUID -> Desktop session title, across all `dirs`.
 * When two meta files claim the same `cliSessionId`, the newest file wins.
 * Unreadable or shapeless files are skipped, never thrown.
 */
export async function loadClaudeDesktopTitles(dirs: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const sourceMtime = new Map<string, number>();
  for (const dir of dirs) {
    for (const file of await listMetaFiles(dir, MAX_SCAN_DEPTH)) {
      const entry = await readMetaCached(file.filePath, file.mtimeMs);
      if (entry === undefined) continue;
      const seen = sourceMtime.get(entry.cliSessionId);
      if (seen !== undefined && seen >= file.mtimeMs) continue;
      sourceMtime.set(entry.cliSessionId, file.mtimeMs);
      titles.set(entry.cliSessionId, entry.title);
    }
  }
  return titles;
}

async function listMetaFiles(
  dir: string,
  depthLeft: number,
): Promise<{ filePath: string; mtimeMs: number }[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: { filePath: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depthLeft > 0) files.push(...(await listMetaFiles(entryPath, depthLeft - 1)));
      continue;
    }
    if (!entry.isFile() || !DESKTOP_META_FILENAME.test(entry.name)) continue;
    try {
      files.push({ filePath: entryPath, mtimeMs: (await stat(entryPath)).mtimeMs });
    } catch {
      // Race with deletion — skip.
    }
  }
  return files;
}

async function readMetaCached(
  filePath: string,
  mtimeMs: number,
): Promise<DesktopTitleEntry | undefined> {
  const hit = metaCache.get(filePath);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.entry;
  const entry = await readMeta(filePath);
  metaCache.set(filePath, { mtimeMs, entry });
  return entry;
}

async function readMeta(filePath: string): Promise<DesktopTitleEntry | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { cliSessionId, title } = raw as Record<string, unknown>;
    if (typeof cliSessionId !== "string" || cliSessionId === "") return undefined;
    if (typeof title !== "string" || title === "") return undefined;
    return { cliSessionId, title };
  } catch {
    return undefined;
  }
}
