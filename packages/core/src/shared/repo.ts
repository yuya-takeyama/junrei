/** `deriveRepoIdentity`'s result — see its doc comment for the derivation rules. */
export interface RepoIdentity {
  repoRoot?: string;
  worktreeName?: string;
}

const WORKTREE_MARKER = "/.claude/worktrees/";

/**
 * Derive Junrei's repo-level grouping key from a session's `cwd`.
 *
 * Claude Code creates a git worktree per task under
 * `<repo>/.claude/worktrees/<name>`, and each worktree gets its own session
 * "project" — without this, one repo's sessions splinter across every
 * worktree it ever used, making repo-level cost analysis impossible.
 *
 * This is a heuristic over `cwd` alone (transcripts carry no actual git-root
 * metadata): a `cwd` under `<repo>/.claude/worktrees/<name>` yields that
 * `<repo>` as `repoRoot` and `<name>` as `worktreeName`; anything else is
 * treated as its own repo root with no worktree.
 */
export function deriveRepoIdentity(cwd: string | undefined): RepoIdentity {
  if (cwd === undefined || cwd === "") return {};
  // Tolerate a trailing slash without letting it collapse a bare "/" cwd.
  const trimmed = cwd.replace(/\/+$/, "") || cwd;

  const markerIndex = trimmed.indexOf(WORKTREE_MARKER);
  if (markerIndex === -1) return { repoRoot: trimmed };

  const repoRoot = trimmed.slice(0, markerIndex);
  const rest = trimmed.slice(markerIndex + WORKTREE_MARKER.length);
  const worktreeName = rest.split("/")[0];
  // `<root>/.claude/worktrees/` with nothing after it — no name segment, so
  // there's no worktree to name; fall back to treating cwd as the repo root.
  if (worktreeName === undefined || worktreeName === "") return { repoRoot: trimmed };

  return { repoRoot, worktreeName };
}
