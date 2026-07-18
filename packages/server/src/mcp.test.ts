import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  describe("get_reconstructed_request", () => {
    // CLAUDE_SESSION_ID's fixture records carry cwd "/Users/test/proj" and
    // version "2.1.202" (see packages/core/test/fixtures) — a synthetic
    // template for that exact cliVersion, written to a per-test temp dir and
    // injected via `JUNREI_TEMPLATES_DIR` (the SAME override-by-env seam
    // `beforeAll` above already uses for `CLAUDE_CONFIG_DIR`/`CODEX_HOME`),
    // drives the "full reconstruction" tests. The captured `cwd`/`sessionId`
    // literals are DELIBERATELY different from the fixture's own, so a
    // successful substitution is actually exercised, not a same-value no-op.
    const CAPTURED_CWD = "/synthetic/captured/cwd";
    const CAPTURED_SESSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const LONG_INSTRUCTIONS = `${"A".repeat(500)} session ${CAPTURED_SESSION_ID} synthetic instructions.`;
    const SYNTHETIC_TEMPLATE = {
      cliVersion: "2.1.202",
      capturedValues: { cwd: CAPTURED_CWD, sessionId: CAPTURED_SESSION_ID },
      system: [
        { text: `You are a synthetic identity block for cwd ${CAPTURED_CWD}.` },
        { text: LONG_INSTRUCTIONS },
      ],
      tools: [
        { name: "SyntheticTool", description: "synthetic", input_schema: { type: "object" } },
      ],
      params: { max_tokens: 999, stream: true },
    };

    let templatesDir: string | undefined;
    let previousTemplatesDir: string | undefined;

    beforeAll(() => {
      previousTemplatesDir = process.env.JUNREI_TEMPLATES_DIR;
    });

    afterEach(async () => {
      if (templatesDir !== undefined) {
        await rm(templatesDir, { recursive: true, force: true });
        templatesDir = undefined;
      }
      if (previousTemplatesDir === undefined) {
        delete process.env.JUNREI_TEMPLATES_DIR;
      } else {
        process.env.JUNREI_TEMPLATES_DIR = previousTemplatesDir;
      }
    });

    async function withSyntheticTemplate(): Promise<void> {
      templatesDir = await mkdtemp(join(tmpdir(), "junrei-mcp-recon-template-"));
      await mkdir(join(templatesDir, "2.1.202"), { recursive: true });
      await writeFile(
        join(templatesDir, "2.1.202", "template.json"),
        JSON.stringify(SYNTHETIC_TEMPLATE),
      );
      process.env.JUNREI_TEMPLATES_DIR = templatesDir;
    }

    it("with neither requestId nor line, returns the discovery listing instead of a reconstruction", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sessionId: string;
        source: string;
        requests: Array<{ requestId?: string; ordinal: number; targetLine: number }>;
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.sessionId).toBe(CLAUDE_SESSION_ID);
      expect(body.source).toBe("claude-code");
      expect(body.requests.length).toBeGreaterThan(0);
      expect(body.requests.some((r) => r.requestId === "req_1")).toBe(true);
      expect(body.sourceCompleteness.sources).toEqual([
        { source: "claude-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("is rejected for Codex sessions with a clear, explicit error", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    });

    it("returns a clear not-found error for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: { source: "claude-code", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    it("with no template for the session's CLI version, declares system/tools/params unknown rather than inventing them", async () => {
      // No `withSyntheticTemplate()` call — JUNREI_TEMPLATES_DIR points
      // nowhere (or wherever the ambient env has it, which never contains a
      // 2.1.202 template), so the filesystem provider finds nothing.
      process.env.JUNREI_TEMPLATES_DIR = await mkdtemp(join(tmpdir(), "junrei-mcp-recon-empty-"));
      templatesDir = process.env.JUNREI_TEMPLATES_DIR;

      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, requestId: "req_1" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        system: Array<{ text?: string; confidence: string }>;
        tools: { value?: unknown; confidence: string };
        params: {
          entries: Record<string, { value?: unknown; confidence: string }>;
          confidence?: string;
        };
        limitations: string[];
      };
      expect(body.system).toHaveLength(1);
      expect(body.system[0]?.confidence).toBe("unknown");
      expect(body.system[0]?.text).toBeUndefined();
      expect(body.tools.confidence).toBe("unknown");
      expect(body.tools.value).toBeUndefined();
      // No template ⇒ the section is section-level `unknown`, but the log-derived
      // model is STILL overlaid per-key (exact) — that's Defect 1's whole point.
      expect(body.params.confidence).toBe("unknown");
      expect(body.params.entries.model?.value).toBe("claude-fable-5");
      expect(body.params.entries.model?.confidence).toBe("exact");
      expect(body.limitations.some((l) => l.includes("no reconstruction template"))).toBe(true);
    });

    it("full reconstruction with a synthetic template provider: template-confidence system/tools/params (substituted), exact-confidence messages", async () => {
      await withSyntheticTemplate();

      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, requestId: "req_1" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sessionId: string;
        source: string;
        requestId?: string;
        targetLine: number;
        system: Array<{ text?: string; confidence: string; provenance: { kind: string } }>;
        tools: { value?: unknown[]; confidence: string };
        params: {
          entries: Record<
            string,
            { value?: unknown; confidence: string; provenance: { kind: string; lines?: number[] } }
          >;
          confidence?: string;
        };
        messages: Array<{
          role: string;
          content: Array<{ wireType: string; value?: unknown; confidence: string }>;
        }>;
        appliedRules: string[];
        limitations: string[];
        sourceCompleteness: { sources: Array<{ source: string }> };
      };

      expect(body.requestId).toBe("req_1");

      // Two template-confidence system blocks, substituted to the TARGET
      // session's own cwd/sessionId (not the captured literals), plus the
      // trailing declared-unknown billing-header block.
      expect(body.system).toHaveLength(3);
      expect(body.system[0]?.confidence).toBe("template");
      expect(body.system[0]?.text).toContain("/Users/test/proj");
      expect(body.system[0]?.text).not.toContain(CAPTURED_CWD);
      expect(body.system[1]?.confidence).toBe("template");
      expect(body.system[1]?.text).toContain(CLAUDE_SESSION_ID);
      expect(body.system[1]?.text).not.toContain(CAPTURED_SESSION_ID);
      expect(body.system[2]?.confidence).toBe("unknown");
      expect(body.system[2]?.text).toBeUndefined();

      expect(body.tools.confidence).toBe("template");
      expect(body.tools.value).toEqual(SYNTHETIC_TEMPLATE.tools);
      // params is now a PER-KEY map: template keys stay `template`; the model is
      // overlaid from the target assistant record's own log line (line 2 → req_1)
      // as `exact`, overriding any template default. No section-level confidence
      // when a template supplied params.
      expect(body.params.confidence).toBeUndefined();
      expect(body.params.entries.max_tokens?.value).toBe(999);
      expect(body.params.entries.max_tokens?.confidence).toBe("template");
      expect(body.params.entries.stream?.confidence).toBe("template");
      expect(body.params.entries.model?.value).toBe("claude-fable-5");
      expect(body.params.entries.model?.confidence).toBe("exact");
      expect(body.params.entries.model?.provenance).toMatchObject({ kind: "log", lines: [2] });

      // The one prior turn (line 1) replays byte-exact from the log.
      expect(body.messages.length).toBeGreaterThan(0);
      const firstBlock = body.messages[0]?.content[0];
      expect(firstBlock?.confidence).toBe("exact");
      expect(firstBlock?.value).toMatchObject({ type: "text", text: "Fix the bug in foo.ts" });

      expect(body.limitations.some((l) => l.toLowerCase().includes("subagent"))).toBe(true);
      expect(body.appliedRules.length).toBeGreaterThan(0);
      expect(body.sourceCompleteness.sources).toEqual([
        { source: "claude-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("caps a block's text/value at maxCharsPerBlock and flags the truncation explicitly with the full char count", async () => {
      await withSyntheticTemplate();

      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          requestId: "req_1",
          maxCharsPerBlock: 200,
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        system: Array<{
          text?: string;
          textTruncated: boolean;
          textFullCharCount?: number;
          confidence: string;
        }>;
      };
      // system[1] is the LONG_INSTRUCTIONS block (>500 chars) — cut at 200.
      const longBlock = body.system[1];
      expect(longBlock?.textTruncated).toBe(true);
      expect(longBlock?.text?.length).toBeLessThanOrEqual(201); // 200 chars + the "…" marker
      expect(longBlock?.textFullCharCount).toBeGreaterThan(200);

      // The short identity block (well under 200 chars) is untouched.
      const shortBlock = body.system[0];
      expect(shortBlock?.textTruncated).toBe(false);
      expect(shortBlock?.textFullCharCount).toBeUndefined();
    });

    it("returns a clear not-found error for a requestId that doesn't exist in this session", async () => {
      await withSyntheticTemplate();
      client = await connect();
      const result = await client.callTool({
        name: "get_reconstructed_request",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          requestId: "does-not-exist",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No reconstructable request found");
    });
  });

  describe("get_session_observability", () => {
    let otelDir: string | undefined;
    let previousOtelDir: string | undefined;

    beforeAll(() => {
      previousOtelDir = process.env.JUNREI_OTEL_DIR;
    });

    afterEach(async () => {
      if (otelDir !== undefined) {
        await rm(otelDir, { recursive: true, force: true });
        otelDir = undefined;
      }
      if (previousOtelDir === undefined) {
        delete process.env.JUNREI_OTEL_DIR;
      } else {
        process.env.JUNREI_OTEL_DIR = previousOtelDir;
      }
    });

    function otlpAttr(key: string, value: string | number) {
      return typeof value === "string"
        ? { key, value: { stringValue: value } }
        : { key, value: { doubleValue: value } };
    }

    function apiRequestLine(sessionId: string, costUsd: number, durationMs?: number) {
      const attributes = [
        otlpAttr("event.name", "api_request"),
        otlpAttr("cost_usd", costUsd),
        ...(durationMs !== undefined ? [otlpAttr("duration_ms", durationMs)] : []),
      ];
      return JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [otlpAttr("session.id", sessionId)] },
            scopeLogs: [{ logRecords: [{ attributes, body: { stringValue: "api_request" } }] }],
          },
        ],
      });
    }

    function toolDecisionLine(sessionId: string, toolName: string, decision: string) {
      return JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [otlpAttr("session.id", sessionId)] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      otlpAttr("event.name", "tool_decision"),
                      otlpAttr("tool_name", toolName),
                      otlpAttr("decision", decision),
                      otlpAttr("source", "config"),
                    ],
                    body: { stringValue: "tool_decision" },
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    function mcpHealthLine(sessionId: string) {
      return JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [otlpAttr("session.id", sessionId)] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      otlpAttr("event.name", "mcp_server_connection"),
                      otlpAttr("status", "failed"),
                    ],
                    body: { stringValue: "mcp_server_connection" },
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    function unrecognizedEventLine(sessionId: string) {
      return JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [otlpAttr("session.id", sessionId)] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [otlpAttr("event.name", "user_prompt")],
                    body: { stringValue: "user_prompt" },
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    async function writeOtelFixture(sessionId: string, lines: string[]): Promise<void> {
      otelDir = await mkdtemp(join(tmpdir(), "junrei-mcp-otel-"));
      process.env.JUNREI_OTEL_DIR = otelDir;
      await writeFile(join(otelDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
    }

    it("declares otelAvailable: false with a JUNREI_OTEL_DIR note when the feature is disabled entirely", async () => {
      delete process.env.JUNREI_OTEL_DIR;
      client = await connect();
      const result = await client.callTool({
        name: "get_session_observability",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        otelAvailable: boolean;
        note?: string;
        cost: { sessionLog: { costUsd: number; costBasis: string } };
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.otelAvailable).toBe(false);
      expect(body.note).toContain("JUNREI_OTEL_DIR");
      expect(body.note).toContain("disabled");
      // The session-log pricing-table estimate is still returned — never a silent empty.
      expect(body.cost.sessionLog.costBasis).toBe("pricing-table-estimate");
      expect(typeof body.cost.sessionLog.costUsd).toBe("number");
      expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
        "claude-otel",
      ]);
    });

    it("declares otelAvailable: false with a note when OTel is enabled but this session has no recorded data", async () => {
      otelDir = await mkdtemp(join(tmpdir(), "junrei-mcp-otel-empty-"));
      process.env.JUNREI_OTEL_DIR = otelDir;
      client = await connect();
      const result = await client.callTool({
        name: "get_session_observability",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        otelAvailable: boolean;
        note?: string;
        cost: { sessionLog: { costUsd: number } };
      };
      expect(body.otelAvailable).toBe(false);
      expect(body.note).toContain("JUNREI_OTEL_DIR");
      expect(body.note).toContain("no OTel data");
      expect(typeof body.cost.sessionLog.costUsd).toBe("number");
    });

    it("returns parsed OTel aggregates alongside the sessionLog estimate when data exists", async () => {
      await writeOtelFixture(CLAUDE_SESSION_ID, [
        apiRequestLine(CLAUDE_SESSION_ID, 0.01, 100),
        apiRequestLine(CLAUDE_SESSION_ID, 0.02, 300),
        toolDecisionLine(CLAUDE_SESSION_ID, "Bash", "accept"),
        mcpHealthLine(CLAUDE_SESSION_ID),
        unrecognizedEventLine(CLAUDE_SESSION_ID),
      ]);

      client = await connect();
      const result = await client.callTool({
        name: "get_session_observability",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        otelAvailable: boolean;
        cost: {
          sessionLog: { costUsd: number; costBasis: string };
          otel?: { costUsd: number; costBasis: string; source: string };
          deltaUsd?: number;
        };
        apiRequests: { count: number; duration?: { count: number; sumMs: number } };
        toolDecisions: { total: number; entries: unknown[]; truncated: boolean };
        health: {
          total: number;
          entries: Array<{ kind: string; eventName: string }>;
          truncated: boolean;
        };
        unrecognized: { events: Record<string, number>; metrics: Record<string, number> };
        raw: { logPayloads: number; metricPayloads: number; malformedLines: number };
        sourceCompleteness: { sources: Array<{ source: string }> };
      };

      expect(body.otelAvailable).toBe(true);
      expect(body.cost.sessionLog.costBasis).toBe("pricing-table-estimate");
      expect(body.cost.otel?.costBasis).toBe("otel");
      expect(body.cost.otel?.costUsd).toBeCloseTo(0.03, 6);
      expect(body.cost.otel?.source).toBe("api_request_events");
      expect(body.cost.deltaUsd).toBeCloseTo(0.03 - body.cost.sessionLog.costUsd, 6);

      expect(body.apiRequests.count).toBe(2);
      expect(body.apiRequests.duration).toEqual({
        count: 2,
        sumMs: 400,
        minMs: 100,
        maxMs: 300,
        avgMs: 200,
      });

      expect(body.toolDecisions.total).toBe(1);
      expect(body.toolDecisions.truncated).toBe(false);

      expect(body.health.total).toBe(1);
      expect(body.health.entries[0]).toMatchObject({
        kind: "mcp",
        eventName: "mcp_server_connection",
      });
      expect(body.health.truncated).toBe(false);

      expect(body.unrecognized.events).toEqual({ user_prompt: 1 });

      expect(body.raw.logPayloads).toBe(5);

      expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
        "claude-otel",
      ]);
    });

    it("caps toolDecisions.entries at maxToolDecisions while total stays exact", async () => {
      await writeOtelFixture(CLAUDE_SESSION_ID, [
        toolDecisionLine(CLAUDE_SESSION_ID, "A", "accept"),
        toolDecisionLine(CLAUDE_SESSION_ID, "B", "accept"),
        toolDecisionLine(CLAUDE_SESSION_ID, "C", "accept"),
      ]);

      client = await connect();
      const result = await client.callTool({
        name: "get_session_observability",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, maxToolDecisions: 2 },
      });
      const body = JSON.parse(textOf(result)) as {
        toolDecisions: { total: number; entries: unknown[]; truncated: boolean };
      };
      expect(body.toolDecisions.total).toBe(3);
      expect(body.toolDecisions.entries).toHaveLength(2);
      expect(body.toolDecisions.truncated).toBe(true);
    });

    it("is rejected for Codex sessions with a clear, explicit error", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_session_observability",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    });

    it("returns a clear not-found error for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_session_observability",
        arguments: { source: "claude-code", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });
  });

  describe("get_bash_stats", () => {
    // Fixture session 11111111 (CLAUDE_SESSION_ID) has exactly 3 Bash calls in
    // its MAIN transcript: two identical failing "pnpm test" calls (line 5,
    // line 8 — the second is a same-command rerun after the first's error)
    // and one run_in_background "sleep 10 && pnpm build" (line 23, completed
    // at line 25). Its only subagent (aaaa111122223333f) has no Bash calls at
    // all, so `includeSubagents: false` naturally reproduces the same totals
    // for THIS fixture — see the isolated-fixture describe block below for a
    // test where the two actually diverge.
    it("returns joint main+subagent rankings, waste, and background summaries by default", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sessionId: string;
        includeSubagents: boolean;
        totals: {
          calls: number;
          errors: number;
          inputChars: number;
          resultChars: number;
          estimatedTokens: number;
        };
        byCommand: {
          items: Array<{ family: string; subcommand?: string; calls: number; sharePct: number }>;
          totalCount: number;
          truncated: boolean;
        };
        programFrequency: { items: Array<{ program: string; count: number }> };
        heavyHitters: Array<{ resultChars: number; line: number; thread: string }>;
        background: {
          byStatus: { completed: number; failed: number; unresolved: number };
          tasks: { items: Array<{ taskId: string; status: string; wallClockMs?: number }> };
        };
        waste: {
          nearDuplicates: { items: unknown[] };
          largeResults: { items: unknown[] };
          rerunAfterError: {
            items: Array<{
              pattern: string;
              count: number;
              occurrences: Array<{ thread: string; errorLine: number; rerunLine: number }>;
            }>;
          };
          bashAsRead: { items: unknown[] };
        };
        sourceCompleteness: { sources: Array<{ source: string }> };
      };

      expect(body.includeSubagents).toBe(true);
      expect(body.totals).toEqual({
        calls: 3,
        errors: 2,
        inputChars: 40,
        resultChars: 97,
        estimatedTokens: 35,
      });

      expect(body.byCommand.items).toEqual([
        expect.objectContaining({ family: "pnpm", subcommand: "test", calls: 2, sharePct: 51.5 }),
        expect.objectContaining({ family: "sleep", calls: 1, sharePct: 48.5 }),
      ]);
      expect(body.byCommand.totalCount).toBe(2);
      expect(body.byCommand.truncated).toBe(false);

      // "sleep 10 && pnpm build" contributes a SECOND "pnpm" segment on top
      // of the two whole "pnpm test" calls — programFrequency counts every
      // pipeline/list segment, not just each call's primary command.
      const pnpmFreq = body.programFrequency.items.find((p) => p.program === "pnpm");
      expect(pnpmFreq?.count).toBe(3);

      expect(body.heavyHitters[0]).toMatchObject({ resultChars: 47, line: 23, thread: "main" });
      expect(body.heavyHitters[1]).toMatchObject({ resultChars: 25, line: 5 });
      expect(body.heavyHitters[2]).toMatchObject({ resultChars: 25, line: 8 });

      expect(body.background.byStatus).toEqual({ completed: 1, failed: 0, unresolved: 0 });
      expect(body.background.tasks.items).toHaveLength(1);
      expect(body.background.tasks.items[0]).toMatchObject({
        taskId: "bgtask01",
        status: "completed",
        wallClockMs: 15000,
      });

      expect(body.waste.rerunAfterError.items).toEqual([
        {
          pattern: "pnpm test",
          count: 1,
          occurrences: [{ thread: "main", errorLine: 5, rerunLine: 8 }],
        },
      ]);
      // "pnpm test" occurs only twice — below nearDuplicates' >=3 threshold.
      expect(body.waste.nearDuplicates.items).toEqual([]);
      expect(body.waste.largeResults.items).toEqual([]);
      expect(body.waste.bashAsRead.items).toEqual([]);

      expect(body.sourceCompleteness.sources).toEqual([
        { source: "claude-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("caps byCommand to topCommands while totalCount/truncated stay accurate", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, topCommands: 1 },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        byCommand: { items: unknown[]; totalCount: number; truncated: boolean };
      };
      expect(body.byCommand.items).toHaveLength(1);
      expect(body.byCommand.totalCount).toBe(2);
      expect(body.byCommand.truncated).toBe(true);
    });

    it("includeSubagents: false recomputes main-thread-only totals (same value here — this fixture's subagent has no Bash calls)", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, includeSubagents: false },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        includeSubagents: boolean;
        totals: { calls: number };
      };
      expect(body.includeSubagents).toBe(false);
      expect(body.totals.calls).toBe(3);
    });

    it("rejects topCommands out of bounds (min 1, max 100)", async () => {
      // Zod schema validation failures surface as a resolved CallToolResult
      // with isError: true (the MCP client wraps the JSON-RPC InvalidParams
      // error), not a rejected promise.
      client = await connect();
      const tooSmall = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, topCommands: 0 },
      });
      expect(tooSmall.isError).toBe(true);
      expect(textOf(tooSmall)).toContain("topCommands");

      const tooLarge = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, topCommands: 101 },
      });
      expect(tooLarge.isError).toBe(true);
      expect(textOf(tooLarge)).toContain("topCommands");
    });

    // CODEX_SESSION_ID's fixture (11111111...) carries no sub-agent forest,
    // so `includeSubagents: true` (default) and `false` return the SAME
    // main-thread-only value — this session's 2 genuine shell calls: call-1
    // (function_call "shell", `["pytest","foo.spec.ts"]`, errors via a
    // structured `{success:false}` output) and call-3 (`local_shell_call` +
    // `exec_command_end`, same command recovered from the event, errors via
    // `exit_code: 2`, a synthesized "exited with code 2" result text since
    // Codex records no real output for that wire surface). call-2
    // (`apply_patch`) is excluded — not a shell call.
    it("works for a Codex session: 2 shell calls, both errors, family/subcommand resolved, apply_patch excluded", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        includeSubagents: boolean;
        totals: { calls: number; errors: number; inputChars: number; resultChars: number };
        byCommand: { items: Array<{ family: string; subcommand?: string; calls: number }> };
        heavyHitters: Array<{ command: string; resultChars: number; thread: string }>;
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      const PYTEST_CMD_CHARS = "pytest foo.spec.ts".length;
      const REAL_OUTPUT_CHARS = "process exited with code 1".length;
      const SYNTHETIC_OUTPUT_CHARS = "exited with code 2".length;

      expect(body.includeSubagents).toBe(true);
      expect(body.totals).toEqual({
        calls: 2,
        errors: 2,
        inputChars: PYTEST_CMD_CHARS * 2,
        resultChars: REAL_OUTPUT_CHARS + SYNTHETIC_OUTPUT_CHARS,
        estimatedTokens: Math.ceil(
          (PYTEST_CMD_CHARS * 2 + REAL_OUTPUT_CHARS + SYNTHETIC_OUTPUT_CHARS) / 4,
        ),
      });
      expect(body.byCommand.items).toEqual([
        expect.objectContaining({ family: "pytest", calls: 2, errors: 2 }),
      ]);
      expect(body.heavyHitters.every((h) => h.thread === "main")).toBe(true);
      expect(body.sourceCompleteness.sources).toEqual([
        { source: "codex-session-jsonl", dimensions: expect.any(Object) },
      ]);

      const mainOnly = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, includeSubagents: false },
      });
      expect(mainOnly.isError).not.toBe(true);
      const mainOnlyBody = JSON.parse(textOf(mainOnly)) as { totals: { calls: number } };
      expect(mainOnlyBody.totals.calls).toBe(2);
    });

    it("404s clearly for an unknown Codex session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "codex", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    it("404s clearly for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    it("returns zeroed stats (not an error) for a session with no Bash calls", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_bash_stats",
        arguments: {
          source: "claude-code",
          sessionId: "22222222-2222-2222-2222-222222222222",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        totals: {
          calls: number;
          errors: number;
          inputChars: number;
          resultChars: number;
          estimatedTokens: number;
        };
        byCommand: { items: unknown[] };
        heavyHitters: unknown[];
        background: { tasks: { items: unknown[] } };
      };
      expect(body.totals).toEqual({
        calls: 0,
        errors: 0,
        inputChars: 0,
        resultChars: 0,
        estimatedTokens: 0,
      });
      expect(body.byCommand.items).toEqual([]);
      expect(body.heavyHitters).toEqual([]);
      expect(body.background.tasks.items).toEqual([]);
    });
  });

  describe("get_tool_calls", () => {
    it("lists Bash calls with family/subcommand and exact per-item metrics, sorted by line by default", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, toolName: "Bash" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        totalCount: number;
        toolCalls: Array<{
          toolUseId: string;
          line: number;
          toolName: string;
          thread: string;
          status: string;
          resultChars: number;
          durationMs?: number;
          inputSummary: string;
          family?: string;
          subcommand?: string;
        }>;
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.totalCount).toBe(3);
      expect(body.toolCalls.map((c) => c.line)).toEqual([5, 8, 23]);

      const bash1 = body.toolCalls.find((c) => c.toolUseId === "toolu_bash1");
      expect(bash1).toMatchObject({
        line: 5,
        toolName: "Bash",
        thread: "main",
        status: "error",
        resultChars: 25,
        durationMs: 2000,
        inputSummary: "pnpm test",
        family: "pnpm",
        subcommand: "test",
      });

      const bgBash = body.toolCalls.find((c) => c.toolUseId === "toolu_bgbash1");
      expect(bgBash).toMatchObject({ family: "sleep", resultChars: 47 });
      expect(bgBash?.subcommand).toBeUndefined();

      expect(body.sourceCompleteness.sources).toEqual([
        { source: "claude-session-jsonl", dimensions: expect.any(Object) },
      ]);
    });

    it("sorts by resultChars descending when requested", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolName: "Bash",
          sort: "resultChars",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        toolCalls: Array<{ toolUseId: string; resultChars: number }>;
      };
      expect(body.toolCalls.map((c) => c.resultChars)).toEqual([47, 25, 25]);
      expect(body.toolCalls[0]?.toolUseId).toBe("toolu_bgbash1");
      // Tie broken by line ascending: bash1 (line 5) before bash2 (line 8).
      expect(body.toolCalls[1]?.toolUseId).toBe("toolu_bash1");
      expect(body.toolCalls[2]?.toolUseId).toBe("toolu_bash2");
    });

    it("filters by status", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolName: "Bash",
          status: "error",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        totalCount: number;
        toolCalls: Array<{ status: string }>;
      };
      expect(body.totalCount).toBe(2);
      expect(body.toolCalls.every((c) => c.status === "error")).toBe(true);
    });

    it("filters by exact toolName", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          toolName: "Read",
          thread: "main",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        totalCount: number;
        toolCalls: Array<{ toolName: string }>;
      };
      expect(body.totalCount).toBe(4);
      expect(body.toolCalls.every((c) => c.toolName === "Read")).toBe(true);
    });

    it("paginates with limit/offset while totalCount reflects the full post-filter match count", async () => {
      client = await connect();
      const full = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, thread: "main" },
      });
      const fullBody = JSON.parse(textOf(full)) as {
        totalCount: number;
        toolCalls: Array<{ toolUseId: string }>;
      };
      // Every main-thread tool call in the fixture.
      expect(fullBody.totalCount).toBe(11);
      expect(fullBody.toolCalls).toHaveLength(11);

      const page = await client.callTool({
        name: "get_tool_calls",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          thread: "main",
          limit: 3,
          offset: 2,
        },
      });
      const pageBody = JSON.parse(textOf(page)) as {
        totalCount: number;
        toolCalls: Array<{ toolUseId: string }>;
      };
      expect(pageBody.totalCount).toBe(11);
      expect(pageBody.toolCalls).toHaveLength(3);
      expect(pageBody.toolCalls.map((c) => c.toolUseId)).toEqual(
        fullBody.toolCalls.slice(2, 5).map((c) => c.toolUseId),
      );
    });

    it("rejects limit/offset out of bounds", async () => {
      // See the analogous get_bash_stats bounds test: zod validation
      // failures come back as isError: true, not a rejected promise.
      client = await connect();
      const limitTooSmall = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, limit: 0 },
      });
      expect(limitTooSmall.isError).toBe(true);

      const limitTooLarge = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, limit: 201 },
      });
      expect(limitTooLarge.isError).toBe(true);

      const negativeOffset = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, offset: -1 },
      });
      expect(negativeOffset.isError).toBe(true);
    });

    // CODEX_SESSION_ID's fixture (11111111...) carries 4 tool calls total:
    // call-1 (function_call "shell", errors), call-2 (custom_tool_call
    // "apply_patch", no shell family), call-3 (local_shell_call, listed as
    // toolName "shell", errors via exec_command_end's exit_code).
    it("lists every Codex tool call generically, with family/subcommand set only for shell calls", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, sort: "line" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        totalCount: number;
        toolCalls: Array<{
          toolUseId: string;
          toolName: string;
          thread: string;
          status: string;
          family?: string;
          subcommand?: string;
        }>;
      };
      expect(body.totalCount).toBe(3);
      const byId = new Map(body.toolCalls.map((c) => [c.toolUseId, c]));
      expect(byId.get("call-1")).toMatchObject({
        toolName: "shell",
        thread: "main",
        status: "error",
        family: "pytest",
      });
      expect(byId.get("call-2")).toMatchObject({ toolName: "apply_patch", status: "ok" });
      expect(byId.get("call-2")?.family).toBeUndefined();
      expect(byId.get("call-3")).toMatchObject({
        toolName: "shell",
        thread: "main",
        status: "error",
        family: "pytest",
      });
    });

    it("filters Codex tool calls by toolName, matching Codex's own wire name", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, toolName: "apply_patch" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { totalCount: number };
      expect(body.totalCount).toBe(1);
    });

    it("404s clearly for an unknown Codex session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "codex", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    it("404s clearly for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    it("returns an empty result (not an error) when no calls match toolName", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_tool_calls",
        arguments: {
          source: "claude-code",
          sessionId: "22222222-2222-2222-2222-222222222222",
          toolName: "Bash",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { totalCount: number; toolCalls: unknown[] };
      expect(body.totalCount).toBe(0);
      expect(body.toolCalls).toEqual([]);
    });
  });

  describe("get_bash_stats / get_tool_calls — isolated fixture with a subagent Bash call", () => {
    // The shared CLAUDE_SESSION_ID fixture's only subagent carries no Bash
    // calls (see the comment on get_bash_stats' first test above), so it
    // can't exercise `includeSubagents: false` actually DIFFERING from the
    // default, or `get_tool_calls`' subagent thread walking returning a Bash
    // call. This block builds a small, self-contained session (main + one
    // subagent, each with exactly one Bash call) in a temp dir and merges it
    // into CLAUDE_CONFIG_DIR alongside the shared fixtures (comma-separated —
    // see `resolveClaudeProjectsDirs`), so it never touches the fixtures the
    // rest of this file — or other test files — depend on.
    const BASH_FIXTURE_SESSION_ID = "99999999-9999-9999-9999-999999999999";
    const BASH_FIXTURE_AGENT_ID = "subagent0000000001";
    const BASH_FIXTURE_PROJECT_DIR = "-tmp-bash-fixture-proj";

    let bashFixtureDir: string | undefined;
    let previousConfigDirForFixture: string | undefined;

    beforeAll(async () => {
      previousConfigDirForFixture = process.env.CLAUDE_CONFIG_DIR;
      bashFixtureDir = await mkdtemp(join(tmpdir(), "junrei-mcp-bashstats-fixture-"));
      const projectDir = join(bashFixtureDir, "projects", BASH_FIXTURE_PROJECT_DIR);
      const subagentsDir = join(projectDir, BASH_FIXTURE_SESSION_ID, "subagents");
      await mkdir(projectDir, { recursive: true });
      await mkdir(subagentsDir, { recursive: true });

      const mainLines = [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: BASH_FIXTURE_SESSION_ID,
          timestamp: "2026-07-18T00:00:00.000Z",
          isSidechain: false,
          cwd: "/tmp/bash-fixture",
          version: "2.1.202",
          message: { role: "user", content: "run a command" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: BASH_FIXTURE_SESSION_ID,
          timestamp: "2026-07-18T00:00:01.000Z",
          isSidechain: false,
          requestId: "req_1",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "claude-fable-5",
            content: [
              {
                type: "tool_use",
                id: "toolu_main_bash1",
                name: "Bash",
                input: { command: "echo hi" },
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          sessionId: BASH_FIXTURE_SESSION_ID,
          timestamp: "2026-07-18T00:00:02.000Z",
          isSidechain: false,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_main_bash1",
                is_error: null,
                content: "hi",
              },
            ],
          },
        },
      ];
      await writeFile(
        join(projectDir, `${BASH_FIXTURE_SESSION_ID}.jsonl`),
        `${mainLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      );

      const subLines = [
        {
          type: "user",
          uuid: "su1",
          parentUuid: null,
          sessionId: BASH_FIXTURE_SESSION_ID,
          agentId: BASH_FIXTURE_AGENT_ID,
          timestamp: "2026-07-18T00:00:10.000Z",
          isSidechain: true,
          message: { role: "user", content: "run a command too" },
        },
        {
          type: "assistant",
          uuid: "sa1",
          parentUuid: "su1",
          sessionId: BASH_FIXTURE_SESSION_ID,
          agentId: BASH_FIXTURE_AGENT_ID,
          timestamp: "2026-07-18T00:00:11.000Z",
          isSidechain: true,
          requestId: "sa_req_1",
          message: {
            id: "sa_msg_1",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [
              {
                type: "tool_use",
                id: "toolu_sub_bash1",
                name: "Bash",
                input: { command: "ls -la" },
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "user",
          uuid: "su2",
          parentUuid: "sa1",
          sessionId: BASH_FIXTURE_SESSION_ID,
          agentId: BASH_FIXTURE_AGENT_ID,
          timestamp: "2026-07-18T00:00:12.000Z",
          isSidechain: true,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_sub_bash1",
                is_error: null,
                content: "total 0",
              },
            ],
          },
        },
      ];
      await writeFile(
        join(subagentsDir, `agent-${BASH_FIXTURE_AGENT_ID}.jsonl`),
        `${subLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      );

      process.env.CLAUDE_CONFIG_DIR = `${CLAUDE_FIXTURES_DIR},${bashFixtureDir}`;
    });

    afterAll(async () => {
      if (previousConfigDirForFixture === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDirForFixture;
      }
      if (bashFixtureDir !== undefined) {
        await rm(bashFixtureDir, { recursive: true, force: true });
      }
    });

    it("includeSubagents true (default) counts the subagent's Bash call; false counts main-thread only", async () => {
      client = await connect();

      const withSub = await client.callTool({
        name: "get_bash_stats",
        arguments: { source: "claude-code", sessionId: BASH_FIXTURE_SESSION_ID },
      });
      expect(withSub.isError).not.toBe(true);
      const withSubBody = JSON.parse(textOf(withSub)) as { totals: { calls: number } };
      expect(withSubBody.totals.calls).toBe(2);

      const mainOnly = await client.callTool({
        name: "get_bash_stats",
        arguments: {
          source: "claude-code",
          sessionId: BASH_FIXTURE_SESSION_ID,
          includeSubagents: false,
        },
      });
      expect(mainOnly.isError).not.toBe(true);
      const mainOnlyBody = JSON.parse(textOf(mainOnly)) as { totals: { calls: number } };
      expect(mainOnlyBody.totals.calls).toBe(1);
    });

    it("get_tool_calls thread filter walks the subagent sidecar transcript", async () => {
      client = await connect();

      const all = await client.callTool({
        name: "get_tool_calls",
        arguments: { source: "claude-code", sessionId: BASH_FIXTURE_SESSION_ID, thread: "all" },
      });
      expect(all.isError).not.toBe(true);
      const allBody = JSON.parse(textOf(all)) as {
        totalCount: number;
        toolCalls: Array<{ thread: string }>;
      };
      expect(allBody.totalCount).toBe(2);
      expect(allBody.toolCalls.map((c) => c.thread).sort()).toEqual(
        ["main", BASH_FIXTURE_AGENT_ID].sort(),
      );

      const subagentsOnly = await client.callTool({
        name: "get_tool_calls",
        arguments: {
          source: "claude-code",
          sessionId: BASH_FIXTURE_SESSION_ID,
          thread: "subagents",
        },
      });
      expect(subagentsOnly.isError).not.toBe(true);
      const subagentsBody = JSON.parse(textOf(subagentsOnly)) as {
        totalCount: number;
        toolCalls: Array<{ thread: string; toolUseId: string; family?: string }>;
      };
      expect(subagentsBody.totalCount).toBe(1);
      expect(subagentsBody.toolCalls[0]).toMatchObject({
        thread: BASH_FIXTURE_AGENT_ID,
        toolUseId: "toolu_sub_bash1",
        family: "ls",
      });
    });
  });

  describe("get_actual_request / get_hidden_calls", () => {
    // CLAUDE_SESSION_ID's fixture log records req_1..req_10/req_7b (main) and
    // req_sa1/req_sa2 (subagent sidecar). We write a capture file for it with:
    //  - req_1     : a LOGGED main-loop call (also captured) — never "hidden".
    //  - req_hidden: a captured call whose id is NOT in the log — the hidden one.
    //  - req_sa1   : a captured SUBAGENT call, logged in the sidecar — not hidden
    //                (proves the join reads sidecar transcripts, not just main).
    const LONG_BODY_TEXT = "Z".repeat(400);
    const CAPTURE_LINES = [
      {
        requestId: "req_1",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        latencyMs: 123,
        isSubagent: false,
        requestBody: { model: "claude-fable-5", system: [{ text: LONG_BODY_TEXT }] },
        requestBytes: 450,
        responseBody: "event: message_stop\ndata: {}\n\n",
        assembledMessage: {
          model: "claude-fable-5",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
        responseBytes: 640,
      },
      {
        requestId: "req_hidden",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        latencyMs: 80,
        isSubagent: false,
        requestBody: { system: [{ text: "kicked off a Claude Code agent classifier" }] },
        requestBytes: 150,
        responseBody: null,
        assembledMessage: { model: "claude-haiku", usage: { input_tokens: 50, output_tokens: 2 } },
        responseBytes: 120,
      },
      {
        requestId: "req_sa1",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        latencyMs: 60,
        isSubagent: true,
        requestBody: { system: [{ text: "hdr cc_is_subagent=true" }] },
        requestBytes: 90,
        responseBody: null,
        assembledMessage: { model: "claude-fable-5", usage: { output_tokens: 3 } },
        responseBytes: 300,
      },
    ];

    let capturesDir: string | undefined;
    let previousCapturesDir: string | undefined;

    beforeAll(async () => {
      previousCapturesDir = process.env.JUNREI_CAPTURES_DIR;
      capturesDir = await mkdtemp(join(tmpdir(), "junrei-mcp-captures-"));
      await writeFile(
        join(capturesDir, `${CLAUDE_SESSION_ID}.jsonl`),
        `${CAPTURE_LINES.map((l) => JSON.stringify(l)).join("\n")}\n`,
      );
      process.env.JUNREI_CAPTURES_DIR = capturesDir;
    });

    afterAll(async () => {
      if (capturesDir !== undefined) await rm(capturesDir, { recursive: true, force: true });
      if (previousCapturesDir === undefined) delete process.env.JUNREI_CAPTURES_DIR;
      else process.env.JUNREI_CAPTURES_DIR = previousCapturesDir;
    });

    it("get_actual_request returns the captured body + response meta + latency, joined by requestId", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_actual_request",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, requestId: "req_1" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        captureAvailable: boolean;
        isSubagent: boolean;
        latencyMs: number;
        request: { body: { model?: string }; bodyTruncated: boolean; requestBytes: number };
        response: { status: number; model: string; usage: unknown; responseBytes: number };
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.captureAvailable).toBe(true);
      expect(body.isSubagent).toBe(false);
      expect(body.latencyMs).toBe(123);
      expect(body.request.body.model).toBe("claude-fable-5");
      expect(body.request.bodyTruncated).toBe(false);
      expect(body.request.requestBytes).toBe(450);
      expect(body.response.status).toBe(200);
      expect(body.response.model).toBe("claude-fable-5");
      expect(body.response.usage).toEqual({ input_tokens: 100, output_tokens: 5 });
      expect(body.response.responseBytes).toBe(640);
      // Declares both the log (for the join) and the wire capture (for the bytes).
      expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
        "claude-wire-capture",
      ]);
    });

    it("get_actual_request caps the request body with explicit truncation flags", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_actual_request",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          requestId: "req_1",
          maxCharsPerField: 200,
        },
      });
      const body = JSON.parse(textOf(result)) as {
        request: { body: unknown; bodyTruncated: boolean; bodyFullCharCount: number };
      };
      expect(body.request.bodyTruncated).toBe(true);
      expect(body.request.bodyFullCharCount).toBeGreaterThan(200);
      expect(typeof body.request.body).toBe("string"); // capped → stringified
    });

    it("get_actual_request declares requestNotCaptured for an uncaptured requestId (non-error)", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_actual_request",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, requestId: "req_nope" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        captureAvailable: boolean;
        requestNotCaptured: boolean;
      };
      expect(body.captureAvailable).toBe(true);
      expect(body.requestNotCaptured).toBe(true);
    });

    it("get_actual_request declares captureAvailable:false for a session with no capture file", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_actual_request",
        arguments: {
          source: "claude-code",
          sessionId: "22222222-2222-2222-2222-222222222222",
          requestId: "req_1",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { captureAvailable: boolean; note: string };
      expect(body.captureAvailable).toBe(false);
      expect(body.note).toContain("not captured");
    });

    it("get_actual_request is rejected for Codex sessions", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_actual_request",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, requestId: "req_1" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    });

    it("get_hidden_calls surfaces only captured calls absent from the log (main + sidecar joined)", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_hidden_calls",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        captureAvailable: boolean;
        hiddenCalls: Array<{ requestId: string; model?: string; isSubagent: boolean }>;
        counts: {
          capturedRequestCount: number;
          capturedWithRequestId: number;
          loggedRequestIdCount: number;
          hiddenCallCount: number;
        };
      };
      expect(body.captureAvailable).toBe(true);
      // req_1 is logged; req_sa1 is logged in the sidecar; only req_hidden is hidden.
      expect(body.hiddenCalls.map((c) => c.requestId)).toEqual(["req_hidden"]);
      expect(body.hiddenCalls[0]?.model).toBe("claude-haiku");
      expect(body.counts.capturedRequestCount).toBe(3);
      expect(body.counts.hiddenCallCount).toBe(1);
      // The log records at least the 11 main + 2 sidecar requestIds.
      expect(body.counts.loggedRequestIdCount).toBeGreaterThanOrEqual(13);
    });

    it("get_hidden_calls declares captureAvailable:false for a session with no capture file", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_hidden_calls",
        arguments: { source: "claude-code", sessionId: "22222222-2222-2222-2222-222222222222" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { captureAvailable: boolean };
      expect(body.captureAvailable).toBe(false);
    });

    it("get_hidden_calls is rejected for Codex sessions", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_hidden_calls",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    });
  });

  describe("export_evaluation_trace", () => {
    it("returns the envelope: schema, session, source-line-ordered events, subagent launch summarized, and a note pointing at the HTTP route", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "export_evaluation_trace",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sessionId: string;
        source: string;
        schema: string;
        session: { sessionId: string; cwd?: string };
        enrichment: {
          otel: { consulted: boolean; available: boolean };
          captures: { consulted: boolean; available: boolean };
        };
        limitations: string[];
        events: Array<{ name: string; provenance: { line?: number; requestId?: string } }>;
        totalEvents: number;
        eventsTruncated: boolean;
        note: string;
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.schema).toBe("junrei-evaluation-trace/v1");
      expect(body.session.sessionId).toBe(CLAUDE_SESSION_ID);
      expect(body.session.cwd).toBe("/Users/test/proj");
      expect(body.eventsTruncated).toBe(false);
      expect(body.totalEvents).toBe(body.events.length);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.some((e) => e.name === "gen_ai.user.message")).toBe(true);
      expect(body.events.some((e) => e.name === "gen_ai.assistant.message")).toBe(true);
      expect(body.events.some((e) => e.name === "gen_ai.tool.call")).toBe(true);
      expect(body.events.some((e) => e.name === "gen_ai.tool.result")).toBe(true);
      expect(body.events.some((e) => e.name === "gen_ai.request")).toBe(true);
      expect(body.events.some((e) => e.name === "junrei.subagent_launch")).toBe(true);
      expect(body.events.some((e) => e.name === "junrei.compaction")).toBe(true);
      expect(body.events.some((e) => e.name === "junrei.api_error")).toBe(true);
      // Every event's own line-anchored provenance stays in ascending source order.
      const lines = body.events
        .map((e) => e.provenance.line)
        .filter((l): l is number => l !== undefined);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
      // Locally-stored session: reconstruction WAS attempted (even with no
      // template configured, confidence just degrades to unknown — see
      // get_reconstructed_request's own "no template" test).
      expect(body.limitations.some((l) => l.includes("reconstruction summaries"))).toBe(false);
      // Opt-in channels declared, never silently absent.
      expect(body.enrichment.otel).toMatchObject({ consulted: true, available: false });
      expect(body.enrichment.captures).toMatchObject({ consulted: true, available: false });
      expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
      ]);
      expect(body.note).toContain(
        `/api/sessions/claude-code/${CLAUDE_SESSION_ID}/evaluation-trace`,
      );
    });

    it("caps events at maxEvents with an explicit eventsTruncated flag and exact totalEvents", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "export_evaluation_trace",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, maxEvents: 3 },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        events: unknown[];
        totalEvents: number;
        eventsTruncated: boolean;
      };
      expect(body.events).toHaveLength(3);
      expect(body.eventsTruncated).toBe(true);
      expect(body.totalEvents).toBeGreaterThan(3);
    });

    it("caps a long tool-result text at maxCharsPerField with explicit truncation flags", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "export_evaluation_trace",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, maxCharsPerField: 200 },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        events: Array<{
          name: string;
          attributes: {
            toolUseId?: string;
            text?: string;
            textTruncated?: boolean;
            textFullCharCount?: number;
          };
        }>;
      };
      // toolu_skill1's result is a 2200-char fixture string — well past the cap.
      const skillResult = body.events.find(
        (e) => e.name === "gen_ai.tool.result" && e.attributes.toolUseId === "toolu_skill1",
      );
      expect(skillResult?.attributes.textTruncated).toBe(true);
      expect(skillResult?.attributes.textFullCharCount).toBeGreaterThan(200);
      expect(skillResult?.attributes.text?.length).toBeLessThanOrEqual(201);
    });

    it("is rejected for Codex sessions", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "export_evaluation_trace",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not available for Codex sessions");
    });

    it("returns a clear not-found error for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "export_evaluation_trace",
        arguments: { source: "claude-code", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    describe("with OTel and wire capture configured", () => {
      let otelDir: string | undefined;
      let previousOtelDir: string | undefined;
      let capturesDir: string | undefined;
      let previousCapturesDir: string | undefined;

      function otlpAttr(key: string, value: string | number) {
        return typeof value === "string"
          ? { key, value: { stringValue: value } }
          : { key, value: { doubleValue: value } };
      }

      function apiRequestLine(sessionId: string, costUsd: number) {
        return JSON.stringify({
          resourceLogs: [
            {
              resource: { attributes: [otlpAttr("session.id", sessionId)] },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      attributes: [
                        otlpAttr("event.name", "api_request"),
                        otlpAttr("cost_usd", costUsd),
                      ],
                      body: { stringValue: "api_request" },
                    },
                  ],
                },
              ],
            },
          ],
        });
      }

      beforeAll(async () => {
        previousOtelDir = process.env.JUNREI_OTEL_DIR;
        otelDir = await mkdtemp(join(tmpdir(), "junrei-mcp-eval-otel-"));
        await writeFile(
          join(otelDir, `${CLAUDE_SESSION_ID}.jsonl`),
          `${apiRequestLine(CLAUDE_SESSION_ID, 0.42)}\n`,
        );
        process.env.JUNREI_OTEL_DIR = otelDir;

        previousCapturesDir = process.env.JUNREI_CAPTURES_DIR;
        capturesDir = await mkdtemp(join(tmpdir(), "junrei-mcp-eval-captures-"));
        const captureLines = [
          {
            requestId: "req_1",
            latencyMs: 111,
            isSubagent: false,
            requestBytes: 10,
            responseBytes: 20,
          },
          {
            requestId: "req_hidden_eval",
            latencyMs: 22,
            isSubagent: false,
            requestBody: {},
            assembledMessage: { model: "claude-haiku" },
            requestBytes: 5,
            responseBytes: 6,
          },
        ];
        await writeFile(
          join(capturesDir, `${CLAUDE_SESSION_ID}.jsonl`),
          `${captureLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        );
        process.env.JUNREI_CAPTURES_DIR = capturesDir;
      });

      afterAll(async () => {
        if (otelDir !== undefined) await rm(otelDir, { recursive: true, force: true });
        if (previousOtelDir === undefined) delete process.env.JUNREI_OTEL_DIR;
        else process.env.JUNREI_OTEL_DIR = previousOtelDir;
        if (capturesDir !== undefined) await rm(capturesDir, { recursive: true, force: true });
        if (previousCapturesDir === undefined) delete process.env.JUNREI_CAPTURES_DIR;
        else process.env.JUNREI_CAPTURES_DIR = previousCapturesDir;
      });

      it("declares both channels available, adds their sourceCompleteness kinds, joins capture latency onto the matching request, emits a hidden-call event, and never fabricates a per-request OTel join", async () => {
        client = await connect();
        const result = await client.callTool({
          name: "export_evaluation_trace",
          arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
        });
        expect(result.isError).not.toBe(true);
        const body = JSON.parse(textOf(result)) as {
          enrichment: {
            otel: { consulted: boolean; available: boolean; costUsd?: number };
            captures: { consulted: boolean; available: boolean; hiddenCallCount?: number };
          };
          events: Array<{
            name: string;
            provenance: { requestId?: string };
            attributes: Record<string, unknown>;
          }>;
          sourceCompleteness: { sources: Array<{ source: string }> };
        };
        expect(body.enrichment.otel).toMatchObject({
          consulted: true,
          available: true,
          costUsd: 0.42,
        });
        expect(body.enrichment.captures).toMatchObject({
          consulted: true,
          available: true,
          hiddenCallCount: 1,
        });
        expect(body.sourceCompleteness.sources.map((s) => s.source)).toEqual([
          "claude-session-jsonl",
          "claude-otel",
          "claude-wire-capture",
        ]);
        const req1 = body.events.find(
          (e) => e.name === "gen_ai.request" && e.provenance.requestId === "req_1",
        );
        expect(req1?.attributes.capture).toMatchObject({ latencyMs: 111 });
        const hidden = body.events.find((e) => e.name === "junrei.hidden_api_call");
        expect(hidden?.attributes).toMatchObject({
          requestId: "req_hidden_eval",
          model: "claude-haiku",
        });
        // OTel never attaches a per-request field — see the tool description's join-semantics note.
        for (const event of body.events) {
          if (event.name === "gen_ai.request") expect(event.attributes.otel).toBeUndefined();
        }
      });
    });
  });
});
