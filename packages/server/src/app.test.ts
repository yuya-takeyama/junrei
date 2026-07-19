import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

// resolveClaudeProjectsDirs() joins `${CLAUDE_CONFIG_DIR}/projects`, so pointing it
// at the core package's fixtures dir makes the real discovery path
// (resolveClaudeProjectsDirs -> listClaudeSessionFiles) resolve the same fixture files
// packages/core's own tests parse directly.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures");

const PROJECT = "-Users-test-proj";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "aaaa111122223333f";

describe("Claude Code timeline + record routes", () => {
  let previousConfigDir: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = FIXTURES_DIR;
  });

  afterAll(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it("GET /api/sessions/claude-code/:id returns { analysis: ClaudeSessionAnalysis } via bare-id resolution", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      analysis: {
        sessionId: string;
        source?: string;
        delegation?: { main: { tokens: number }; subagents: { tokens: number } };
      };
      lastActivityAt?: string;
    };
    expect(body.analysis.sessionId).toBe(SESSION_ID);
    expect(body.analysis.source).toBe("claude-code");
    // The fixture session has one subagent — both slices carry real tokens.
    expect(body.analysis.delegation?.main.tokens).toBeGreaterThan(0);
    expect(body.analysis.delegation?.subagents.tokens).toBeGreaterThan(0);
    // Computed fresh per request from the fixture files' real mtimes — never
    // baked into the cached `analysis` object (see `getClaudeLastActivityAt`).
    expect(typeof body.lastActivityAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.lastActivityAt ?? ""))).toBe(false);
  });

  it("GET /api/sessions/claude-code/:id 404s for an unknown session id", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/claude-code/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/claude-code/:id/timeline returns ordered entries", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/timeline`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ kind: string; line: number }> };
    expect(body.entries[0]).toMatchObject({ kind: "user", line: 1 });
    expect(body.entries.some((e) => e.kind === "subagent-launch")).toBe(true);
    expect(body.entries.some((e) => e.kind === "compaction")).toBe(true);
    expect(body.entries.some((e) => e.kind === "api-error")).toBe(true);
  });

  it("GET .../timeline?agent=<id> scopes the timeline to that subagent", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/sessions/claude-code/${SESSION_ID}/timeline?agent=${AGENT_ID}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ kind: string }> };
    expect(body.entries.map((e) => e.kind)).toEqual([
      "user",
      "tool-call",
      "assistant-text",
      "tool-call",
    ]);
  });

  it("GET .../timeline 404s for an unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/claude-code/does-not-exist/timeline");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/claude-code/:id/insight returns the conclusion-first SessionInsight (Story callout)", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/insight`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      source: string;
      summary: { headline: string; costUsd: number };
      recommendations: Array<{ finding: string; change: string; logLearningCall: unknown }>;
      waste: Array<{ class: string }>;
      delegation: { subagentCount: number };
      _meta: { approxTokens: number };
    };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.source).toBe("claude-code");
    expect(typeof body.summary.headline).toBe("string");
    // Recommendations carry a ready-to-submit log_learning template (the Log
    // learning button's payload).
    if (body.recommendations.length > 0) {
      expect(body.recommendations[0]?.logLearningCall).toBeDefined();
    }
    expect(body._meta.approxTokens).toBeGreaterThan(0);
  });

  it("GET .../insight 404s for an unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/claude-code/does-not-exist/insight");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/claude-code/:id/record/:line returns full tool-call detail", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/record/3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      toolUseId: string;
      input: unknown;
      resultLine: number;
    };
    expect(body.kind).toBe("tool-call");
    expect(body.toolUseId).toBe("toolu_read1");
    expect(body.input).toEqual({ file_path: "/p/foo.ts" });
    expect(body.resultLine).toBe(4);
  });

  it("GET .../record/:line 404s for a non-numeric line", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/record/not-a-number`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET .../record/:line 404s for a line with no addressable record", async () => {
    const app = createApp();
    // Line 4 is a tool_result-only carrier — not independently addressable.
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/record/4`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET /api/sessions/claude-code/:id/evaluation-trace returns the full uncapped evaluation trace", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/evaluation-trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema: string;
      session: { sessionId: string };
      sourceCompleteness: { sources: Array<{ source: string }> };
      enrichment: { otel: { consulted: boolean }; captures: { consulted: boolean } };
      events: Array<{ name: string }>;
    };
    expect(body.schema).toBe("junrei-evaluation-trace/v1");
    expect(body.session.sessionId).toBe(SESSION_ID);
    expect(body.sourceCompleteness.sources.map((s) => s.source)).toContain("claude-session-jsonl");
    // Declared, never silently absent — the opt-in channels weren't configured for this test.
    expect(body.enrichment.otel.consulted).toBe(true);
    expect(body.enrichment.captures.consulted).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.some((e) => e.name === "gen_ai.user.message")).toBe(true);
    expect(body.events.some((e) => e.name === "junrei.subagent_launch")).toBe(true);
  });

  it("GET .../evaluation-trace 404s for an unknown session id", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/claude-code/does-not-exist/evaluation-trace");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/claude-code/:id/agents/:agentId returns { analysis } for the sidecar transcript", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/agents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      analysis: {
        sessionId: string;
        usage: { total: { inputTokens: number } };
        apiMessageCount: number;
        subagents: unknown[];
      };
    };
    // Same ClaudeSessionAnalysis shape as the main session endpoint, applied to the
    // agent's own sidecar transcript instead — sessionId is the sidecar's
    // filename stem (agent-<id>), it has its own usage/apiMessageCount, and
    // (this fixture agent has no nested children of its own) an empty
    // subagent forest.
    expect(body.analysis.sessionId).toBe(`agent-${AGENT_ID}`);
    expect(body.analysis.usage.total.inputTokens).toBeGreaterThan(0);
    expect(body.analysis.apiMessageCount).toBeGreaterThan(0);
    expect(body.analysis.subagents).toEqual([]);
  });

  it("GET .../agents/:agentId 404s for an unknown agent id", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}/agents/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });
});

