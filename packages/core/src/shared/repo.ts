/** `deriveRepoIdentity`'s result — see its doc comment for the derivation rules. */
export interface RepoIdentity {
  repoRoot?: string;
  worktreeName?: string;
}

const CLAUDE_WORKTREE_MARKER = "/.claude/worktrees/";
const CODEX_WORKTREE_MARKER = "/.codex/worktrees/";

/**
 * Derive Junrei's repo-level grouping key from a session's `cwd`.
 *
 * Claude Code creates a git worktree per task under
 * `<repo>/.claude/worktrees/<name>`, and each worktree gets its own session
 * "project" — without this, one repo's sessions splinter across every
 * worktree it ever used, making repo-level cost analysis impossible.
 *
 * Codex Desktop does the same but with a CENTRAL layout:
 * `$CODEX_HOME/worktrees/<hash>/<repoName>`. Unlike Claude's, that path does
 * not contain the parent repo's location at all, so no `repoRoot` can be
 * derived from `cwd` — the session gets only `worktreeName` (the `<hash>`
 * segment) here, and the server resolves a real `repoRoot` from the
 * session's recorded `git.repository_url` instead (see the server's
 * `sources/codex.ts`).
 *
 * This is a heuristic over `cwd` alone (transcripts carry no actual git-root
 * metadata): a `cwd` under `<repo>/.claude/worktrees/<name>` yields that
 * `<repo>` as `repoRoot` and `<name>` as `worktreeName`; a `cwd` under
 * `/.codex/worktrees/<hash>/<repoName>` yields only `worktreeName`; anything
 * else is treated as its own repo root with no worktree.
 */
export function deriveRepoIdentity(cwd: string | undefined): RepoIdentity {
  if (cwd === undefined || cwd === "") return {};
  // Tolerate a trailing slash without letting it collapse a bare "/" cwd.
  const trimmed = cwd.replace(/\/+$/, "") || cwd;

  // Codex first: a `.claude/worktrees` path nested INSIDE a Codex worktree is
  // still a Codex worktree (its true repo root is unknowable from cwd), while
  // the reverse nesting can't occur — Codex never creates its central
  // worktree dir inside a repo.
  const codexIndex = trimmed.indexOf(CODEX_WORKTREE_MARKER);
  if (codexIndex !== -1) {
    const rest = trimmed.slice(codexIndex + CODEX_WORKTREE_MARKER.length);
    const [hash = "", repoName = ""] = rest.split("/");
    // Need both `<hash>/<repoName>` segments to call it a worktree checkout;
    // a cwd AT the hash dir (or the bare worktrees dir) isn't one.
    if (hash !== "" && repoName !== "") return { worktreeName: hash };
    return { repoRoot: trimmed };
  }

  const markerIndex = trimmed.indexOf(CLAUDE_WORKTREE_MARKER);
  if (markerIndex === -1) return { repoRoot: trimmed };

  const repoRoot = trimmed.slice(0, markerIndex);
  const rest = trimmed.slice(markerIndex + CLAUDE_WORKTREE_MARKER.length);
  const worktreeName = rest.split("/")[0];
  // `<root>/.claude/worktrees/` with nothing after it — no name segment, so
  // there's no worktree to name; fall back to treating cwd as the repo root.
  if (worktreeName === undefined || worktreeName === "") return { repoRoot: trimmed };

  return { repoRoot, worktreeName };
}

/**
 * Canonical form of a git remote URL for use as a grouping key: trailing
 * slashes and a trailing `.git` are dropped, so `https://github.com/x/y`,
 * `https://github.com/x/y.git`, and `https://github.com/x/y/` all key
 * identically (Codex records whichever form the clone happened to use).
 */
export function normalizeRepoUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith(".git") ? trimmed.slice(0, -".git".length) : trimmed;
}
