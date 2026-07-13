import type { SessionListItem } from "./api.js";
import { formatProject } from "./format.js";
import type { SourceTab } from "./router.js";

/**
 * Query params for `GET /api/sessions` given the active source tab — pulled
 * out of `SessionList` so the "which source did we actually ask the server
 * for" decision is independently testable without mocking `fetch`/the Hono
 * RPC client. `SourceTab` already matches the server's `source` query values
 * 1:1 (`"all" | "claude-code" | "codex"`), so this is mostly identity, but
 * keeping it a named function documents that the web always passes `source`
 * explicitly now — omitting it would silently fall back to Claude-only on
 * the server (see `sessions.ts`'s `listSessions` default).
 */
export function sessionsListQuery(
  tab: SourceTab,
  limit: string,
  offset: string,
): { limit: string; offset: string; source: SourceTab } {
  return { limit, offset, source: tab };
}

/**
 * Subagent-count cell text — shows the real count for both harnesses now
 * that Codex sub-agent threads have a real count too (see
 * `codex/orchestration.ts` in `@junrei/core`); a literal "0" still reads
 * as "checked, found none" rather than "not applicable", so both sources
 * fall back to an em dash for the common no-delegation case instead.
 */
export function subagentCellText(item: SessionListItem): string {
  return item.subagentCount > 0 ? String(item.subagentCount) : "—";
}

/** Compact per-row source label for the "All" tab's badge column — a lookup, extended per new source. */
const SOURCE_BADGE_LABEL: Record<SessionListItem["source"], string> = {
  "claude-code": "Claude",
  codex: "Codex",
};

export function sourceBadgeLabel(source: SessionListItem["source"]): string {
  return SOURCE_BADGE_LABEL[source];
}

/**
 * Project-filter grouping key for one row. Claude rows group by their real
 * `projectDirName`; Codex rows (which have no project-dir concept — see
 * `CodexSessionListItem` on the server, which dropped the `projectDirName:
 * "codex"` sentinel it used to carry) group under the fixed label `"codex"`
 * instead, preserving the same dropdown entry ("project: codex") and filter
 * behavior the old sentinel produced, just via an explicit source-branch
 * here rather than a fake data field on the list item.
 */
export function projectFilterKey(item: SessionListItem): string {
  return item.source === "codex" ? "codex" : item.projectDirName;
}

// Fallback-bucket key prefixes for sessions with no `repoRoot` (pre-#36 data,
// or a `cwd` the `.claude/worktrees/<name>` heuristic never matched). Real
// `repoRoot` values are always absolute paths (start with "/"), so a
// non-path prefix here can never collide with one.
const CLAUDE_FALLBACK_PREFIX = "claude-project:";
const CODEX_FALLBACK_PREFIX = "codex-cwd:";
const UNKNOWN_CWD = "(unknown cwd)";

/**
 * Repo-level grouping/filter key for one session-list row — the replacement
 * for `projectFilterKey` now that sessions carry `repoRoot`/`worktreeName`
 * (see `@junrei/core`'s `deriveRepoIdentity`). A worktree session's
 * `repoRoot` points at its *parent* repo, so it collapses into the same key
 * as sessions run at the repo root itself — that collapsing is the entire
 * point of the repo filter (dogfooding showed one repo splintering into a
 * dropdown entry per worktree). Sessions with no `repoRoot` at all fall back
 * to a distinct bucket per `projectDirName` (Claude) or `cwd` (Codex, with a
 * fixed sentinel when even `cwd` is missing) so they still surface as a
 * filterable option instead of silently disappearing from the dropdown.
 */
export function repoFilterKey(item: SessionListItem): string {
  if (item.repoRoot !== undefined) return item.repoRoot;
  return item.source === "codex"
    ? `${CODEX_FALLBACK_PREFIX}${item.cwd ?? UNKNOWN_CWD}`
    : `${CLAUDE_FALLBACK_PREFIX}${item.projectDirName}`;
}

/** One entry in the session-list repo dropdown — see `repoOptionsFor`. */
export interface RepoOption {
  /** Filter key (see `repoFilterKey`) and `?repo=` URL param value. */
  key: string;
  /** Short display label — a disambiguated basename for a real repo, the best available identifier otherwise. */
  label: string;
  /** Full identifier (repoRoot / cwd / projectDirName) shown as a tooltip. */
  title: string;
}

/** Last non-empty `/`-segment of `path`, or `path` itself if it has none (e.g. empty string). */
function lastPathSegment(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

/**
 * Assigns each of `paths` (assumed pairwise distinct) a short unique label:
 * its basename, extended one leading path segment at a time until it no
 * longer collides with any other input's same-depth tail. Two repos that
 * happen to share a basename (e.g. `/Users/a/junrei` and
 * `/Users/b/junrei`) disambiguate to `a/junrei` and `b/junrei` instead of
 * both showing the bare, ambiguous `junrei`.
 */
export function disambiguateBasenames(paths: readonly string[]): Map<string, string> {
  const segmented = paths.map((p) => p.split("/").filter((seg) => seg !== ""));
  const tailAt = (segs: readonly string[], depth: number): string => segs.slice(-depth).join("/");

  const labels = new Map<string, string>();
  paths.forEach((path, i) => {
    const segs = segmented[i] ?? [];
    let depth = 1;
    while (
      depth < segs.length &&
      segmented.some((other, j) => j !== i && tailAt(other, depth) === tailAt(segs, depth))
    ) {
      depth += 1;
    }
    labels.set(path, tailAt(segs, depth) || path);
  });
  return labels;
}

/**
 * Derives the session-list repo dropdown's options from the currently loaded
 * sessions — one entry per distinct `repoFilterKey`, sorted by label. Real
 * repos get a disambiguated basename label (see `disambiguateBasenames`);
 * fallback buckets (no `repoRoot`) get the best identifier they have, via the
 * same "shorten a path/dir-name" logic `formatProject` already uses for the
 * row display.
 */
export function repoOptionsFor(sessions: readonly SessionListItem[]): RepoOption[] {
  const representative = new Map<string, SessionListItem>();
  for (const s of sessions) {
    const key = repoFilterKey(s);
    if (!representative.has(key)) representative.set(key, s);
  }

  const repoRoots = [...representative.values()]
    .map((s) => s.repoRoot)
    .filter((r): r is string => r !== undefined);
  const disambiguated = disambiguateBasenames(repoRoots);

  const options = [...representative.entries()].map(([key, item]): RepoOption => {
    if (item.repoRoot !== undefined) {
      return {
        key,
        label: disambiguated.get(item.repoRoot) ?? lastPathSegment(item.repoRoot),
        title: item.repoRoot,
      };
    }
    if (item.source === "codex") {
      const cwd = item.cwd;
      return {
        key,
        label: cwd !== undefined ? formatProject("", cwd) : UNKNOWN_CWD,
        title: cwd ?? UNKNOWN_CWD,
      };
    }
    return { key, label: formatProject(item.projectDirName), title: item.projectDirName };
  });

  return options.sort((a, b) => a.label.localeCompare(b.label));
}