describe("Claude Code session analysis cache follows Workflow sidecars, not just the main transcript", () => {
  // Regression coverage for the "analysis cache goes stale while a Workflow
  // runs" bug: the main transcript can go quiet for 30+ minutes while a
  // Workflow's agent sidecars keep appearing/growing under
  // `<sessionDir>/subagents/workflows/<runId>/`, so a cache keyed ONLY on the
  // main file's own change token would keep serving a pre-run analysis for
  // the whole run. Built in a scratch temp dir (never the shared checked-in
  // fixtures other describe blocks assert exact values against) because this
  // test mutates the session's sidecar tree mid-test.
  const SESSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const PROJECT_DIR_NAME = "-tmp-cache-fixture-proj";

  let tempDir: string;
  let projectDir: string;
  let previousConfigDir: string | undefined;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "junrei-analysis-cache-"));
    projectDir = join(tempDir, "projects", PROJECT_DIR_NAME);
    await mkdir(projectDir, { recursive: true });

    const mainLines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: "2026-07-19T00:00:00.000Z",
        isSidechain: false,
        cwd: "/tmp/cache-fixture",
        version: "2.1.202",
        message: { role: "user", content: "Kick off a long-running Workflow" },
      },
    ];
    await writeFile(
      join(projectDir, `${SESSION_ID}.jsonl`),
      `${mainLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
  });

  afterAll(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("recomputes when a Workflow agent sidecar appears after the first request, main transcript untouched", async () => {
    const app = createApp();

    const first = await app.request(`/api/sessions/claude-code/${SESSION_ID}`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { analysis: { subagentCount: number } };
    expect(firstBody.analysis.subagentCount).toBe(0);

    // The main transcript file is NEVER touched below — only a new sidecar
    // transcript shows up, exactly like a Workflow run's agent appearing
    // while the main session stays quiet.
    const runDir = join(projectDir, SESSION_ID, "subagents", "workflows", "wf_cache_test");
    await mkdir(runDir, { recursive: true });
    const agentId = "cacheinvalidagt1";
    await writeFile(
      join(runDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }),
    );
    const agentLines = [
      {
        type: "user",
        uuid: "au1",
        parentUuid: null,
        sessionId: SESSION_ID,
        agentId,
        timestamp: "2026-07-19T00:05:00.000Z",
        isSidechain: true,
        message: { role: "user", content: "do work" },
      },
    ];
    await writeFile(
      join(runDir, `agent-${agentId}.jsonl`),
      `${agentLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const second = await app.request(`/api/sessions/claude-code/${SESSION_ID}`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { analysis: { subagentCount: number } };
    expect(secondBody.analysis.subagentCount).toBe(1);
  });
});

