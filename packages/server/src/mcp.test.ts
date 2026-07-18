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
    const body = JSON.parse(textOf(result)) as {
      sessions: Array<{ source: string; sessionId: string }>;
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.sessions.every((s) => s.source === "codex")).toBe(true);
    // Filtered to one harness: only that harness's completeness is declared.
    expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual(["codex-session-jsonl"]);
  });

  it("list_sessions with no source merges both harnesses, and sourceCompleteness reports both sources", async () => {
    client = await connect();
    const result = await client.callTool({ name: "list_sessions", arguments: {} });
    const body = JSON.parse(textOf(result)) as {
      sessions: Array<{ source: string }>;
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    expect(body.sessions.some((s) => s.source === "codex")).toBe(true);
    expect(body.sessions.some((s) => s.source === "claude-code")).toBe(true);
    // Unfiltered multi-source call: both entries, statically, regardless of
    // what the merged result set actually contains.
    expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "codex-session-jsonl",
    ]);
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
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    expect(summary.source).toBe("codex");
    // Bulky series are trimmed to a compact shape, mirroring the Claude summary.
    expect(summary.codex.turns.count).toBeGreaterThan(0);
    expect(summary.contextTimeline.points).toBeGreaterThan(0);
    expect(summary.sourceCompleteness.sources).toEqual([
      { source: "codex-session-jsonl", dimensions: expect.any(Object) },
    ]);
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
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    // toSummary() strips `subagents` entirely (use get_subagent_tree instead).
    expect(summary.subagents).toBeUndefined();
    // ...but `delegation` (the main-vs-subagents split) is NOT stripped — a
    // consumer shouldn't have to subtract `usage` from `totalUsage` itself.
    expect(summary.delegation?.main.tokens).toBeGreaterThan(0);
    expect(summary.delegation?.subagents.tokens).toBeGreaterThan(0);
    // Claude-scoped call: sourceCompleteness reports only the claude entry.
    expect(summary.sourceCompleteness.sources).toHaveLength(1);
    expect(summary.sourceCompleteness.sources[0]?.source).toBe("claude-session-jsonl");
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
    const body = JSON.parse(textOf(result)) as {
      subagentCount: number;
      subagents: unknown[];
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    expect(body.subagentCount).toBe(0);
    expect(body.subagents).toEqual([]);
    expect(body.sourceCompleteness.sources.length).toBeGreaterThan(0);
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

  it("find_repetitions and get_task_executions succeed for Claude sessions and report sourceCompleteness", async () => {
    client = await connect();
    for (const name of ["find_repetitions", "get_task_executions"]) {
      const result = await client.callTool({
        name,
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.sourceCompleteness.sources).toHaveLength(1);
      expect(body.sourceCompleteness.sources[0]?.source).toBe("claude-session-jsonl");
    }
  });

  it("get_first_prompt works for a Codex session", async () => {
    client = await connect();
    const result = await client.callTool({
      name: "get_first_prompt",
      arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      firstUserPrompt: string | null;
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    expect(body.firstUserPrompt).toBe("Fix the flaky test in foo.spec.ts");
    expect(body.sourceCompleteness.sources.length).toBeGreaterThan(0);
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
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    expect(body.contextTimeline.length).toBeGreaterThan(0);
    expect(body.sourceCompleteness.sources.length).toBeGreaterThan(0);
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
      sourceCompleteness: { sources: Array<{ source: string }> };
    };
    const codexHit = body.results.find(
      (r) => r.source === "codex" && r.sessionId === CODEX_SESSION_ID,
    );
    expect(codexHit).toBeDefined();
    expect(codexHit?.matches[0]?.field).toBe("user");
    expect(codexHit?.matches[0]?.snippet).toContain("flaky test");
    expect(codexHit?.matches[0]?.line).toBeGreaterThan(0);
    // Multi-source tool: both entries, statically.
    expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "codex-session-jsonl",
    ]);
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
      sourceCompleteness: { sources: Array<{ source: string }> };
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
    // Multi-source tool: both entries, statically, even though this repo
    // only has Claude sessions.
    expect(overview.sourceCompleteness.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "codex-session-jsonl",
    ]);
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

  describe("get_records", () => {
    it("returns full record content with correct line numbers, and lists an out-of-range line in missingLines", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_records",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          lines: [3, 27, 99999],
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sessionId: string;
        source: string;
        records: Array<{
          line: number;
          detail: Record<string, unknown>;
          contentTruncated: boolean;
        }>;
        missingLines: number[];
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.sessionId).toBe(CLAUDE_SESSION_ID);
      expect(body.source).toBe("claude-code");
      expect(body.records).toHaveLength(2);

      const toolCall = body.records.find((r) => r.line === 3);
      expect(toolCall?.detail).toMatchObject({
        kind: "tool-call",
        toolUseId: "toolu_read1",
        name: "Read",
        input: { file_path: "/p/foo.ts" },
        resultText: "const x = 1;",
        resultLine: 4,
      });
      expect(toolCall?.contentTruncated).toBe(false);

      const assistantText = body.records.find((r) => r.line === 27);
      expect(assistantText?.detail).toMatchObject({ kind: "assistant-text", text: "All done." });

      // Line 4 is a tool_result-only carrier — not independently addressable
      // — and 99999 is past the end of the file; neither is silently dropped.
      expect(body.missingLines).toEqual([99999]);
      expect(body.sourceCompleteness.sources).toEqual([
        { source: "claude-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("flags contentTruncated with a small maxCharsPerRecord and actually caps the returned (recovered, full) text", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_records",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          lines: [29], // toolu_skill1 tool_use — its result (line 30) is 2200 raw chars
          maxCharsPerRecord: 200,
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        records: Array<{
          line: number;
          detail: { kind: string; resultText?: string };
          contentTruncated: boolean;
          originalCharCount?: number;
        }>;
      };
      const record = body.records[0];
      expect(record?.contentTruncated).toBe(true);
      expect(record?.detail.resultText?.length).toBeLessThanOrEqual(201);
      expect(record?.detail.resultText?.endsWith("…")).toBe(true);
      // originalCharCount sums EVERY text-bearing field's pre-cut length
      // (input's JSON-stringified length too, not just resultText) — at
      // least the TRUE 2200-char tool_result (recovered from the raw source
      // line), not just the 2000 chars the parser itself captured.
      expect(record?.originalCharCount).toBeGreaterThanOrEqual(2200);
    });

    it("returns the full 2200-char result text by default (recovered from the raw source line), not the parser's 2000-char capture cap", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_records",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, lines: [29] },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        records: Array<{ detail: { resultText?: string }; contentTruncated: boolean }>;
      };
      // Default maxCharsPerRecord (30000) easily fits the true 2200-char
      // result — the record-detail path recovers the full text from the raw
      // JSONL line instead of silently handing back the parser's own
      // upstream-capped 2000-char snapshot with contentTruncated: false.
      expect(body.records[0]?.detail.resultText?.length).toBe(2200);
      expect(body.records[0]?.contentTruncated).toBe(false);
    });

    it("works for a Codex session, resolving full tool-call content by line", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_records",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, lines: [4, 6] },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        source: string;
        records: Array<{ line: number; detail: Record<string, unknown> }>;
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.source).toBe("codex");
      const user = body.records.find((r) => r.line === 4);
      expect(user?.detail).toMatchObject({
        kind: "user",
        text: "Fix the flaky test in foo.spec.ts",
      });
      const shell = body.records.find((r) => r.line === 6);
      expect(shell?.detail).toMatchObject({
        kind: "tool-call",
        toolUseId: "call-1",
        input: { command: ["pytest", "foo.spec.ts"] },
      });
      expect(body.sourceCompleteness.sources).toEqual([
        { source: "codex-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("404s clearly for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_records",
        arguments: { source: "claude-code", sessionId: "does-not-exist", lines: [1] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });
  });

  describe("get_tool_call", () => {
    it("returns the call and result as one evidence unit with plausible line numbers and full content", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolUseId: "toolu_read1",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        toolUseId: string;
        call: { name: string; input: unknown; line: number; inputTruncated: boolean };
        result: { isError: boolean; text: string; line: number; textTruncated: boolean } | null;
        resultMissing: boolean;
        relatedRecords: unknown[];
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.toolUseId).toBe("toolu_read1");
      expect(body.call).toMatchObject({
        name: "Read",
        input: { file_path: "/p/foo.ts" },
        line: 3,
        inputTruncated: false,
      });
      expect(body.result).toMatchObject({ isError: false, text: "const x = 1;", line: 4 });
      expect(body.result?.textTruncated).toBe(false);
      expect(body.resultMissing).toBe(false);
      expect(body.relatedRecords).toEqual([]);
      expect(body.sourceCompleteness.sources).toEqual([
        { source: "claude-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("declares result: null and resultMissing: true instead of silently omitting a missing result", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolUseId: "toolu_webfetch1", // never resulted in the fixture
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { result: unknown; resultMissing: boolean };
      expect(body.result).toBeNull();
      expect(body.resultMissing).toBe(true);
    });

    it("flags result.textTruncated with a small maxCharsPerField and reports the TRUE full char count", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolUseId: "toolu_skill1", // result is 2200 raw chars, parser-capped to 2000
          maxCharsPerField: 200,
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        result: { text: string; textTruncated: boolean; textFullCharCount?: number } | null;
      };
      expect(body.result?.textTruncated).toBe(true);
      expect(body.result?.text.length).toBeLessThanOrEqual(201);
      // The TRUE original count (2200), not the parser's own 2000-char capture cap.
      expect(body.result?.textFullCharCount).toBe(2200);
    });

    it("returns the full 2200-char result text at the default maxCharsPerField (recovered from the raw source line)", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolUseId: "toolu_skill1",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        result: { text: string; textTruncated: boolean; textFullCharCount?: number } | null;
      };
      // Default maxCharsPerField (30000) never cuts a 2200-char string, and
      // the drill-down evidence path now recovers the tool's true 2200-char
      // output from the raw source line instead of handing back the
      // parser's own 2000-char capture cap — genuinely complete, not just
      // under the caller's own limit.
      expect(body.result?.text.length).toBe(2200);
      expect(body.result?.textTruncated).toBe(false);
      expect(body.result?.textFullCharCount).toBeUndefined();
    });

    it("returns a clear not-found error for an unknown toolUseId", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolUseId: "does-not-exist",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("toolUseId not found");
    });

    it("works for a Codex session (function_call/local_shell_call pairing), with no uuid and no relatedRecords", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, toolUseId: "call-3" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        call: { name: string; uuid?: string };
        result: { isError: boolean; text: string } | null;
        relatedRecords: unknown[];
      };
      expect(body.call.name).toBe("shell");
      expect(body.call.uuid).toBeUndefined();
      expect(body.result).toMatchObject({ isError: true, text: "exited with code 2" });
      expect(body.relatedRecords).toEqual([]);
    });

    it("404s clearly for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_call",
        arguments: { source: "claude-code", sessionId: "does-not-exist", toolUseId: "anything" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });
  });
});
