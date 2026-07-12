import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("GET /api/sessions/claude-code/:project/:id returns { analysis: ClaudeSessionAnalysis }", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${PROJECT}/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      analysis: {
        sessionId: string;
        source?: string;
        delegation?: { main: { tokens: number }; subagents: { tokens: number } };
      };
    };
    expect(body.analysis.sessionId).toBe(SESSION_ID);
    expect(body.analysis.source).toBe("claude-code");
    // The fixture session has one subagent — both slices carry real tokens.
    expect(body.analysis.delegation?.main.tokens).toBeGreaterThan(0);
    expect(body.analysis.delegation?.subagents.tokens).toBeGreaterThan(0);
  });

  it("GET /api/sessions/claude-code/:project/:id/timeline returns ordered entries", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/timeline`);
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
      `/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/timeline?agent=${AGENT_ID}`,
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
    const res = await app.request(`/api/sessions/claude-code/${PROJECT}/does-not-exist/timeline`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/claude-code/:project/:id/record/:line returns full tool-call detail", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/record/3`);
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
    const res = await app.request(
      `/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/record/not-a-number`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET .../record/:line 404s for a line with no addressable record", async () => {
    const app = createApp();
    // Line 4 is a tool_result-only carrier — not independently addressable.
    const res = await app.request(`/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/record/4`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET /api/sessions/claude-code/:project/:id/agents/:agentId returns { analysis } for the sidecar transcript", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/agents/${AGENT_ID}`,
    );
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
    const res = await app.request(
      `/api/sessions/claude-code/${PROJECT}/${SESSION_ID}/agents/does-not-exist`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
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
    const paged = await app.request("/api/sessions?source=all&limit=8&offset=1");
    const pagedBody = (await paged.json()) as {
      sessions: Array<{ source: string; sessionId: string }>;
      total: number;
    };
    expect(pagedBody.sessions.length).toBe(fullBody.sessions.length - 1);
    expect(pagedBody.total).toBe(fullBody.total);
    // The window must be a slice of the same merged order the unpaged
    // request returns, not a per-source cut.
    expect(pagedBody.sessions.map((s) => `${s.source}:${s.sessionId}`)).toEqual(
      fullBody.sessions.slice(1, 9).map((s) => `${s.source}:${s.sessionId}`),
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