describe("Claude Desktop title fallback", () => {
  const DESKTOP_DIR = join(FIXTURES_DIR, "claude-desktop");
  const DESKTOP_TITLED_SESSION = "44444444-4444-4444-4444-444444444445";
  let previousConfigDir: string | undefined;
  let previousDesktopDir: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousDesktopDir = process.env.JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR;
    process.env.CLAUDE_CONFIG_DIR = FIXTURES_DIR;
    process.env.JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR = DESKTOP_DIR;
  });

  afterAll(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    if (previousDesktopDir === undefined) {
      delete process.env.JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR;
    } else {
      process.env.JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR = previousDesktopDir;
    }
  });

  it("detail: a session with no title records in its transcript gets the Desktop title", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${DESKTOP_TITLED_SESSION}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: { title?: string } };
    expect(body.analysis.title).toBe("Desktop-titled session");
  });

  it("detail: a transcript's own ai-title wins over a Desktop title", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: { title?: string } };
    // The desktop fixture maps this session to "Desktop title must lose".
    expect(body.analysis.title).toBe("Fix foo bug");
  });

  it("list: items carry the same fallback titles", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions?source=claude-code");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; title?: string }>;
    };
    const bySessionId = new Map(body.sessions.map((s) => [s.sessionId, s.title]));
    expect(bySessionId.get(DESKTOP_TITLED_SESSION)).toBe("Desktop-titled session");
    expect(bySessionId.get(SESSION_ID)).toBe("Fix foo bug");
  });
});

const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");
const CODEX_SESSION_ID = "11111111-1111-1111-1111-111111111111";

