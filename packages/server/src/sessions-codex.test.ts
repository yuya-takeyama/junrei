import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCodexSession, listSessions } from "./sessions.js";

// Mirrors app.test.ts's CLAUDE_CONFIG_DIR pattern: point both env vars at
// fixture trees so resolveClaudeProjectsDirs/resolveCodexHome (both read per-call,
// not cached at module load) resolve the same fixtures across every test.
const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);
const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");

// Git does not preserve mtimes, so a fresh checkout (CI) would give every
// fixture the same checkout-time mtime. The list itself sorts by session
// START time (`startedAt` from the transcript), but mtimes still matter in
// two places the tests below exercise: the Claude adapter picks WHICH
// transcripts to analyze for a page by a file-timestamp proxy
// (min(birthtime, mtime) — see `startProxyMs` in sources/claude.ts), and
// `listCodexRefs` breaks live/archived duplicates by mtime. Keep the Claude
// stamps in the same relative order as the fixtures' `startedAt` values so
// the proxy window never excludes a session the real order would include.
//
// The stamps are applied to a TEMP COPY of both fixture trees, never to the
// checked-in files: `startProxyMs` is min(birthtime, mtime), and APFS
// permanently drags a file's birthtime down to any past mtime it is ever
// stamped with — a checkout that once ran an older FIXTURE_MTIMES table
// keeps the old, lower birthtime forever and silently reorders the proxy
// window. The copies are made by rewriting each file's contents rather than
// fs.cp, because on APFS fs.cp preserves the SOURCE's (possibly
// dragged-down) birthtime and utimes can never raise it back. A rewritten
// copy is a genuinely new inode born "now", so the proxy always equals the
// stamped mtime; copying also stops this suite from mutating fixtures
// shared with app.test.ts.
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
  // (Aquinas, depth 1), which spawns 99999999 (Scout, depth 2). Only the
  // parent (77777777) is listable — the sub-agents are excluded — and its
  // 2026-07-03 startedAt makes it the newest Codex row in "all".
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
  // pool): must be rescued into the list, not silently dropped. Its
  // 2026-07-01T08:00 startedAt is the oldest of the Codex fixtures, so it
  // sorts last in the merged order asserted below.
  [
    join(
      CODEX_HOME,
      "sessions/2026/07/01/rollout-2026-07-01T08-00-00-66666666-6666-6666-6666-666666666666.jsonl",
    ),
    1_767_193_100,
  ],
  // Skill-injection fixture (core issue #27). Its transcript starts at
  // 2026-07-09T04:00 — the NEWEST startedAt of every fixture — so its stamp
  // must rank first among the Claude files too, or the proxy-ordered
  // analysis window (limit=3 in the merge test below) would skip the very
  // session the start-time order puts on page one.
  [
    join(
      CLAUDE_FIXTURES_DIR,
      "projects/-Users-test-proj/44444444-4444-4444-4444-444444444445.jsonl",
    ),
    1_767_193_520,
  ],
];

async function copyTreeRewrite(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyTreeRewrite(from, to);
      } else {
        await writeFile(to, await readFile(from));
      }
    }),
  );
}

async function stampFixtureMtimes(claudeRoot: string, codexRoot: string) {
  await Promise.all(
    FIXTURE_MTIMES.map(async ([source, epoch]) => {
      const copy = source.startsWith(CODEX_HOME)
        ? join(codexRoot, relative(CODEX_HOME, source))
        : join(claudeRoot, relative(CLAUDE_FIXTURES_DIR, source));
      // "Fresh copies are born now" does NOT hold on APFS: fs.cp clones, so
      // the copy inherits the SOURCE file's birthtime — which, on a checkout
      // that ever ran the old in-place stamping, is permanently dragged below
      // these stamps and would rank the file last in the startProxyMs order.
      // Recreate the file as a genuinely new inode (born now) so the utimes
      // stamp below drags its birthtime down to exactly `epoch`.
      const content = await readFile(copy);
      await rm(copy);
      await writeFile(copy, content);
      await utimes(copy, epoch, epoch);
    }),
  );
}

let scratchDir: string;
let scratchClaudeDir: string;
let scratchCodexHome: string;

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "junrei-session-fixtures-"));
  scratchClaudeDir = join(scratchDir, "claude");
  scratchCodexHome = join(scratchDir, "codex-home");
  await Promise.all([
    copyTreeRewrite(CLAUDE_FIXTURES_DIR, scratchClaudeDir),
    copyTreeRewrite(CODEX_HOME, scratchCodexHome),
  ]);
  // Thread-name index (see loadCodexSessionIndexTitles): 22222222 has no
  // thread_name_updated event in its rollout (newer Codex never writes one),
  // 11111111 has one ("Fix flaky test") that this index entry must BEAT (a
  // post-session rename only touches the index). 33333333 is deliberately
  // absent so a session with neither source stays title-less.
  await writeFile(
    join(scratchCodexHome, "session_index.jsonl"),
    [
      '{"id":"22222222-2222-2222-2222-222222222222","thread_name":"Index-only thread name","updated_at":"2026-07-02T09:05:00Z"}',
      '{"id":"11111111-1111-1111-1111-111111111111","thread_name":"Renamed in Codex UI","updated_at":"2026-07-05T00:00:00Z"}',
      "",
    ].join("\n"),
  );
  await stampFixtureMtimes(scratchClaudeDir, scratchCodexHome);
});

