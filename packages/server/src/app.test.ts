import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

// resolveProjectsDirs() joins `${CLAUDE_CONFIG_DIR}/projects`, so pointing it
// at the core package's fixtures dir makes the real discovery path
// (resolveProjectsDirs -> listSessionFiles) resolve the same fixture files
// packages/core's own tests parse directly.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures");

const PROJECT = "-Users-test-proj";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "aaaa111122223333f";

describe("timeline + record routes", () => {
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

  it("GET /api/sessions/:project/:id/timeline returns ordered entries", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}/timeline`);
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
      `/api/sessions/${PROJECT}/${SESSION_ID}/timeline?agent=${AGENT_ID}`,
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
    const res = await app.request(`/api/sessions/${PROJECT}/does-not-exist/timeline`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("GET /api/sessions/:project/:id/record/:line returns full tool-call detail", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}/record/3`);
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
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}/record/not-a-number`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET .../record/:line 404s for a line with no addressable record", async () => {
    const app = createApp();
    // Line 4 is a tool_result-only carrier — not independently addressable.
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}/record/4`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "record not found" });
  });

  it("GET /api/sessions/:project/:id/agents/:agentId analyzes the sidecar transcript", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}/agents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      usage: { total: { inputTokens: number } };
      apiMessageCount: number;
      subagents: unknown[];
    };
    // Same SessionAnalysis shape as the main session endpoint, applied to the
    // agent's own sidecar transcript instead — sessionId is the sidecar's
    // filename stem (agent-<id>), it has its own usage/apiMessageCount, and
    // (this fixture agent has no nested children of its own) an empty
    // subagent forest.
    expect(body.sessionId).toBe(`agent-${AGENT_ID}`);
    expect(body.usage.total.inputTokens).toBeGreaterThan(0);
    expect(body.apiMessageCount).toBeGreaterThan(0);
    expect(body.subagents).toEqual([]);
  });

  it("GET .../agents/:agentId 404s for an unknown agent id", async () => {
    const app = createApp();
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}/agents/does-not-exist`);
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
    const body = (await res.json()) as { analysis: { source: string; sessionId: string } };
    expect(body.analysis.source).toBe("codex");
    expect(body.analysis.sessionId).toBe(CODEX_SESSION_ID);
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

  it("the literal 'codex' segment never collides with a real munged project dir (always starts with '-')", async () => {
    // Regression guard for the route-registration-order invariant documented
    // in app.ts: a request for the Claude route shaped identically except
    // for the project segment must still resolve as a Claude lookup, not
    // fall through to the Codex handler.
    const app = createApp();
    const res = await app.request(`/api/sessions/${PROJECT}/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; source?: string };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.source).toBe("claude-code"); // not routed to the Codex handler's { analysis: ... } envelope.
  });

  it("GET /api/sessions?source=... filters, and merging both sources includes Codex items", async () => {
    const app = createApp();

    const codexOnly = await app.request("/api/sessions?source=codex");
    const codexBody = (await codexOnly.json()) as { sessions: Array<{ source: string }> };
    expect(codexBody.sessions.length).toBeGreaterThan(0);
    expect(codexBody.sessions.every((s) => s.source === "codex")).toBe(true);

    const claudeOnly = await app.request("/api/sessions?source=claude-code");
    const claudeBody = (await claudeOnly.json()) as { sessions: Array<{ source: string }> };
    expect(claudeBody.sessions.every((s) => s.source === "claude-code")).toBe(true);

    const merged = await app.request("/api/sessions?source=all");
    const mergedBody = (await merged.json()) as { sessions: Array<{ source: string }> };
    expect(mergedBody.sessions.some((s) => s.source === "codex")).toBe(true);
    expect(mergedBody.sessions.some((s) => s.source === "claude-code")).toBe(true);
    expect(mergedBody.sessions.length).toBe(codexBody.sessions.length + claudeBody.sessions.length);

    // Omitted source stays Claude-only so the pre-Codex web UI is unaffected
    // until it opts in with ?source=all.
    const omitted = await app.request("/api/sessions");
    const omittedBody = (await omitted.json()) as { sessions: Array<{ source: string }> };
    expect(omittedBody.sessions.length).toBe(claudeBody.sessions.length);
    expect(omittedBody.sessions.every((s) => s.source === "claude-code")).toBe(true);
  });
});
