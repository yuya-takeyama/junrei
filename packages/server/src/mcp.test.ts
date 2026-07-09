import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./mcp.js";

const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);
const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");

const CLAUDE_PROJECT = "-Users-test-proj";
const CLAUDE_SESSION_ID = "11111111-1111-1111-1111-111111111111";
const CODEX_SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** Connect a fresh client + server pair over an in-memory transport, like the real `/mcp` endpoint does per-request. */
async function connect() {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), createMcpServer().connect(serverTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
  }
  return first.text;
}

describe("MCP tools", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;
  let client: Client;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_FIXTURES_DIR;
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

  afterEach(async () => {
    await client?.close();
  });

  it("list_sessions with source: 'codex' returns only Codex items, each carrying source", async () => {
    client = await connect();
    const result = await client.callTool({ name: "list_sessions", arguments: { source: "codex" } });
    const sessions = JSON.parse(textOf(result)) as Array<{ source: string; sessionId: string }>;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.source === "codex")).toBe(true);
  });

  it("list_sessions with no source merges both harnesses", async () => {
    client = await connect();
    const result = await client.callTool({ name: "list_sessions", arguments: {} });
    const sessions = JSON.parse(textOf(result)) as Array<{ source: string }>;
    expect(sessions.some((s) => s.source === "codex")).toBe(true);
    expect(sessions.some((s) => s.source === "claude-code")).toBe(true);
  });

  it("get_session_summary works for a Codex session via project: 'codex'", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { project: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(textOf(result)) as {
      source: string;
      codex: { turns: { count: number } };
      contextTimeline: { points: number };
    };
    expect(summary.source).toBe("codex");
    // Bulky series are trimmed to a compact shape, mirroring the Claude summary.
    expect(summary.codex.turns.count).toBeGreaterThan(0);
    expect(summary.contextTimeline.points).toBeGreaterThan(0);
  });

  it("get_session_summary still works for a Claude session (unchanged behavior)", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { project: CLAUDE_PROJECT, sessionId: CLAUDE_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(textOf(result)) as { subagents?: unknown };
    // toSummary() strips `subagents` entirely (use get_subagent_tree instead).
    expect(summary.subagents).toBeUndefined();
  });

  it("get_subagent_tree returns a clear, non-throwing error for a Codex session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_subagent_tree",
      arguments: { project: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not available for Codex sessions");
  });

  it("find_repetitions and get_task_executions also reject Codex sessions clearly", async () => {
    client = await connect();
    for (const name of ["find_repetitions", "get_task_executions"]) {
      const result = await client.callTool({
        name,
        arguments: { project: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    }
  });

  it("get_first_prompt works for a Codex session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_first_prompt",
      arguments: { project: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as { firstUserPrompt: string | null };
    expect(body.firstUserPrompt).toBe("Fix the flaky test in foo.spec.ts");
  });

  it("get_context_timeline works for a Codex session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_context_timeline",
      arguments: { project: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      contextTimeline: unknown[];
      compactions: unknown[];
    };
    expect(body.contextTimeline.length).toBeGreaterThan(0);
  });

  it("session-scoped tools 404 clearly for an unknown Codex session id", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { project: "codex", sessionId: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Session not found");
  });
});
