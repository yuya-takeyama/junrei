import type { AnySessionJson } from "../../api.js";

export type FileAccessEntryLike = AnySessionJson["fileAccess"][number];

/**
 * Re-read flagging threshold — the DOCUMENTED rule from
 * design-spec/15-files-skills.md/99-components.md ("reads >= 3 turn the path
 * + count amber"), not the sample's own (inconsistent) rendering.
 */
export const REREAD_THRESHOLD = 3;

/**
 * Best-effort home-directory guess from `cwd`, used only to shorten a path
 * that shares the user's home prefix but lives outside `cwd` to `~/...`.
 * There's no actual `$HOME` anywhere in a session transcript, so this is a
 * heuristic (first two path segments of `cwd`, e.g. `/Users/yuya`) rather
 * than ground truth — documented as a deliberate judgment call.
 */
function homeGuess(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const parts = cwd.split("/");
  if (parts.length >= 3 && (parts[1] === "Users" || parts[1] === "home") && parts[2] !== "") {
    return `/${parts[1] as string}/${parts[2] as string}`;
  }
  return undefined;
}

/**
 * Display form of an absolute path: relative to `cwd` when it's nested under
 * it, `~`-shortened when it shares the guessed home prefix instead, else the
 * raw absolute path.
 */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined) {
    if (path === cwd) return ".";
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  const home = homeGuess(cwd);
  if (home !== undefined) {
    if (path === home) return "~";
    const homePrefix = `${home}/`;
    if (path.startsWith(homePrefix)) return `~/${path.slice(homePrefix.length)}`;
  }
  return path;
}

export type FileTreeRow =
  | { kind: "dir"; key: string; label: string }
  | { kind: "file"; key: string; label: string; indent: boolean; entry: FileAccessEntryLike };

/**
 * Flatten `entries` into display rows: grouped by containing directory (dirs
 * sorted lexicographically, root-level paths first), files sorted within
 * their group, with one muted directory-header row per directory — root-level
 * paths (no `/`) never get a header and are never indented.
 *
 * Grouping happens on (dir, name), NOT on the full display path: sorting full
 * paths would interleave a subdirectory's entries between its parent's files
 * (`src/parser.ts` < `src/pricing/x` < `src/session-data.ts`) and emit the
 * parent header — and its React row key — twice.
 */
export function buildFileTreeRows(
  entries: readonly FileAccessEntryLike[],
  cwd: string | undefined,
): FileTreeRow[] {
  const split = entries.map((entry) => {
    const display = displayPath(entry.path, cwd);
    const slashIdx = display.lastIndexOf("/");
    return {
      entry,
      dir: slashIdx === -1 ? "" : display.slice(0, slashIdx + 1),
      name: slashIdx === -1 ? display : display.slice(slashIdx + 1),
    };
  });
  split.sort((a, b) => {
    if (a.dir !== b.dir) {
      // Root-level files sort after every directory group, like the mock.
      if (a.dir === "") return 1;
      if (b.dir === "") return -1;
      return a.dir.localeCompare(b.dir);
    }
    return a.name.localeCompare(b.name);
  });

  const rows: FileTreeRow[] = [];
  let currentDir: string | undefined;
  for (const { entry, dir, name } of split) {
    if (dir !== "" && dir !== currentDir) {
      rows.push({ kind: "dir", key: `dir:${dir}`, label: dir });
    }
    currentDir = dir === "" ? undefined : dir;
    rows.push({ kind: "file", key: entry.path, label: name, indent: dir !== "", entry });
  }
  return rows;
}

/** Basename for path-like subjects, else the first 40 chars — repetition-findings panel. */
export function shortSubject(subject: string): string {
  if (subject.includes("/")) {
    const parts = subject.split("/");
    return parts[parts.length - 1] || subject;
  }
  return subject.slice(0, 40);
}
