import type { AnySessionJson } from "../../api.js";
import { fuzzyMatch } from "./fuzzy.js";

export type FileAccessEntryLike = AnySessionJson["fileAccess"][number];

/**
 * Re-read flagging threshold — the DOCUMENTED rule from
 * design-spec/15-files-skills.md/99-components.md ("reads >= 3 turn the path
 * + count amber"), not the sample's own (inconsistent) rendering.
 */
export const REREAD_THRESHOLD = 3;

/** Indent per compressed tree depth level — see `FileTreeNode.depth`. */
export const TREE_INDENT_PX = 15;

/**
 * Width of the chevron column a directory row renders before its label
 * (`.tree-toggle`: 12px + 4px margin). File rows pad by this too, so a
 * label at depth N starts at the same x whether the row is a dir or a
 * file — without it, a file at depth N+1 lands at its parent dir's label
 * x (N·15 + 16 vs N·15 + 15) and reads as a sibling of the dir.
 */
export const TREE_CHEVRON_PX = 16;

// ---------------------------------------------------------------------
// Scope classification — Repository / Home / System
// ---------------------------------------------------------------------

export type FileScope = "repo" | "home" | "system";

export const SCOPE_LABEL: Record<FileScope, string> = {
  repo: "Repository",
  home: "Home",
  system: "System",
};

/**
 * Best-effort home-directory guess from `cwd`, used only to bucket a path
 * that shares the user's home prefix but lives outside `cwd` into the Home
 * scope. There's no actual `$HOME` anywhere in a session transcript, so this
 * is a heuristic (first two path segments of `cwd`, e.g. `/Users/yuya`)
 * rather than ground truth — documented as a deliberate judgment call.
 */
function homeGuess(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const parts = cwd.split("/");
  if (parts.length >= 3 && (parts[1] === "Users" || parts[1] === "home") && parts[2] !== "") {
    return `/${parts[1] as string}/${parts[2] as string}`;
  }
  return undefined;
}

function isUnder(path: string, dir: string): boolean {
  if (path === dir) return true;
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(prefix);
}

/**
 * Which scope section a path belongs to. Repository wins over Home even
 * when `cwd` itself is nested under the guessed home prefix (the common
 * case) — checked first, so a repo file never double-counts into Home.
 * Everything left over (outside both `cwd` and the home guess, or when
 * either is unknown) is System.
 */
export function scopeOf(
  path: string,
  cwd: string | undefined,
  home: string | undefined,
): FileScope {
  if (cwd !== undefined && isUnder(path, cwd)) return "repo";
  if (home !== undefined && isUnder(path, home)) return "home";
  return "system";
}

/** Last two `cwd` segments — same shortening convention `formatProject` (format.ts) uses for repo labels elsewhere, kept local since it's driven from a different source string (a raw cwd, not a munged project-dir name) and the two contracts would blur if shared. */
function shortenCwd(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p !== "");
  return parts.length > 0 ? parts.slice(-2).join("/") : cwd;
}

/** Muted root-hint label shown next to a section header — see `ScopeSection`. */
export function rootHintFor(scope: FileScope, cwd: string | undefined): string {
  if (scope === "repo") return cwd !== undefined ? shortenCwd(cwd) : "";
  if (scope === "home") return "~";
  return "/";
}

function relativeSegments(path: string, rootDir: string): string[] {
  if (path === rootDir) return ["."];
  const prefix = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
  return path.slice(prefix.length).split("/");
}

/**
 * `path` broken into segments relative to its scope's root — the basis for
 * both the per-scope tree (dir segments = all but the last) and the fuzzy
 * filter's match target (`segments.join("/")`). Repository: relative to
 * `cwd`. Home: relative to the guessed home prefix. System: the absolute
 * path's own segments (no leading empty segment from the root `/`).
 */
