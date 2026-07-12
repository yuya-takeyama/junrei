import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface ClaudeSessionFileRef {
  /** Session UUID (the JSONL file basename). */
  sessionId: string;
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
}

/**
 * Resolve Claude Code config dirs containing a `projects/` dir.
 * `CLAUDE_CONFIG_DIR` (comma-separated) wins; otherwise both `~/.claude` and
 * `~/.config/claude` are considered (same behavior as ccusage).
 */
export async function resolveProjectsDirs(
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
export async function listSessionFiles(projectsDirs: string[]): Promise<ClaudeSessionFileRef[]> {
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
          });
        } catch {
          // Race with deletion — skip.
        }
      }
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
