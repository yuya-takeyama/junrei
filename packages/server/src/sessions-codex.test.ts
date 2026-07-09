import { utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCodexSession, listSessions } from "./sessions.js";

// Mirrors app.test.ts's CLAUDE_CONFIG_DIR pattern: point both env vars at
// fixture trees so resolveProjectsDirs/resolveCodexHome (both read per-call,
// not cached at module load) resolve the same fixtures across every test.
const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);
const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");

// Git does not preserve mtimes, so a fresh checkout (CI) would give every
// fixture the same checkout-time mtime. The merge-order tests below need a
// deterministic Claude/Codex interleaving, so stamp it explicitly.
const FIXTURE_MTIMES: Array<[string, number]> = [
  [
    join(
      CLAUDE_FIXTURES_DIR,
      "projects/-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
    ),
    1_767_193_260,
  ],
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/01/rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
    ),
    1_767_193_320,
  ],
  [
    join(
      CLAUDE_FIXTURES_DIR,
      "projects/-Users-test-proj/22222222-2222-2222-2222-222222222222.jsonl",
    ),
    1_767_193_380,
  ],
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/02/rollout-2026-07-02T09-00-00-22222222-2222-2222-2222-222222222222.jsonl",
    ),
    1_767_193_440,
  ],
  [
    join(
      CLAUDE_FIXTURES_DIR,
      "projects/-Users-test-proj/33333333-3333-3333-3333-333333333333.jsonl",
    ),
    1_767_193_500,
  ],
  [
    join(
      CODEX_HOME,
      "archived_sessions/rollout-2026-07-02T09-30-00-33333333-3333-3333-3333-333333333333.jsonl",
    ),
    1_767_193_560,
  ],
  // Archived duplicate of the live 11111111 session, deliberately NEWER than
  // the live copy — the dedup must still prefer the live one.
  [
    join(
      CODEX_HOME,
      "archived_sessions/rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
    ),
    1_767_193_999,
  ],
];

async function stampFixtureMtimes() {
  await Promise.all(FIXTURE_MTIMES.map(([path, epoch]) => utimes(path, epoch, epoch)));
}

describe("listSessions (source filter + Codex merge)", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;

  beforeAll(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
    await stampFixtureMtimes();
  });

  afterAll(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("source: 'codex' lists only Codex sessions, skipping the legacy-format fixture", async () => {
    const items = await listSessions(50, "codex");
    expect(items.length).toBe(3); // 11111111, 22222222, 33333333 (archived) — 44444444 is legacy, skipped.
    for (const item of items) {
      expect(item.source).toBe("codex");
      expect(item.projectDirName).toBe("codex");
      expect(item.subagentCount).toBe(0);
    }
    expect(items.some((i) => i.sessionId === "44444444-4444-4444-4444-444444444444")).toBe(false);
  });

  it("dedups a session present both live and archived — live wins even when archived is newer", async () => {
    const items = await listSessions(50, "codex");
    const copies = items.filter((i) => i.sessionId === "11111111-1111-1111-1111-111111111111");
    expect(copies).toHaveLength(1);
    expect(copies[0] && "archived" in copies[0] && copies[0].archived).toBe(false);
  });

  it("source: 'codex' reports archived: true only for the archived_sessions fixture", async () => {
    const items = await listSessions(50, "codex");
    const archived = items.find((i) => i.sessionId === "33333333-3333-3333-3333-333333333333");
    const live = items.find((i) => i.sessionId === "11111111-1111-1111-1111-111111111111");
    expect(archived?.source).toBe("codex");
    expect(archived && "archived" in archived && archived.archived).toBe(true);
    expect(live && "archived" in live && live.archived).toBe(false);
  });

  it("source: 'claude-code' lists only Claude sessions (unchanged behavior)", async () => {
    const items = await listSessions(50, "claude-code");
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.source).toBe("claude-code");
    }
  });

  it('source "all" merges both sets, newest first by file mtime, limit applied after the merge', async () => {
    // Fixture mtimes (see the test setup that touches these files) interleave
    // Claude and Codex sessions: codex-33333333(archived) > claude-33333333 >
    // codex-22222222 > claude-22222222 > codex-11111111 > claude-11111111.
    const all = await listSessions(50, "all");
    expect(all.length).toBe(6);
    expect(all.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "codex:33333333",
      "claude-code:33333333",
      "codex:22222222",
      "claude-code:22222222",
      "codex:11111111",
      "claude-code:11111111",
    ]);

    // limit=3 must cut the *merged* series, not take 3 from each source first.
    const limited = await listSessions(3, "all");
    expect(limited.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "codex:33333333",
      "claude-code:33333333",
      "codex:22222222",
    ]);
  });

  it("source omitted stays Claude-only (pre-Codex clients see unchanged behavior)", async () => {
    const items = await listSessions(50);
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.source).toBe("claude-code");
    }
  });

  it("missing CODEX_HOME yields zero Codex items, no error", async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(CODEX_HOME, "does-not-exist");
    try {
      const items = await listSessions(50, "codex");
      expect(items).toEqual([]);
    } finally {
      process.env.CODEX_HOME = previous;
    }
  });
});

describe("getCodexSession", () => {
  let previousCodexHome: string | undefined;

  beforeAll(() => {
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = CODEX_HOME;
  });

  afterAll(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("returns the full CodexSessionAnalysis for a known session id", async () => {
    const analysis = await getCodexSession("11111111-1111-1111-1111-111111111111");
    expect(analysis).toBeDefined();
    expect(analysis?.source).toBe("codex");
    expect(analysis?.codex.originator).toBe("codex_cli_rs");
  });

  it("returns undefined for an unknown session id", async () => {
    const analysis = await getCodexSession("does-not-exist");
    expect(analysis).toBeUndefined();
  });

  it("returns undefined for a legacy-format transcript", async () => {
    const analysis = await getCodexSession("44444444-4444-4444-4444-444444444444");
    expect(analysis).toBeUndefined();
  });
});
