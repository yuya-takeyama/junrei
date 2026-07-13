import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeClaudeSession, type ClaudeSessionAnalysis } from "@junrei/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeModelMix, listSessions } from "./sessions.js";

const CORE_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures");
const CORE_PROJECT_DIR = join(CORE_FIXTURES_DIR, "projects/-Users-test-proj");

const SESSION_FILE = join(CORE_PROJECT_DIR, "11111111-1111-1111-1111-111111111111.jsonl");

describe("computeModelMix", () => {
  it("aggregates output tokens per model across the main session and all subagents", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    const mix = computeModelMix(analysis);

    // Main transcript only uses claude-fable-5; the fixture's one subagent
    // uses claude-haiku-4-5-20251001 — both must be represented, keyed by
    // output tokens (not message count or cost) so the L0 mix bar reflects
    // actual generation volume per model.
    const fableMain = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    expect(fableMain).toBeDefined();

    const fable = mix.find((m) => m.model === "claude-fable-5");
    const haiku = mix.find((m) => m.model === "claude-haiku-4-5-20251001");
    expect(fable?.outputTokens).toBe(fableMain?.outputTokens);
    expect(haiku?.outputTokens).toBeGreaterThan(0);

    // Every model's output tokens must come from usage.byModel + subagent
    // usage — never double-counted, never dropped.
    const total = mix.reduce((sum, m) => sum + m.outputTokens, 0);
    expect(total).toBe(analysis.totalUsage.outputTokens);
  });

  it("returns an empty list when there is no usage at all", () => {
    const analysis = {
      usage: {
        byModel: [],
        total: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          costIsComplete: true,
        },
      },
      subagents: [],
    } as unknown as ClaudeSessionAnalysis;
    expect(computeModelMix(analysis)).toEqual([]);
  });
});

describe("listSessions — sinceMs/untilMs bounds (Claude proxy pruning + exact post-filter)", () => {
  // Real `startedAt` baked into each fixture's transcript (all four land on
  // 2026-07-09 — see each file's first record): 11111111 01:00, 22222222
  // 02:00, 33333333 03:00, 44444444…445 04:00:01. Copied into a scratch
  // project dir with mtimes stamped to those EXACT values (rather than
  // "whenever this checkout happened") so the Claude adapter's ±24h
  // proxy-pruning margin (`PROXY_MARGIN_MS` in sources/claude.ts) can never
  // interfere with a same-day bounds window — same rationale as
  // sessions-codex.test.ts's own fixture-mtime stamping, just anchored to
  // the fixtures' real dates instead of an arbitrary relative order (that
  // file's stamps don't reflect real dates at all, so they can't double as
  // a bounds test — see its own bounds test using Codex fixtures instead,
  // which have no proxy step to worry about).
  const SESSIONS: ReadonlyArray<readonly [string, string]> = [
    ["11111111-1111-1111-1111-111111111111.jsonl", "2026-07-09T01:00:00.000Z"],
    ["22222222-2222-2222-2222-222222222222.jsonl", "2026-07-09T02:00:00.000Z"],
    ["33333333-3333-3333-3333-333333333333.jsonl", "2026-07-09T03:00:00.000Z"],
    ["44444444-4444-4444-4444-444444444445.jsonl", "2026-07-09T04:00:01.000Z"],
  ];

  let scratchDir: string;
  let previousConfigDir: string | undefined;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "junrei-session-bounds-"));
    const projectDir = join(scratchDir, "projects", "-Users-test-proj");
    await mkdir(projectDir, { recursive: true });
    await Promise.all(
      SESSIONS.map(async ([filename, startedAt]) => {
        const content = await readFile(join(CORE_PROJECT_DIR, filename));
        const dest = join(projectDir, filename);
        await writeFile(dest, content);
        const stamp = new Date(startedAt);
        await utimes(dest, stamp, stamp);
      }),
    );
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = scratchDir;
  });

  afterAll(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(scratchDir, { recursive: true, force: true });
  });

  it("filters the returned page to sessions whose START time falls within [sinceMs, untilMs), leaving `total` at the full unbounded count", async () => {
    const sinceMs = Date.parse("2026-07-09T01:30:00.000Z");
    const untilMs = Date.parse("2026-07-09T03:30:00.000Z");
    const { sessions, total } = await listSessions(50, "claude-code", 0, { sinceMs, untilMs });
    expect(total).toBe(4);
    expect(sessions.map((s) => s.sessionId.slice(0, 8))).toEqual(["33333333", "22222222"]);
  });

  it("an open-ended sinceMs (no untilMs) keeps everything from that point forward", async () => {
    const sinceMs = Date.parse("2026-07-09T02:30:00.000Z");
    const { sessions, total } = await listSessions(50, "claude-code", 0, { sinceMs });
    expect(total).toBe(4);
    expect(sessions.map((s) => s.sessionId.slice(0, 8))).toEqual(["44444444", "33333333"]);
  });

  it("an explicit but empty bounds object behaves exactly like omitting bounds entirely", async () => {
    const withEmptyBounds = await listSessions(50, "claude-code", 0, {});
    const withoutBounds = await listSessions(50, "claude-code");
    expect(withEmptyBounds.sessions.map((s) => s.sessionId)).toEqual(
      withoutBounds.sessions.map((s) => s.sessionId),
    );
  });
});
