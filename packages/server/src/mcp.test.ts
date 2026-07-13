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

  it("get_session_summary works for a Codex session via source: 'codex'", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
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

  it("get_session_summary works for a Claude session via source: 'claude-code' + sessionId alone (no project needed)", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(textOf(result)) as {
      subagents?: unknown;
      delegation?: { main: { tokens: number }; subagents: { tokens: number } };
    };
    // toSummary() strips `subagents` entirely (use get_subagent_tree instead).
    expect(summary.subagents).toBeUndefined();
    // ...but `delegation` (the main-vs-subagents split) is NOT stripped — a
    // consumer shouldn't have to subtract `usage` from `totalUsage` itself.
    expect(summary.delegation?.main.tokens).toBeGreaterThan(0);
    expect(summary.delegation?.subagents.tokens).toBeGreaterThan(0);
  });

  it("session-scoped tools 404 clearly for an unknown Claude session id", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { source: "claude-code", sessionId: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Session not found");
  });

  it("get_subagent_tree works for a Codex session too (a leaf session with no sub-agents)", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_subagent_tree",
      arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as { subagentCount: number; subagents: unknown[] };
    expect(body.subagentCount).toBe(0);
    expect(body.subagents).toEqual([]);
  });

  it("get_subagent_tree returns a real sub-agent forest for a Codex parent session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_subagent_tree",
      arguments: {
        source: "codex",
        sessionId: "77777777-7777-7777-7777-777777777777",
      },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      subagentCount: number;
      subagents: Array<{ agentId: string }>;
    };
    expect(body.subagentCount).toBe(2);
    expect(body.subagents).toHaveLength(1);
    expect(body.subagents[0]?.agentId).toBe("88888888-8888-8888-8888-888888888888");
  });

  it("get_session_summary's delegation split is forest-inclusive for a Codex parent session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { source: "codex", sessionId: "77777777-7777-7777-7777-777777777777" },
    });
    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(textOf(result)) as {
      delegation?: { main: { tokens: number }; subagents: { tokens: number } };
    };
    // Computed at serve time from the forest-rolled-up totalUsage — not the
    // own-thread-only value `analyzeCodexSession` attaches at parse time.
    expect(summary.delegation?.subagents.tokens).toBeGreaterThan(0);
  });

  it("get_session_summary's delegation split is an all-zero subagents slice for a Codex leaf session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(textOf(result)) as {
      delegation?: { subagents: { tokens: number; outputTokens: number; costUsd?: number } };
    };
    expect(summary.delegation?.subagents).toEqual({
      tokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
    });
  });

  it("find_repetitions and get_task_executions also reject Codex sessions clearly", async () => {
    client = await connect();
    for (const name of ["find_repetitions", "get_task_executions"]) {
      const result = await client.callTool({
        name,
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    }
  });

  it("get_first_prompt works for a Codex session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_first_prompt",
      arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as { firstUserPrompt: string | null };
    expect(body.firstUserPrompt).toBe("Fix the flaky test in foo.spec.ts");
  });

  it("get_context_timeline works for a Codex session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_context_timeline",
      arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
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
      arguments: { source: "codex", sessionId: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Session not found");
  });

  it("tools/list includes get_repo_overview", async () => {
    client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_repo_overview");
  });

  it("tools/list includes search_sessions", async () => {
    client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("search_sessions");
  });

  it("search_sessions finds sessions from both harnesses with drill-in refs", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "search_sessions",
      arguments: { query: "flaky test" },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      results: Array<{
        source: string;
        sessionId: string;
        matches: Array<{ line: number; field: string; snippet: string }>;
      }>;
      resultsTruncated: boolean;
    };
    const codexHit = body.results.find(
      (r) => r.source === "codex" && r.sessionId === CODEX_SESSION_ID,
    );
    expect(codexHit).toBeDefined();
    expect(codexHit?.matches[0]?.field).toBe("user");
    expect(codexHit?.matches[0]?.snippet).toContain("flaky test");
    expect(codexHit?.matches[0]?.line).toBeGreaterThan(0);
  });

  it("search_sessions scoped to one Claude session returns its project ref", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "search_sessions",
      arguments: { query: "Fix the bug", sessionId: CLAUDE_SESSION_ID, source: "claude-code" },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      results: Array<{ source: string; sessionId: string; project?: string }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.project).toBe(CLAUDE_PROJECT);
  });

  it("search_sessions rejects unparseable since/until and blank queries", async () => {
    client = await connect();
    const badDate = await client.callTool({
      name: "search_sessions",
      arguments: { query: "anything", since: "not-a-date" },
    });
    expect(badDate.isError).toBe(true);
    expect(textOf(badDate)).toContain("since");

    const blank = await client.callTool({
      name: "search_sessions",
      arguments: { query: "  " },
    });
    expect(blank.isError).toBe(true);
  });

  it("get_repo_overview aggregates every Claude session sharing a repoRoot", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_repo_overview",
      arguments: { repo: "/Users/test/proj" },
    });
    expect(result.isError).not.toBe(true);
    const overview = JSON.parse(textOf(result)) as {
      repo: string;
      sessionCount: number;
      totalCostUsd: number;
      totalTokens: number;
      costIsComplete: boolean;
      topSessions: Array<{ sessionId: string }>;
    };
    // Fixture session 11111111... is the only one whose cwd (/Users/test/proj)
    // has no `.claude/worktrees/` marker and no sibling sharing that exact
    // repoRoot — same aggregate `computeRepoOverview` (overview.test.ts) would
    // report for a single-session repo.
    expect(overview.repo).toBe("/Users/test/proj");
    expect(overview.sessionCount).toBe(1);
    expect(overview.totalCostUsd).toBeCloseTo(0.0973225, 6);
    expect(overview.totalTokens).toBe(55695);
    expect(overview.costIsComplete).toBe(true);
    expect(overview.topSessions[0]?.sessionId).toBe(CLAUDE_SESSION_ID);
  });

  it("get_repo_overview merges Codex sessions sharing a repoRoot and flags incomplete pricing", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_repo_overview",
      arguments: { repo: "/Users/test/codex-proj" },
    });
    expect(result.isError).not.toBe(true);
    const overview = JSON.parse(textOf(result)) as {
      sessionCount: number;
      sourceCounts: { "claude-code": number; codex: number };
      costIsComplete: boolean;
    };
    expect(overview.sessionCount).toBe(4);
    expect(overview.sourceCounts).toEqual({ "claude-code": 0, codex: 4 });
    // One of the merged sessions carries an unpriced "unknown" model — see
    // computeRepoOverview's costIsComplete AND-across-sessions behavior.
    expect(overview.costIsComplete).toBe(false);
  });

  it("get_repo_overview rejects a blank repo the same way get_session_summary rejects a missing project", async () => {
    client = await connect();
    const result = await client.callTool({ name: "get_repo_overview", arguments: { repo: "" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("repo is required");
  });

  it("get_repo_overview returns a zeroed overview (not an error) for a repo matching no session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_repo_overview",
      arguments: { repo: "/no/such/repo" },
    });
    expect(result.isError).not.toBe(true);
    const overview = JSON.parse(textOf(result)) as { sessionCount: number; totalCostUsd: number };
    expect(overview.sessionCount).toBe(0);
    expect(overview.totalCostUsd).toBe(0);
  });
});
