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
  // Orchestration fixtures (see the "getCodexSession — sub-agent
  // orchestration" describe block below for the detailed forest/aggregation
  // assertions): 77777777 spawns 88888888
  // (Aquinas, depth 1), which spawns 99999999 (Scout, depth 2). Stamped
  // NEWER than every fixture above so the parent (77777777, the only one of
  // the three that's listable — the sub-agents are excluded) sorts first in
  // "all", without disturbing the interleaving asserted above.
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/03/rollout-2026-07-03T09-00-00-77777777-7777-7777-7777-777777777777.jsonl",
    ),
    1_767_194_100,
  ],
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/03/rollout-2026-07-03T09-00-05-88888888-8888-8888-8888-888888888888.jsonl",
    ),
    1_767_194_150,
  ],
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/03/rollout-2026-07-03T09-00-07-99999999-9999-9999-9999-999999999999.jsonl",
    ),
    1_767_194_200,
  ],
  // Orphaned sub-agent (thread_spawn parent 55555555 has no rollout in the
  // pool): must be rescued into the list, not silently dropped. Stamped
  // OLDEST so it appends to the end of the merged order asserted above.
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/01/rollout-2026-07-01T08-00-00-66666666-6666-6666-6666-666666666666.jsonl",
    ),
    1_767_193_100,
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

  it("source: 'codex' lists only Codex sessions, skipping the legacy-format fixture and excluding sub-agent sessions", async () => {
    const items = await listSessions(50, "codex");
    // 11111111, 22222222, 33333333 (archived), 77777777 (parent), 66666666
    // (orphaned sub-agent, rescued) — 44444444 is legacy, skipped;
    // 88888888/99999999 (77777777's sub-agents) are excluded from the list —
    // they surface inside 77777777's own subagentCount/Orchestration data
    // instead, same as Claude sidecars.
    expect(items.length).toBe(5);
    for (const item of items) {
      expect(item.source).toBe("codex");
    }
    expect(items.some((i) => i.sessionId === "44444444-4444-4444-4444-444444444444")).toBe(false);
    expect(items.some((i) => i.sessionId === "88888888-8888-8888-8888-888888888888")).toBe(false);
    expect(items.some((i) => i.sessionId === "99999999-9999-9999-9999-999999999999")).toBe(false);

    const leaf = items.find((i) => i.sessionId === "11111111-1111-1111-1111-111111111111");
    expect(leaf?.subagentCount).toBe(0);

    const parent = items.find((i) => i.sessionId === "77777777-7777-7777-7777-777777777777");
    expect(parent?.subagentCount).toBe(2); // Aquinas (depth 1) + Scout (depth 2)
  });

  it("rescues a sub-agent whose parent rollout is missing into the list instead of dropping it", async () => {
    const items = await listSessions(50, "codex");
    const orphan = items.find((i) => i.sessionId === "66666666-6666-6666-6666-666666666666");
    // Its thread_spawn parent (55555555…) has no rollout in the pool, so the
    // session would otherwise be invisible everywhere and its cost lost.
    expect(orphan).toBeDefined();
    expect(orphan?.subagentCount).toBe(0);
    expect(orphan?.firstUserPrompt).toBe("Orphaned sub-agent prompt");
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
    // Claude and Codex sessions: codex-77777777 (newest — the orchestration
    // parent fixture) > codex-33333333(archived) > claude-33333333 >
    // codex-22222222 > claude-22222222 > codex-11111111 > claude-11111111 >
    // codex-66666666 (oldest — the rescued orphan sub-agent).
    // 88888888/99999999 don't appear — they're 77777777's sub-agents,
    // excluded from the list.
    const all = await listSessions(50, "all");
    expect(all.length).toBe(8);
    expect(all.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "codex:77777777",
      "codex:33333333",
      "claude-code:33333333",
      "codex:22222222",
      "claude-code:22222222",
      "codex:11111111",
      "claude-code:11111111",
      "codex:66666666",
    ]);

    // limit=3 must cut the *merged* series, not take 3 from each source first.
    const limited = await listSessions(3, "all");
    expect(limited.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "codex:77777777",
      "codex:33333333",
      "claude-code:33333333",
    ]);
  });

  it('source omitted means "all" (no back-compat Claude-only default)', async () => {
    const items = await listSessions(50);
    const all = await listSessions(50, "all");
    expect(items.length).toBe(all.length);
    expect(items.some((i) => i.source === "codex")).toBe(true);
    expect(items.some((i) => i.source === "claude-code")).toBe(true);
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
    // No sub-agents — this fixture is a leaf session.
    expect(analysis?.subagents).toEqual([]);
    expect(analysis?.subagentCount).toBe(0);
    // Files & skills lens data rides on the same SessionAnalysisCore fields
    // Claude uses — see codex/files-skills.ts. This fixture's one
    // custom_tool_call (apply_patch, updating foo.spec.ts) surfaces as a
    // main-only edit; it has no skill markers in either user_message.
    expect(analysis?.fileAccess).toEqual([
      expect.objectContaining({
        path: "/Users/test/codex-proj/foo.spec.ts",
        edits: 1,
        reads: 0,
        threads: "main",
      }),
    ]);
    expect(analysis?.skillInvocations).toEqual([]);
    // No sub-agent forest -> delegation's subagents slice is honestly zero.
    expect(analysis?.delegation.subagents).toEqual({
      tokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
    });
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

describe("getCodexSession — sub-agent orchestration (77777777 -> 88888888 -> 99999999)", () => {
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

  it("attaches the direct + nested sub-agent forest to the parent, with recursive subagentCount", async () => {
    const parent = await getCodexSession("77777777-7777-7777-7777-777777777777");
    expect(parent).toBeDefined();
    expect(parent?.subagents).toHaveLength(1);
    expect(parent?.subagentCount).toBe(2); // Aquinas (direct) + Scout (nested under Aquinas)

    const aquinas = parent?.subagents[0];
    expect(aquinas?.agentId).toBe("88888888-8888-8888-8888-888888888888");
    expect(aquinas?.description).toBe("Aquinas");
    expect(aquinas?.agentType).toBe("explorer");
    expect(aquinas?.children).toHaveLength(1);
    expect(aquinas?.children[0]?.agentId).toBe("99999999-9999-9999-9999-999999999999");
    expect(aquinas?.children[0]?.description).toBe("Scout");
  });

  it("recursively aggregates totalUsage/cost across the whole tree (Claude parity), without mutating the cached child analysis", async () => {
    const parent = await getCodexSession("77777777-7777-7777-7777-777777777777");
    const child = await getCodexSession("88888888-8888-8888-8888-888888888888");
    const grandchild = await getCodexSession("99999999-9999-9999-9999-999999999999");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(grandchild).toBeDefined();
    if (parent === undefined || child === undefined || grandchild === undefined) return;

    // Parent's recursive total = its own usage + child's own usage +
    // grandchild's own usage — exactly, not double-counted.
    const expectedInputTokens =
      parent.usage.total.inputTokens +
      child.usage.total.inputTokens +
      grandchild.usage.total.inputTokens;
    expect(parent.totalUsage.inputTokens).toBe(expectedInputTokens);
    expect(parent.totalUsage.costUsd).toBeGreaterThan(parent.usage.total.costUsd);

    // Fetching the parent doesn't mutate the child's OWN cached analysis:
    // the child's totalUsage independently aggregates only itself +
    // grandchild (not the parent's usage bleeding in).
    expect(child.totalUsage.inputTokens).toBe(
      child.usage.total.inputTokens + grandchild.usage.total.inputTokens,
    );
  });

  it("merges totalUsageByModel across the tree, including the sub-agents' own models", async () => {
    const parent = await getCodexSession("77777777-7777-7777-7777-777777777777");
    expect(parent).toBeDefined();
    if (parent === undefined) return;

    const models = parent.totalUsageByModel.map((m) => m.model);
    expect(models).toContain("gpt-5.5"); // parent's own turn_context model
    expect(models).toContain("gpt-5.5-explorer"); // Aquinas's model
    expect(models).toContain("gpt-5.5-mini"); // Scout's model
  });

  it("recomputes delegation at serve time from the forest-inclusive totals (not the parse-time own-thread value)", async () => {
    const parent = await getCodexSession("77777777-7777-7777-7777-777777777777");
    expect(parent).toBeDefined();
    if (parent === undefined) return;

    // Own-thread-only value (what `analyzeCodexSession` would have produced,
    // before this session's sub-agent forest was known) has NO delegated
    // tokens — the override must move it off that baseline.
    expect(parent.delegation.subagents.tokens).toBeGreaterThan(0);
    expect(parent.delegation.main.tokens).toBe(
      parent.usage.total.inputTokens +
        parent.usage.total.outputTokens +
        parent.usage.total.cacheReadTokens +
        parent.usage.total.cacheCreationTokens,
    );
    // gpt-5.5-explorer (Aquinas) never ran on the parent's own thread.
    const explorerSlice = parent.delegation.byModel.find((m) => m.model === "gpt-5.5-explorer");
    expect(explorerSlice?.main).toEqual({
      tokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
    });
    expect(explorerSlice?.subagents.tokens).toBeGreaterThan(0);
  });

  it("a sub-agent fetched directly still shows its OWN nested children (Aquinas -> Scout)", async () => {
    const aquinas = await getCodexSession("88888888-8888-8888-8888-888888888888");
    expect(aquinas).toBeDefined();
    expect(aquinas?.subagents).toHaveLength(1);
    expect(aquinas?.subagents[0]?.agentId).toBe("99999999-9999-9999-9999-999999999999");
    expect(aquinas?.subagentCount).toBe(1);
  });

  it("a leaf sub-agent (Scout, no further delegation) has an empty forest", async () => {
    const scout = await getCodexSession("99999999-9999-9999-9999-999999999999");
    expect(scout).toBeDefined();
    expect(scout?.subagents).toEqual([]);
    expect(scout?.subagentCount).toBe(0);
  });

  // Fixture file access, appended to the end of each rollout (after the
  // existing token/turn records the tests above depend on, so none of those
  // assertions shift): the parent (77777777) edits src/parent-only.ts, the
  // child Aquinas (88888888) edits src/auth.ts, and the grandchild Scout
  // (99999999) reads src/auth.ts (the same path Aquinas edited) plus its own
  // src/scout-only.ts. All three share one cwd
  // (/Users/test/orchestration-proj), so the resolved absolute paths line up
  // exactly across sessions — this is what actually exercises the merge.
  it("folds every descendant's fileAccess into the parent's, tagging a path only a descendant touched as 'subagent'", async () => {
    const parent = await getCodexSession("77777777-7777-7777-7777-777777777777");
    expect(parent).toBeDefined();
    if (parent === undefined) return;

    const parentOnly = parent.fileAccess.find(
      (e) => e.path === "/Users/test/orchestration-proj/src/parent-only.ts",
    );
    expect(parentOnly).toMatchObject({ edits: 1, reads: 0, threads: "main" });

    // Neither the parent nor Scout edited src/auth.ts directly — only Aquinas
    // (edit) and Scout (read) did, both descendants of the parent — so from
    // the PARENT's point of view this path is subagent-only.
    const auth = parent.fileAccess.find(
      (e) => e.path === "/Users/test/orchestration-proj/src/auth.ts",
    );
    expect(auth).toMatchObject({ edits: 1, reads: 1, threads: "subagent" });

    const scoutOnly = parent.fileAccess.find(
      (e) => e.path === "/Users/test/orchestration-proj/src/scout-only.ts",
    );
    expect(scoutOnly).toMatchObject({ edits: 0, reads: 1, threads: "subagent" });
  });

  it("tags a path as 'both' when the session itself AND a descendant touched it — fetched one level down (Aquinas + Scout)", async () => {
    const aquinas = await getCodexSession("88888888-8888-8888-8888-888888888888");
    expect(aquinas).toBeDefined();
    if (aquinas === undefined) return;

    // Aquinas edited src/auth.ts itself (main); Scout, its own descendant,
    // read the same path — combined, this is "both" from Aquinas's own
    // getCodexSession view (a different marker than the parent saw it as).
    const auth = aquinas.fileAccess.find(
      (e) => e.path === "/Users/test/orchestration-proj/src/auth.ts",
    );
    expect(auth).toMatchObject({ edits: 1, reads: 1, threads: "both" });

    const scoutOnly = aquinas.fileAccess.find(
      (e) => e.path === "/Users/test/orchestration-proj/src/scout-only.ts",
    );
    expect(scoutOnly).toMatchObject({ edits: 0, reads: 1, threads: "subagent" });
  });

  it("a leaf sub-agent's own fileAccess is untouched by aggregation — just its own reads, threads 'main'", async () => {
    const scout = await getCodexSession("99999999-9999-9999-9999-999999999999");
    expect(scout).toBeDefined();
    if (scout === undefined) return;

    expect(scout.fileAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/Users/test/orchestration-proj/src/auth.ts",
          reads: 1,
          edits: 0,
          threads: "main",
        }),
        expect.objectContaining({
          path: "/Users/test/orchestration-proj/src/scout-only.ts",
          reads: 1,
          edits: 0,
          threads: "main",
        }),
      ]),
    );
  });
});