export function scopeRelativeSegments(
  path: string,
  scope: FileScope,
  cwd: string | undefined,
  home: string | undefined,
): string[] {
  if (scope === "repo" && cwd !== undefined) return relativeSegments(path, cwd);
  if (scope === "home" && home !== undefined) return relativeSegments(path, home);
  return path.split("/").filter((p) => p !== "");
}

// ---------------------------------------------------------------------
// Tree building — compact ("VSCode compact folders") directory tree per
// scope, with per-directory aggregated read/edit counts.
// ---------------------------------------------------------------------

export interface FileTreeFileRow {
  kind: "file";
  /** `entry.path` — globally unique across the whole session, so it doubles as the React key. */
  key: string;
  name: string;
  /** Depth AFTER chain compression — see `FileTreeDirRow.depth`. */
  depth: number;
  entry: FileAccessEntryLike;
  /** See the old `buildFileTreeRows`' doc — true when another listed path lies beneath this one, proving it's a directory (e.g. an rg/grep search root). */
  isDirectory: boolean;
  /** Indices into `name` (NOT the full scope-relative path fuzzyMatch ran against) — set only while a filter query is active and this file matched. */
  matchedIndices?: number[];
}

export interface FileTreeDirRow {
  kind: "dir";
  /** `${scope}:${fullRelativeDirPath}/` — stable across renders (independent of the compressed `label`), namespaced by scope so identically-named dirs in different scopes never collide as collapse-state keys. */
  key: string;
  /** Compressed chain label, e.g. `"a/b/c/"` when `a`, `b` each had exactly one (directory-only) child. */
  label: string;
  /** Tree depth counting a compressed chain as ONE level — the indent basis (see `TREE_INDENT_PX`), not the number of real directories folded into this row. */
  depth: number;
  /** Sum of `reads`/`edits` over every descendant FILE (recursively) — shown muted in the reads/edits columns so hot areas stay visible while collapsed. */
  reads: number;
  edits: number;
  children: FileTreeNode[];
}

export type FileTreeNode = FileTreeDirRow | FileTreeFileRow;

interface RawFile {
  entry: FileAccessEntryLike;
  name: string;
}

interface RawDir {
  files: RawFile[];
  dirs: Map<string, RawDir>;
}

function emptyRawDir(): RawDir {
  return { files: [], dirs: new Map() };
}

function insertEntry(root: RawDir, segments: readonly string[], entry: FileAccessEntryLike): void {
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    let child = node.dirs.get(seg);
    if (child === undefined) {
      child = emptyRawDir();
      node.dirs.set(seg, child);
    }
    node = child;
  }
  node.files.push({ entry, name: segments[segments.length - 1] as string });
}

function sumDescendantCounts(children: readonly FileTreeNode[]): { reads: number; edits: number } {
  let reads = 0;
  let edits = 0;
  for (const child of children) {
    if (child.kind === "file") {
      reads += child.entry.reads;
      edits += child.entry.edits;
    } else {
      reads += child.reads;
      edits += child.edits;
    }
  }
  return { reads, edits };
}

/** Per-`entry.path` fuzzy-match result, keyed for `finalizeDir`/`finalizeChildren` to attach `matchedIndices` to the right file row. */
type MatchesByPath = ReadonlyMap<string, { displayPath: string; indices: readonly number[] }>;

function finalizeDir(
  scope: FileScope,
  name: string,
  raw: RawDir,
  depth: number,
  parentPathSegs: readonly string[],
  isDirectoryOf: (path: string) => boolean,
  matches: MatchesByPath | undefined,
): FileTreeDirRow {
  // Compress a single-child directory chain (VSCode "compact folders"):
  // while a node has no files of its own and exactly one subdirectory, fold
  // that subdirectory's name into this row's label and descend, so
  // `a/ -> b/ -> c/ -> file.ts` renders as one `a/b/c/` row instead of three
  // nested no-op rows.
  const labels = [name];
  const pathSegs = [...parentPathSegs, name];
  let node = raw;
  while (node.files.length === 0 && node.dirs.size === 1) {
    const [childName, child] = [...node.dirs][0] as [string, RawDir];
    labels.push(childName);
    pathSegs.push(childName);
    node = child;
  }
  const children = finalizeChildren(scope, node, depth + 1, pathSegs, isDirectoryOf, matches);
  const { reads, edits } = sumDescendantCounts(children);
  return {
    kind: "dir",
    key: `${scope}:${pathSegs.join("/")}/`,
    label: `${labels.join("/")}/`,
    depth,
    reads,
    edits,
    children,
  };
}