describe("Codex routes", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
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

  it("GET /api/sessions/codex/:id returns { analysis: CodexSessionAnalysis } for a known id", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/codex/${CODEX_SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      analysis: {
        source: string;
        sessionId: string;
        delegation?: { subagents: { tokens: number; outputTokens: number; costUsd?: number } };
      };
      lastActivityAt?: string;
    };
    expect(body.analysis.source).toBe("codex");
    expect(body.analysis.sessionId).toBe(CODEX_SESSION_ID);
    // A leaf Codex session (no sub-agent forest) — honest all-zero slice.
    expect(body.analysis.delegation?.subagents).toEqual({
      tokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
    });
    // Computed fresh per request from the rollout file's real mtime.
    expect(typeof body.lastActivityAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.lastActivityAt ?? ""))).toBe(false);
  });

  it("GET /api/sessions/codex/:id 404s for an unknown id", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/codex/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/codex/:id 404s for a legacy-format transcript", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/codex/44444444-4444-4444-4444-444444444444");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/codex/:id/timeline returns ordered entries built from the rollout transcript", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/codex/${CODEX_SESSION_ID}/timeline`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ kind: string; line: number }> };
    expect(body.entries.map((e) => [e.kind, e.line])).toEqual([
      ["user", 4],
      ["thinking", 5],
      ["tool-call", 6],
      ["tool-call", 10],
      ["tool-call", 12],
      ["user", 17],
      ["compaction", 22],
    ]);
    // No Claude-only kind is ever emitted for a Codex transcript.
    expect(body.entries.some((e) => e.kind === "subagent-launch")).toBe(false);
    expect(body.entries.some((e) => e.kind === "api-error")).toBe(false);
  });

  it("GET /api/sessions/codex/:id/timeline 404s for an unknown id", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/codex/does-not-exist/timeline");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/codex/:id/timeline 404s for a legacy-format transcript", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/sessions/codex/44444444-4444-4444-4444-444444444444/timeline",
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/codex/:id/record/:line returns full tool-call detail", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/codex/${CODEX_SESSION_ID}/record/6`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      toolUseId: string;
      input: unknown;
      status: string;
      resultLine: number;
    };
    expect(body.kind).toBe("tool-call");
    expect(body.toolUseId).toBe("call-1");
    expect(body.input).toEqual({ command: ["pytest", "foo.spec.ts"] });
    expect(body.status).toBe("error");
    expect(body.resultLine).toBe(7);
  });

  it("GET .../codex/:id/record/:line 404s for a non-numeric line", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/codex/${CODEX_SESSION_ID}/record/not-a-number`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET .../codex/:id/record/:line 404s for a line with no addressable record", async () => {
    const app = createApp();
    // Line 2 is a turn_context — never independently addressable.
    const res = await app.request(`/api/sessions/codex/${CODEX_SESSION_ID}/record/2`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET .../codex/:id/record/:line 404s for an unknown session id", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions/codex/does-not-exist/record/1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("the old unprefixed detail route is gone (clean break, no legacy alias) and 404s", async () => {
    // Regression guard for the source-symmetry refactor: `/api/sessions/:project/:id`
    // (pre-refactor, Claude-only, no source prefix) must not resolve at all anymore —
    // Hono returns a bare 404 (no matching route), distinct from the app's own
    // `{ error: "session not found" }` JSON 404 for a *known* route with an unknown id.
    const app = createApp();
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/sessions?source=... filters, and merging both sources includes Codex items", async () => {
    const app = createApp();

    const codexOnly = await app.request("/api/sessions?source=codex");
    const codexBody = (await codexOnly.json()) as {
      sessions: Array<{ source: string }>;
      total: number;
    };
    expect(codexBody.sessions.length).toBeGreaterThan(0);
    expect(codexBody.sessions.every((s) => s.source === "codex")).toBe(true);

    const claudeOnly = await app.request("/api/sessions?source=claude-code");
    const claudeBody = (await claudeOnly.json()) as {
      sessions: Array<{
        sessionId: string;
        source: string;
        repoRoot?: string;
        worktreeName?: string;
      }>;
    };
    expect(claudeBody.sessions.every((s) => s.source === "claude-code")).toBe(true);

    // A worktree-shaped cwd (fixture session 22222222-...) surfaces
    // repoRoot/worktreeName on the list item, not just on the full analysis —
    // see `deriveRepoIdentity` (@junrei/core) and `sources/claude.ts`'s `toListItem`.
    const worktreeSession = claudeBody.sessions.find(
      (s) => s.sessionId === "22222222-2222-2222-2222-222222222222",
    );
    expect(worktreeSession?.repoRoot).toBe("/Users/test/proj2");
    expect(worktreeSession?.worktreeName).toBe("wt-1");

    const merged = await app.request("/api/sessions?source=all");
    const mergedBody = (await merged.json()) as {
      sessions: Array<{ source: string }>;
      total: number;
    };
    expect(mergedBody.sessions.some((s) => s.source === "codex")).toBe(true);
    expect(mergedBody.sessions.some((s) => s.source === "claude-code")).toBe(true);
    expect(mergedBody.sessions.length).toBe(codexBody.sessions.length + claudeBody.sessions.length);
    // Every fixture fits in the default page, so `total` equals the page length.
    expect(mergedBody.total).toBe(mergedBody.sessions.length);

    // Omitted source now means "all" (no more back-compat Claude-only default —
    // see sessions.ts's listSessions), so it must match the explicit ?source=all result.
    const omitted = await app.request("/api/sessions");
    const omittedBody = (await omitted.json()) as { sessions: Array<{ source: string }> };
    expect(omittedBody.sessions.length).toBe(mergedBody.sessions.length);
    expect(omittedBody.sessions.some((s) => s.source === "codex")).toBe(true);
    expect(omittedBody.sessions.some((s) => s.source === "claude-code")).toBe(true);
  });

  it("GET /api/sessions?limit=&offset= pages the merged list and keeps `total` constant", async () => {
    const app = createApp();

    const full = await app.request("/api/sessions?source=all");
    const fullBody = (await full.json()) as {
      sessions: Array<{ source: string; sessionId: string }>;
      total: number;
    };

    // limit is sized so offset+limit covers every fixture: unlike
    // sessions-codex.test.ts this file doesn't stamp fixture mtimes, so a
    // narrower window would let the Claude adapter's mtime-proxy preselection
    // (see `claudeListItems`) pick a checkout-order-dependent subset and the
    // slice comparison below would flake.
    const paged = await app.request("/api/sessions?source=all&limit=10&offset=1");
    const pagedBody = (await paged.json()) as {
      sessions: Array<{ source: string; sessionId: string }>;
      total: number;
    };
    expect(pagedBody.sessions.length).toBe(fullBody.sessions.length - 1);
    expect(pagedBody.total).toBe(fullBody.total);
    // The window must be a slice of the same merged order the unpaged
    // request returns, not a per-source cut.
    expect(pagedBody.sessions.map((s) => `${s.source}:${s.sessionId}`)).toEqual(
      fullBody.sessions.slice(1, 11).map((s) => `${s.source}:${s.sessionId}`),
    );

    // Past the end: empty page, same total (a stale deep-page URL still
    // renders a working pager). A junk offset falls back to 0.
    const past = await app.request("/api/sessions?source=all&limit=2&offset=999");
    const pastBody = (await past.json()) as { sessions: unknown[]; total: number };
    expect(pastBody.sessions).toEqual([]);
    expect(pastBody.total).toBe(fullBody.total);

    const junk = await app.request("/api/sessions?source=all&offset=banana");
    const junkBody = (await junk.json()) as { sessions: unknown[] };
    expect(junkBody.sessions.length).toBe(fullBody.sessions.length);
  });

  it("GET /api/sessions threads sinceMs/untilMs through to the listing (a bound before the Unix epoch empties the page but leaves `total` unbounded)", async () => {
    const app = createApp();
    const full = await app.request("/api/sessions?source=all");
    const fullBody = (await full.json()) as { total: number };

    // untilMs=1 (1970-01-01T00:00:00.001Z) is before every fixture's real
    // startedAt, so nothing qualifies — but `total` must stay the full
    // listable count regardless (see `SessionListBounds`'s doc comment).
    const res = await app.request("/api/sessions?source=all&untilMs=1");
    const body = (await res.json()) as { sessions: unknown[]; total: number };
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(fullBody.total);
  });

  it("GET /api/sessions ignores invalid sinceMs/untilMs (non-numeric, zero, negative) exactly like omitting them", async () => {
    const app = createApp();
    const base = await app.request("/api/sessions?source=all");
    const baseBody = (await base.json()) as {
      sessions: Array<{ source: string; sessionId: string }>;
      total: number;
    };

    for (const junk of ["banana", "0", "-5", ""]) {
      const res = await app.request(
        `/api/sessions?source=all&sinceMs=${encodeURIComponent(junk)}&untilMs=${encodeURIComponent(junk)}`,
      );
      const body = (await res.json()) as {
        sessions: Array<{ source: string; sessionId: string }>;
        total: number;
      };
      expect(body.sessions.map((s) => `${s.source}:${s.sessionId}`)).toEqual(
        baseBody.sessions.map((s) => `${s.source}:${s.sessionId}`),
      );
      expect(body.total).toBe(baseBody.total);
    }
  });
});

describe("GET /api/overview", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
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

  it("200s with a repo-level rollup when `repo` is given", async () => {
    const app = createApp();
    // Fixture session 11111111 has cwd "/Users/test/proj" with no worktree
    // marker, so its repoRoot is that same path (see deriveRepoIdentity).
    const res = await app.request("/api/overview?repo=%2FUsers%2Ftest%2Fproj");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overview: {
        repo: string;
        sessionCount: number;
        sourceCounts: Record<string, number>;
        totalCostUsd: number;
      };
    };
    expect(body.overview.repo).toBe("/Users/test/proj");
    expect(body.overview.sessionCount).toBeGreaterThan(0);
    expect(body.overview.sourceCounts["claude-code"]).toBeGreaterThan(0);
  });

  it("400s when `repo` is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/overview");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo query param is required" });
  });

  it("400s when `repo` is the empty string", async () => {
    const app = createApp();
    const res = await app.request("/api/overview?repo=");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/trends", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
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

  it("defaults days to 14 and tz to UTC when both are omitted", async () => {
    const app = createApp();
    const res = await app.request("/api/trends");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: { days: number; timeZone: string; bucket: string };
    };
    expect(body.window.days).toBe(14);
    expect(body.window.timeZone).toBe("UTC");
    expect(body.window.bucket).toBe("day");
  });

  it("coerces an out-of-whitelist `days` value to the default instead of 400ing (same convention as /api/sessions' limit/offset)", async () => {
    const app = createApp();
    const res = await app.request("/api/trends?days=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { days: number } };
    expect(body.window.days).toBe(14);
  });

  it("accepts each whitelisted `days` value", async () => {
    const app = createApp();
    for (const days of [7, 14, 30]) {
      const res = await app.request(`/api/trends?days=${String(days)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { window: { days: number }; buckets: unknown[] };
      expect(body.window.days).toBe(days);
      expect(body.buckets).toHaveLength(days);
    }
  });

  it("400s for an invalid IANA `tz`", async () => {
    const app = createApp();
    const res = await app.request("/api/trends?tz=Not%2FAZone");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tz query param must be a valid IANA time zone" });
  });

  it("accepts a valid non-UTC IANA `tz`", async () => {
    const app = createApp();
    const res = await app.request("/api/trends?tz=Asia%2FTokyo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { timeZone: string } };
    expect(body.window.timeZone).toBe("Asia/Tokyo");
  });

  it("200s with a full trend report over the fixtures — zero-filled buckets, internally consistent totals", async () => {
    const app = createApp();
    // 30 days comfortably covers the fixtures' 2026-07-01..09 session dates
    // from whenever this suite actually runs (see FIXTURES_DIR/CODEX_HOME).
    const res = await app.request("/api/trends?days=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      buckets: Array<{ date: string; sessionCount: number; totalCostUsd: number }>;
      summary: { current: { sessionCount: number; totalCostUsd: number } };
    };
    expect(body.buckets).toHaveLength(30);
    const bucketSessionSum = body.buckets.reduce((sum, b) => sum + b.sessionCount, 0);
    expect(bucketSessionSum).toBe(body.summary.current.sessionCount);
    expect(body.summary.current.sessionCount).toBeGreaterThan(0);
    const bucketCostSum = body.buckets.reduce((sum, b) => sum + b.totalCostUsd, 0);
    expect(bucketCostSum).toBeCloseTo(body.summary.current.totalCostUsd);
  });

  it("`repo` narrows the report to one repo's sessions, same key semantics as /api/overview", async () => {
    const app = createApp();
    const all = await app.request("/api/trends?days=30");
    const allBody = (await all.json()) as { summary: { current: { sessionCount: number } } };

    // Fixture session 11111111 has cwd "/Users/test/proj" with no worktree
    // marker, so its repoRoot is that same path (see deriveRepoIdentity) —
    // same fixture /api/overview's own repo-filter test above uses.
    const scoped = await app.request("/api/trends?days=30&repo=%2FUsers%2Ftest%2Fproj");
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as {
      summary: { current: { sessionCount: number } };
      anomalies: { topSessions: Array<{ repoKey: string }> };
    };
    expect(scopedBody.summary.current.sessionCount).toBeGreaterThan(0);
    expect(scopedBody.summary.current.sessionCount).toBeLessThanOrEqual(
      allBody.summary.current.sessionCount,
    );
    for (const session of scopedBody.anomalies.topSessions) {
      expect(session.repoKey).toBe("/Users/test/proj");
    }
  });
});