afterAll(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

describe("listSessions (source filter + Codex merge)", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = scratchClaudeDir;
    process.env.CODEX_HOME = scratchCodexHome;
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
    const { sessions: items, total } = await listSessions(50, "codex");
    // 11111111, 22222222, 33333333 (archived), 77777777 (parent), 66666666
    // (orphaned sub-agent, rescued) — 44444444 is legacy, skipped;
    // 88888888/99999999 (77777777's sub-agents) are excluded from the list —
    // they surface inside 77777777's own subagentCount/Orchestration data
    // instead, same as Claude sidecars.
    expect(items.length).toBe(5);
    // `total` counts listable sessions, so legacy/sub-agent exclusions apply
    // to it too — not the 8 rollout files on disk.
    expect(total).toBe(5);
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
    const { sessions: items } = await listSessions(50, "codex");
    const orphan = items.find((i) => i.sessionId === "66666666-6666-6666-6666-666666666666");
    // Its thread_spawn parent (55555555…) has no rollout in the pool, so the
    // session would otherwise be invisible everywhere and its cost lost.
    expect(orphan).toBeDefined();
    expect(orphan?.subagentCount).toBe(0);
    expect(orphan?.firstUserPrompt).toBe("Orphaned sub-agent prompt");
  });

  it("dedups a session present both live and archived — live wins even when archived is newer", async () => {
    const { sessions: items } = await listSessions(50, "codex");
    const copies = items.filter((i) => i.sessionId === "11111111-1111-1111-1111-111111111111");
    expect(copies).toHaveLength(1);
    expect(copies[0] && "archived" in copies[0] && copies[0].archived).toBe(false);
  });

  // Regression: real Codex Desktop rollouts stamp every sub-agent thread's
  // session_meta with `session_id` = the ROOT session's id (the 77777777…
  // fixtures mirror that). Treating that field as the thread's own identity
  // made a depth-2 thread's parent unresolvable (so it escaped sub-agent
  // exclusion) and surfaced it as an extra row carrying the ROOT's sessionId —
  // the web's session list rendered duplicate React keys
  // (`codex/codex/<id>`) for every such conversation.
  it("never lists the same (source, sessionId) twice, even when sub-agent threads share the root's session_id", async () => {
    const { sessions: items } = await listSessions(50, "all");
    const keys = items.map((i) => `${i.source}:${i.sessionId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("source: 'codex' reports archived: true only for the archived_sessions fixture", async () => {
    const { sessions: items } = await listSessions(50, "codex");
    const archived = items.find((i) => i.sessionId === "33333333-3333-3333-3333-333333333333");
    const live = items.find((i) => i.sessionId === "11111111-1111-1111-1111-111111111111");
    expect(archived?.source).toBe("codex");
    expect(archived && "archived" in archived && archived.archived).toBe(true);
    expect(live && "archived" in live && live.archived).toBe(false);
  });

  it("source: 'claude-code' lists only Claude sessions (unchanged behavior)", async () => {
    const { sessions: items, total } = await listSessions(50, "claude-code");
    // 11111111/22222222/33333333 plus 44444444…445 (skill-injection fixture, #27).
    expect(items.length).toBe(4);
    expect(total).toBe(4);
    for (const item of items) {
      expect(item.source).toBe("claude-code");
    }
  });

  it('source "all" merges both sets, newest first by session START time, limit and offset applied after the merge', async () => {
    // The list sorts by each session's `startedAt` (first transcript
    // timestamp), NOT by the stamped file mtimes: every Claude fixture
    // starts on 2026-07-09 (44444444…445 at 04:00 — the newest of all,
    // despite being the skill-injection fixture) while the Codex rollouts
    // start 2026-07-01..03, so all Claude rows precede all Codex rows
    // regardless of how the mtime stamps interleave the two sources.
    // 88888888/99999999 don't appear — they're 77777777's sub-agents,
    // excluded from the list.
    const all = await listSessions(50, "all");
    expect(all.total).toBe(9);
    expect(all.sessions.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "claude-code:44444444",
      "claude-code:33333333",
      "claude-code:22222222",
      "claude-code:11111111",
      "codex:77777777",
      "codex:33333333",
      "codex:22222222",
      "codex:11111111",
      "codex:66666666",
    ]);

    // limit=3 must cut the *merged* series, not take 3 from each source
    // first — and `total` still reports the full count, not the page's.
    const limited = await listSessions(3, "all");
    expect(limited.total).toBe(9);
    expect(limited.sessions.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "claude-code:44444444",
      "claude-code:33333333",
      "claude-code:22222222",
    ]);

    // offset pages through the same merged series — this window ([3, 6))
    // straddles the Claude/Codex boundary, which per-source offsetting
    // would get wrong.
    const paged = await listSessions(3, "all", 3);
    expect(paged.total).toBe(9);
    expect(paged.sessions.map((i) => `${i.source}:${i.sessionId.slice(0, 8)}`)).toEqual([
      "claude-code:11111111",
      "codex:77777777",
      "codex:33333333",
    ]);

    // An offset past the end yields an empty page but keeps `total`, so a
    // stale deep-page URL can still render a working pager.
    const past = await listSessions(3, "all", 100);
    expect(past.sessions).toEqual([]);
    expect(past.total).toBe(9);
  });

  it('source omitted means "all" (no back-compat Claude-only default)', async () => {
    const { sessions: items } = await listSessions(50);
    const { sessions: all } = await listSessions(50, "all");
    expect(items.length).toBe(all.length);
    expect(items.some((i) => i.source === "codex")).toBe(true);
    expect(items.some((i) => i.source === "claude-code")).toBe(true);
  });

  it("list: a session named only in session_index.jsonl gets that thread name as its title", async () => {
    const { sessions: items } = await listSessions(50, "codex");
    const indexOnly = items.find((i) => i.sessionId === "22222222-2222-2222-2222-222222222222");
    expect(indexOnly?.title).toBe("Index-only thread name");
  });

  it("list: the index name wins over a rollout thread_name_updated event", async () => {
    const { sessions: items } = await listSessions(50, "codex");
    const renamed = items.find((i) => i.sessionId === "11111111-1111-1111-1111-111111111111");
    // The rollout's own event says "Fix flaky test"; the index rename is newer.
    expect(renamed?.title).toBe("Renamed in Codex UI");
  });

  it("list: a session in neither the index nor its rollout stays title-less", async () => {
    const { sessions: items } = await listSessions(50, "codex");
    const untitled = items.find((i) => i.sessionId === "33333333-3333-3333-3333-333333333333");
    expect(untitled).toBeDefined();
    expect(untitled?.title).toBeUndefined();
  });

  it("missing CODEX_HOME yields zero Codex items, no error", async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(scratchCodexHome, "does-not-exist");
    try {
      const page = await listSessions(50, "codex");
      expect(page.sessions).toEqual([]);
      expect(page.total).toBe(0);
    } finally {
      process.env.CODEX_HOME = previous;
    }
  });

  // Codex has no proxy-pruning step (see `codexListItems`'s doc comment) —
  // bounds are a pure post-filter on each session's real `startedAt`, so
  // these bounds are chosen directly from the fixtures' real start times
  // (see the FIXTURE_MTIMES comment above: the mtime stamps only preserve
  // RELATIVE order, not real dates, so a Claude-side bounds test needs its
  // own setup — see sessions.test.ts).
  it("sinceMs/untilMs bounds filter Codex sessions by session START time, while `total` stays the full unbounded count", async () => {
    // Excludes 66666666 (2026-07-01T08:00, the orphaned sub-agent) below and
    // 77777777 (2026-07-03T09:00, the orchestration parent) above.
    const sinceMs = Date.parse("2026-07-01T09:00:00.000Z");
    const untilMs = Date.parse("2026-07-03T00:00:00.000Z");
    const { sessions: items, total } = await listSessions(50, "codex", 0, { sinceMs, untilMs });
    expect(total).toBe(5);
    expect(items.map((i) => i.sessionId.slice(0, 8))).toEqual([
      "33333333", // 2026-07-02T09:30
      "22222222", // 2026-07-02T09:00
      "11111111", // 2026-07-01T10:00
    ]);
  });

  it("an explicit but empty bounds object behaves exactly like omitting bounds entirely", async () => {
    const withEmptyBounds = await listSessions(50, "codex", 0, {});
    const withoutBounds = await listSessions(50, "codex");
    expect(withEmptyBounds.sessions.map((i) => i.sessionId)).toEqual(
      withoutBounds.sessions.map((i) => i.sessionId),
    );
  });
});

describe("getCodexSession", () => {
  let previousCodexHome: string | undefined;

  beforeAll(() => {
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = scratchCodexHome;
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

  it("detail: carries the session_index.jsonl thread name, beating the rollout's own event", async () => {
    const indexOnly = await getCodexSession("22222222-2222-2222-2222-222222222222");
    expect(indexOnly?.title).toBe("Index-only thread name");
    const renamed = await getCodexSession("11111111-1111-1111-1111-111111111111");
    expect(renamed?.title).toBe("Renamed in Codex UI");
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
    process.env.CODEX_HOME = scratchCodexHome;
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
