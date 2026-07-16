import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface ClaudeSessionFileRef {
  /** Session UUID (the JSONL file basename). */
  sessionId: string;
  /**
   * Store-scoped URI identifying this file — an absolute local path for
   * `LocalClaudeSessionStore`, or an `s3://bucket/key` URI for an S3-backed
   * store (see `store.ts`). Opaque to callers: pass it back to the SAME
   * store's `openLines`/`readFile`, never parsed directly (except by the
   * store that produced it).
   */
  filePath: string;
  /** Munged project directory name under `projects/` (not reversible to a path). */
  projectDirName: string;
  mtimeMs: number;
  /**
   * File creation time — a cheap session-start proxy usable before the
   * transcript is ever parsed (session files are created at session start and
   * only appended to afterwards). 0 on filesystems that don't track birth
   * time; callers must fall back to `mtimeMs` then.
   */
  birthtimeMs: number;
  sizeBytes: number;
  /**
   * Opaque change token for cache invalidation — a cache keyed by `filePath`
   * is valid only while this token is unchanged (see `sources/claude.ts`'s
   * `analyzeCached` in `@junrei/server`). Local: `String(mtimeMs)`, identical
   * behavior to the old mtime-keyed cache. S3: the object's `ETag` (fallback
   * `LastModified`+`Size`) — NEVER treat as a content hash (multipart ETags
   * aren't MD5), it's a change marker only.
   */
  changeToken: string;
}

/**
 * Resolve Claude Code config dirs containing a `projects/` dir.
 * `CLAUDE_CONFIG_DIR` (comma-separated) wins; otherwise both `~/.claude` and
 * `~/.config/claude` are considered (same behavior as ccusage).
 */
export async function resolveClaudeProjectsDirs(
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const home = homedir();
  const candidates =
    env.CLAUDE_CONFIG_DIR !== undefined
      ? env.CLAUDE_CONFIG_DIR.split(",").map((dir) => dir.trim().replace(/^~/, home))
      : [join(home, ".claude"), join(home, ".config", "claude")];

  const result: string[] = [];
  for (const dir of candidates) {
    const projects = basename(dir) === "projects" ? dir : join(dir, "projects");
    try {
      const info = await stat(projects);
      if (info.isDirectory()) result.push(projects);
    } catch {
      // Missing dir — skip.
    }
  }
  return result;
}

/** List all session JSONL files across projects, newest first. */
export async function listClaudeSessionFiles(
  projectsDirs: string[],
): Promise<ClaudeSessionFileRef[]> {
  const refs: ClaudeSessionFileRef[] = [];
  for (const projectsDir of projectsDirs) {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(projectsDir);
    } catch {
      continue;
    }
    for (const projectDirName of projectDirs) {
      const projectPath = join(projectsDir, projectDirName);
      let entries: string[];
      try {
        entries = await readdir(projectPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = join(projectPath, entry);
        try {
          const info = await stat(filePath);
          if (!info.isFile()) continue;
          refs.push({
            sessionId: entry.slice(0, -".jsonl".length),
            filePath,
            projectDirName,
            mtimeMs: info.mtimeMs,
            birthtimeMs: info.birthtimeMs,
            sizeBytes: info.size,
            changeToken: String(info.mtimeMs),
          });
        } catch {
          // Race with deletion — skip.
        }
      }
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Resolve a Claude session file by bare session ID alone, without knowing
 * which project directory it lives under — the server's bare-ID lookup (see
 * `findRefById` in `@junrei/server`'s `sources/claude.ts`) so a session
 * URL/API path can carry just the UUID, mirroring Codex's project-less
 * session id. Cheaper than `listClaudeSessionFiles`: rather than reading
 * every project dir's full contents, this lists project DIR NAMES once and
 * stats exactly one candidate path (`{projectDir}/{sessionId}.jsonl`) per
 * project dir — no need to read or stat any other session file.
 *
 * Session ids are UUIDv4, so a collision across two project dirs is
 * practically impossible; if one somehow exists anyway (e.g. a stale copy),
 * the file with the newest mtime wins, deterministically.
 */
export async function findClaudeSessionFileById(
  projectsDirs: string[],
  sessionId: string,
): Promise<ClaudeSessionFileRef | undefined> {
  let best: ClaudeSessionFileRef | undefined;
  for (const projectsDir of projectsDirs) {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(projectsDir);
    } catch {
      continue;
    }
    for (const projectDirName of projectDirs) {
      const filePath = join(projectsDir, projectDirName, `${sessionId}.jsonl`);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        if (best === undefined || info.mtimeMs > best.mtimeMs) {
          best = {
            sessionId,
            filePath,
            projectDirName,
            mtimeMs: info.mtimeMs,
            birthtimeMs: info.birthtimeMs,
            sizeBytes: info.size,
            changeToken: String(info.mtimeMs),
          };
        }
      } catch {
        // Not present in this project dir — try the next.
      }
    }
  }
  return best;
}