// `createApp`'s `webDistDir` override (see app.ts) lets these exercise the
// production static-serving + SPA-fallback path against a fixture directory
// standing in for a real `vite build` output, without actually running one.
describe("SPA fallback — built web assets present", () => {
  let webDistDir: string;

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "junrei-web-dist-"));
    await writeFile(join(webDistDir, "index.html"), "<!doctype html><title>junrei</title>");
    await mkdir(join(webDistDir, "assets"));
    await writeFile(join(webDistDir, "assets", "app.js"), "console.log('junrei');");
  });

  afterAll(async () => {
    await rm(webDistDir, { recursive: true, force: true });
  });

  it("serves a real static asset with its content type", async () => {
    const app = createApp({ webDistDir });
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe("console.log('junrei');");
  });

  it("GET /session/claude-code/:id/timeline (a client-side route, no matching file) falls back to index.html", async () => {
    const app = createApp({ webDistDir });
    const res = await app.request(`/session/claude-code/${SESSION_ID}/timeline`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("<title>junrei</title>");
  });

  it("known API routes still work — the static-asset middleware falls through", async () => {
    const app = createApp({ webDistDir });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "junrei" });
  });

  it("GET /api/nonexistent still 404s as JSON, not the SPA shell", async () => {
    const app = createApp({ webDistDir });
    const res = await app.request("/api/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("SPA fallback — no build present (dev/test default)", () => {
  it("GET /session/... 404s plainly, same as with no catch-all registered at all", async () => {
    const app = createApp({ webDistDir: join(tmpdir(), "junrei-web-dist-does-not-exist") });
    const res = await app.request("/session/claude-code/some-id/timeline");
    expect(res.status).toBe(404);
  });

  it("GET /api/nonexistent still returns the JSON-shaped 404 even without a build", async () => {
    const app = createApp({ webDistDir: join(tmpdir(), "junrei-web-dist-does-not-exist") });
    const res = await app.request("/api/nonexistent");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("OTel receiver — POST /otlp/v1/logs and /otlp/v1/metrics (opt-in, Decision 7)", () => {
  let previousOtelDir: string | undefined;

  beforeAll(() => {
    previousOtelDir = process.env.JUNREI_OTEL_DIR;
  });

  afterAll(() => {
    if (previousOtelDir === undefined) {
      delete process.env.JUNREI_OTEL_DIR;
    } else {
      process.env.JUNREI_OTEL_DIR = previousOtelDir;
    }
  });

  describe("disabled (JUNREI_OTEL_DIR unset)", () => {
    beforeAll(() => {
      delete process.env.JUNREI_OTEL_DIR;
    });

    it("POST /otlp/v1/logs 404s byte-for-byte identically to a genuinely unregistered route", async () => {
      const app = createApp();
      const otlpRes = await app.request("/otlp/v1/logs", {
        method: "POST",
        body: JSON.stringify({ resourceLogs: [] }),
        headers: { "content-type": "application/json" },
      });
      const unknownRes = await app.request("/some/totally/unregistered/route", { method: "POST" });
      expect(otlpRes.status).toBe(404);
      expect(otlpRes.status).toBe(unknownRes.status);
      expect(await otlpRes.text()).toBe(await unknownRes.text());
      expect(otlpRes.headers.get("content-type")).toBe(unknownRes.headers.get("content-type"));
    });

    it("POST /otlp/v1/metrics 404s the same way", async () => {
      const app = createApp();
      const otlpRes = await app.request("/otlp/v1/metrics", {
        method: "POST",
        body: JSON.stringify({ resourceMetrics: [] }),
        headers: { "content-type": "application/json" },
      });
      const unknownRes = await app.request("/some/totally/unregistered/route", { method: "POST" });
      expect(otlpRes.status).toBe(404);
      expect(await otlpRes.text()).toBe(await unknownRes.text());
    });
  });

  describe("enabled (JUNREI_OTEL_DIR set)", () => {
    let otelDir: string;

    beforeEach(async () => {
      otelDir = await mkdtemp(join(tmpdir(), "junrei-otel-http-"));
      process.env.JUNREI_OTEL_DIR = otelDir;
    });

    afterEach(async () => {
      await rm(otelDir, { recursive: true, force: true });
    });

    it("POST /otlp/v1/logs stores the body under <session.id>.jsonl and acks with the OTLP success shape", async () => {
      const app = createApp();
      const body = {
        resourceLogs: [
          {
            resource: {
              attributes: [{ key: "session.id", value: { stringValue: "http-sess-1" } }],
            },
            scopeLogs: [],
          },
        ],
      };
      const res = await app.request("/otlp/v1/logs", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});

      const stored = await readFile(join(otelDir, "http-sess-1.jsonl"), "utf8");
      expect(stored).toBe(`${JSON.stringify(body)}\n`);
    });

    it("POST /otlp/v1/metrics stores the body and acks the same way", async () => {
      const app = createApp();
      const body = {
        resourceMetrics: [
          {
            resource: {
              attributes: [{ key: "session.id", value: { stringValue: "http-sess-2" } }],
            },
            scopeMetrics: [],
          },
        ],
      };
      const res = await app.request("/otlp/v1/metrics", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      const stored = await readFile(join(otelDir, "http-sess-2.jsonl"), "utf8");
      expect(stored).toBe(`${JSON.stringify(body)}\n`);
    });

    it("a body with no resolvable session.id lands in _unassigned.jsonl, not dropped", async () => {
      const app = createApp();
      const body = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [] }] };
      const res = await app.request("/otlp/v1/logs", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const stored = await readFile(join(otelDir, "_unassigned.jsonl"), "utf8");
      expect(stored).toBe(`${JSON.stringify(body)}\n`);
    });

    it("still acks with the OTLP success shape for an unparseable body, storing nothing", async () => {
      const app = createApp();
      const res = await app.request("/otlp/v1/logs", {
        method: "POST",
        body: "not valid json",
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    });
  });
});
