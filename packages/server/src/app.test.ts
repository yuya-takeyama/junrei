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
    expect(body.entries.map((e) => e.kind)).toEqual(["user", "tool-call", "assistant-text"]);
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
