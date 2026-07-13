import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoKeyOf } from "./overview.js";
import { getCodexSession, listSessions } from "./sessions.js";

// Codex Desktop runs each task in `$CODEX_HOME/worktrees/<hash>/<repoName>` —
// a cwd carrying no trace of the parent repo's path — so repo identity for
// those sessions is resolved from `session_meta.git.repository_url`, anchored
// by sessions that ran at the repo's real path (see sources/codex.ts's
// `buildRepoRootByUrl`). This suite builds its own scratch CODEX_HOME instead
// of extending test/fixtures/codex-home, whose session counts other suites
// assert exactly.

const ANCHOR_ID = "aaaa0000-0000-0000-0000-000000000001";
const ANCHOR2_ID = "aaaa0000-0000-0000-0000-000000000005";
const SUBDIR_ID = "aaaa0000-0000-0000-0000-000000000002";
const TMP_CLONE_ID = "aaaa0000-0000-0000-0000-000000000006";
const WORKTREE_ID = "aaaa0000-0000-0000-0000-000000000003";
const LONELY_ID = "aaaa0000-0000-0000-0000-000000000004";

/** Minimal current-format rollout: session_meta + one prompt + one token_count. */
function rollout(id: string, cwd: string, repositoryUrl: string): string {
  const meta = {
    timestamp: "2026-07-05T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      cwd,
      originator: "Codex Desktop",
      cli_version: "0.128.0",
      source: "vscode",
      git: { branch: "main", commit_hash: "abc123", repository_url: repositoryUrl },
    },
  };
  const prompt = {
    timestamp: "2026-07-05T10:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "hello" },
  };
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: 110,
  };
  const tokens = {
    timestamp: "2026-07-05T10:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage, last_token_usage: usage },
    },
  };
  return `${[meta, prompt, tokens].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

let scratchCodexHome: string;
let previousCodexHome: string | undefined;
let previousConfigDir: string | undefined;

beforeAll(async () => {
  scratchCodexHome = await mkdtemp(join(tmpdir(), "junrei-codex-repo-"));
  const day = join(scratchCodexHome, "sessions/2026/07/05");
  await mkdir(day, { recursive: true });
  await Promise.all([
    // Anchors (x2): ran at the repo's real path; the first records the
    // `.git`-suffixed URL form, which must still anchor the suffix-less form
    // via normalization. Two sessions make this the MOST-USED root, which is
    // what the map selects.
    writeFile(
      join(day, `rollout-2026-07-05T10-00-00-${ANCHOR_ID}.jsonl`),
      rollout(ANCHOR_ID, "/Users/test/anchor-repo", "https://github.com/test/anchor-repo.git"),
    ),
    writeFile(
      join(day, `rollout-2026-07-05T10-00-04-${ANCHOR2_ID}.jsonl`),
      rollout(ANCHOR2_ID, "/Users/test/anchor-repo", "https://github.com/test/anchor-repo"),
    ),
    // Same repo but run in a subdirectory — a rarer root that must not win.
    writeFile(
      join(day, `rollout-2026-07-05T10-00-01-${SUBDIR_ID}.jsonl`),
      rollout(
        SUBDIR_ID,
        "/Users/test/anchor-repo/packages/web",
        "https://github.com/test/anchor-repo",
      ),
    ),
    // One-off clone of the same repo at a SHORTER path (regression: observed
    // /private/tmp review clones hijacking the map when "shortest path" was
    // the selection rule) — rarer, so it must lose to the real checkout.
    writeFile(
      join(day, `rollout-2026-07-05T10-00-05-${TMP_CLONE_ID}.jsonl`),
      rollout(TMP_CLONE_ID, "/tmp/anchor-clone", "https://github.com/test/anchor-repo"),
    ),
    // Central-worktree session of the same repo: no repoRoot from cwd; must
    // adopt the anchor's path via the shared repository URL.
    writeFile(
      join(day, `rollout-2026-07-05T10-00-02-${WORKTREE_ID}.jsonl`),
      rollout(
        WORKTREE_ID,
        "/Users/test/.codex/worktrees/ab12/anchor-repo",
        "https://github.com/test/anchor-repo",
      ),
    ),
    // Worktree session whose URL has no anchoring checkout at all.
    writeFile(
      join(day, `rollout-2026-07-05T10-00-03-${LONELY_ID}.jsonl`),
      rollout(
        LONELY_ID,
        "/Users/test/.codex/worktrees/cd34/lonely-repo",
        "https://github.com/test/lonely-repo.git",
      ),
    ),
  ]);
  previousCodexHome = process.env.CODEX_HOME;
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = scratchCodexHome;
  // Point Claude at the (session-less) scratch dir too so this suite never
  // depends on the developer's real ~/.claude contents.
  process.env.CLAUDE_CONFIG_DIR = scratchCodexHome;
});

afterAll(async () => {
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  await rm(scratchCodexHome, { recursive: true, force: true });
});

describe("Codex repo identity (URL-anchored repoRoot)", () => {
  it("resolves a worktree session's repoRoot from an anchoring real-path session", async () => {
    const { sessions } = await listSessions(50, "codex");
    const worktree = sessions.find((s) => s.sessionId === WORKTREE_ID);
    expect(worktree?.repoRoot).toBe("/Users/test/anchor-repo");
    expect(worktree?.worktreeName).toBe("ab12");
    expect(worktree && "repoUrl" in worktree && worktree.repoUrl).toBe(
      "https://github.com/test/anchor-repo",
    );
    // Same grouping key as the anchor — the whole point of the resolution.
    const anchor = sessions.find((s) => s.sessionId === ANCHOR_ID);
    expect(anchor && worktree && repoKeyOf(worktree)).toBe(anchor && repoKeyOf(anchor));
  });

  it("prefers the most-used anchoring path over rarer subdir/one-off-clone roots", async () => {
    const { sessions } = await listSessions(50, "codex");
    // The subdir and tmp-clone sessions keep their own cwd-derived repoRoots…
    const subdir = sessions.find((s) => s.sessionId === SUBDIR_ID);
    expect(subdir?.repoRoot).toBe("/Users/test/anchor-repo/packages/web");
    const tmpClone = sessions.find((s) => s.sessionId === TMP_CLONE_ID);
    expect(tmpClone?.repoRoot).toBe("/tmp/anchor-clone");
    // …but neither displaces the twice-used real checkout in the URL map —
    // not even the tmp clone, whose path is SHORTER than the real one.
    const worktree = sessions.find((s) => s.sessionId === WORKTREE_ID);
    expect(worktree?.repoRoot).toBe("/Users/test/anchor-repo");
  });

  it("buckets an unanchored worktree session by its normalized URL", async () => {
    const { sessions } = await listSessions(50, "codex");
    const lonely = sessions.find((s) => s.sessionId === LONELY_ID);
    expect(lonely?.repoRoot).toBeUndefined();
    expect(lonely && "repoUrl" in lonely && lonely.repoUrl).toBe(
      "https://github.com/test/lonely-repo",
    );
    expect(lonely && repoKeyOf(lonely)).toBe("codex-repo:https://github.com/test/lonely-repo");
  });

  it("applies the same URL-anchored repoRoot on the session detail", async () => {
    const detail = await getCodexSession(WORKTREE_ID);
    expect(detail?.repoRoot).toBe("/Users/test/anchor-repo");
    expect(detail?.worktreeName).toBe("ab12");
  });
});