function finalizeChildren(
  scope: FileScope,
  raw: RawDir,
  depth: number,
  pathSegs: readonly string[],
  isDirectoryOf: (path: string) => boolean,
  matches: MatchesByPath | undefined,
): FileTreeNode[] {
  const dirRows = [...raw.dirs.entries()]
    .map(([name, child]) =>
      finalizeDir(scope, name, child, depth, pathSegs, isDirectoryOf, matches),
    )
    .sort((a, b) => a.label.localeCompare(b.label));

  const fileRows = raw.files
    .map(({ entry, name }): FileTreeFileRow => {
      const match = matches?.get(entry.path);
      const matchedIndices =
        match !== undefined ? localizeMatchIndices(match, name.length) : undefined;
      return {
        kind: "file",
        key: entry.path,
        name,
        depth,
        entry,
        isDirectory: isDirectoryOf(entry.path),
        ...(matchedIndices !== undefined && { matchedIndices }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Directories first, then files — both already lexicographic within their group.
  return [...dirRows, ...fileRows];
}

/** Translate a match's full-scope-relative-path indices onto the file row's own `name` (its basename) — the match ran against the full path (so a directory-name query still finds files inside it), but only the basename is ever rendered in a row, so only the tail of the index list can land on visible text. */
function localizeMatchIndices(
  match: { displayPath: string; indices: readonly number[] },
  nameLength: number,
): number[] {
  const offset = match.displayPath.length - nameLength;
  return match.indices.filter((i) => i >= offset).map((i) => i - offset);
}

/**
 * Build the compact directory tree for one scope's file entries.
 * `allEntries` is the FULL (unscoped, unfiltered) `session.fileAccess` list
 * — used only for the `isDirectory` proof, which is a fact about absolute
 * paths and must hold regardless of which subset is currently filtered in.
 */
export function buildScopeFileTree(
  entries: readonly FileAccessEntryLike[],
  allEntries: readonly FileAccessEntryLike[],
  scope: FileScope,
  cwd: string | undefined,
  home: string | undefined,
  matches?: MatchesByPath,
): FileTreeNode[] {
  const isDirectoryOf = (path: string): boolean => {
    const prefix = `${path}/`;
    return allEntries.some((other) => other.path.startsWith(prefix));
  };
  const root = emptyRawDir();
  for (const entry of entries) {
    insertEntry(root, scopeRelativeSegments(entry.path, scope, cwd, home), entry);
  }
  return finalizeChildren(scope, root, 0, [], isDirectoryOf, matches);
}

// ---------------------------------------------------------------------
// Sections — the three scope buckets, each with its own tree + fuzzy filter
// ---------------------------------------------------------------------

export interface ScopeSection {
  scope: FileScope;
  label: string;
  rootHint: string;
  /** File count for this section — the matched count while a filter query is active, the full bucket count otherwise. */
  fileCount: number;
  nodes: FileTreeNode[];
}

const SCOPE_ORDER: readonly FileScope[] = ["repo", "home", "system"];

/**
 * Split `entries` into Repository / Home / System sections (in that order,
 * empty sections omitted), each carrying its own compact tree. When `query`
 * is non-empty, every section is rebuilt from ONLY its fuzzy-matching files
 * (see `fuzzyMatch`) — matched against each file's scope-relative display
 * path — so directory aggregates, section counts, and tree shape all
 * reflect the filtered set; a section with zero matches is dropped entirely
 * rather than rendered empty.
 */
export function buildFileScopeSections(
  entries: readonly FileAccessEntryLike[],
  cwd: string | undefined,
  query: string,
): ScopeSection[] {
  const home = homeGuess(cwd);
  const buckets: Record<FileScope, FileAccessEntryLike[]> = { repo: [], home: [], system: [] };
  for (const entry of entries) {
    buckets[scopeOf(entry.path, cwd, home)].push(entry);
  }

  const trimmedQuery = query.trim();
  const sections: ScopeSection[] = [];
  for (const scope of SCOPE_ORDER) {
    const bucket = buckets[scope];
    if (bucket.length === 0) continue;

    if (trimmedQuery === "") {
      sections.push({
        scope,
        label: SCOPE_LABEL[scope],
        rootHint: rootHintFor(scope, cwd),
        fileCount: bucket.length,
        nodes: buildScopeFileTree(bucket, entries, scope, cwd, home),
      });
      continue;
    }

    const matches = new Map<string, { displayPath: string; indices: readonly number[] }>();
    for (const entry of bucket) {
      const displayPath = scopeRelativeSegments(entry.path, scope, cwd, home).join("/");
      const indices = fuzzyMatch(displayPath, trimmedQuery);
      if (indices !== undefined) matches.set(entry.path, { displayPath, indices });
    }
    if (matches.size === 0) continue;

    sections.push({
      scope,
      label: SCOPE_LABEL[scope],
      rootHint: rootHintFor(scope, cwd),
      fileCount: matches.size,
      nodes: buildScopeFileTree(
        bucket.filter((e) => matches.has(e.path)),
        entries,
        scope,
        cwd,
        home,
        matches,
      ),
    });
  }
  return sections;
}

// ---------------------------------------------------------------------
// Flatten — sections + trees into the flat row list `FileAccessTree`
// actually maps over (mirrors the old `buildFileTreeRows` shape, extended
// with a `section` row kind and per-dir collapse state).
// ---------------------------------------------------------------------

export type VisibleRow =
  | {
      kind: "section";
      key: string;
      scope: FileScope;
      label: string;
      rootHint: string;
      fileCount: number;
    }
  | (FileTreeDirRow & { collapsed: boolean })
  | FileTreeFileRow;

/**
 * Flatten `sections` into the rows `FileAccessTree` renders, honoring
 * `collapsed` (a dir row's own `key`) — EXCEPT while `filtering`, when every
 * directory renders force-expanded regardless of `collapsed` (matched
 * ancestors must stay visible, and collapse toggles are inert during a
 * filter — see `FileAccessTree`).
 */
export function flattenSections(
  sections: readonly ScopeSection[],
  collapsed: ReadonlySet<string>,
  filtering: boolean,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const section of sections) {
    rows.push({
      kind: "section",
      key: `scope:${section.scope}`,
      scope: section.scope,
      label: section.label,
      rootHint: section.rootHint,
      fileCount: section.fileCount,
    });
    flattenNodes(section.nodes, collapsed, filtering, rows);
  }
  return rows;
}

function flattenNodes(
  nodes: readonly FileTreeNode[],
  collapsed: ReadonlySet<string>,
  filtering: boolean,
  out: VisibleRow[],
): void {
  for (const node of nodes) {
    if (node.kind === "dir") {
      const isCollapsed = !filtering && collapsed.has(node.key);
      out.push({ ...node, collapsed: isCollapsed });
      if (!isCollapsed) flattenNodes(node.children, collapsed, filtering, out);
    } else {
      out.push(node);
    }
  }
}

/** Basename for path-like subjects, else the first 40 chars — repetition-findings panel. */
export function shortSubject(subject: string): string {
  if (subject.includes("/")) {
    const parts = subject.split("/");
    return parts[parts.length - 1] || subject;
  }
  return subject.slice(0, 40);
}
