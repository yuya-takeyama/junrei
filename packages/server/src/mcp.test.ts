import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionInsight, type LearningSource } from "@junrei/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./mcp.js";

const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);
const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");

const CLAUDE_SESSION_ID = "11111111-1111-1111-1111-111111111111";
const CODEX_SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** The always-on core loop surface. */
const CORE_TOOLS = [
  "briefing",
  "analyze_session",
  "find_patterns",
  "get_evidence",
  "log_learning",
  "review_learnings",
];
/** The opt-in diagnostic tools (JUNREI_DIAGNOSTICS=1 only). */
const DIAGNOSTIC_TOOLS = ["inspect_wire", "export_trace"];
/** Representative old-surface tool names that must no longer exist. */
const REMOVED_TOOLS = ["list_sessions", "get_session_summary", "get_bash_stats", "get_trends"];

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

interface Meta {
  approxTokens: number;
  truncated?: boolean;
  nextSteps?: string[];
}

describe("MCP loop surface", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;
  let previousDiagnostics: string | undefined;
  let client: Client;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    previousDiagnostics = process.env.JUNREI_DIAGNOSTICS;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
    delete process.env.JUNREI_DIAGNOSTICS;
  });

  afterAll(() => {
    for (const [key, value] of [
      ["CLAUDE_CONFIG_DIR", previousConfigDir],
      ["CODEX_HOME", previousCodexHome],
      ["JUNREI_DIAGNOSTICS", previousDiagnostics],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(async () => {
    await client?.close();
  });

  describe("registration", () => {
    it("registers exactly the six core tools, and none of the removed 20-tool surface", async () => {
      client = await connect();
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...CORE_TOOLS].sort());
      for (const removed of REMOVED_TOOLS) expect(names).not.toContain(removed);
    });

    it("omits the diagnostic tools unless JUNREI_DIAGNOSTICS=1", async () => {
      client = await connect();
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const diag of DIAGNOSTIC_TOOLS) expect(names).not.toContain(diag);
    });

    it("registers the diagnostic tools when JUNREI_DIAGNOSTICS=1", async () => {
      process.env.JUNREI_DIAGNOSTICS = "1";
      try {
        client = await connect();
        const names = (await client.listTools()).tools.map((t) => t.name);
        for (const diag of DIAGNOSTIC_TOOLS) expect(names).toContain(diag);
      } finally {
        delete process.env.JUNREI_DIAGNOSTICS;
      }
    });

    // The whole point of the 6+2 redesign: the always-on schema must stay
    // small. Research finding — a bloated tool schema is a per-request cost.
    it("keeps the total serialized tool schema + descriptions under ~5000 tokens", async () => {
      client = await connect();
      const { tools } = await client.listTools();
      const serialized = tools
        .map((t) =>
          JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }),
        )
        .join("");
      const approxTokens = Math.ceil(serialized.length / 4);
      expect(approxTokens).toBeLessThan(5000);
    });
  });

  describe("briefing", () => {
    it("returns a conclusion-first roll-up with a _meta envelope and nextSteps", async () => {
      client = await connect();
      const result = await client.callTool({ name: "briefing", arguments: { days: 30 } });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        summary: { costUsd: number; sessionCount: number };
        waste: unknown[];
        wins: unknown[];
        learnings: { open: number; applied: number; verified: number; rejected: number };
        topSessions: unknown[];
        _meta: Meta;
      };
      expect(body.summary.sessionCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.waste)).toBe(true);
      expect(body.learnings).toHaveProperty("open");
      expect(body._meta.approxTokens).toBeGreaterThan(0);
      expect(Array.isArray(body._meta.nextSteps)).toBe(true);
    });

    it("nextSteps guides the loop when the window is empty (tiny days on stale fixtures)", async () => {
      client = await connect();
      const result = await client.callTool({ name: "briefing", arguments: { days: 1 } });
      const body = JSON.parse(textOf(result)) as { summary: { sessionCount: number }; _meta: Meta };
      // Fixtures are older than 1 day from "now", so the window is empty and
      // nextSteps must tell the agent how to widen it.
      expect(body.summary.sessionCount).toBe(0);
      expect(body._meta.nextSteps?.join(" ")).toMatch(/widen|broader|days/i);
    });
  });

  describe("analyze_session", () => {
    it("returns a single-session insight with recommendations carrying a logLearningCall", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "analyze_session",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        sessionId: string;
        source: string;
        summary: { costUsd: number };
        costDrivers: unknown[];
        waste: unknown[];
        delegation: { subagentCount: number };
        recommendations: Array<{ logLearningCall: { finding: string; change: string } }>;
        _meta: Meta;
      };
      expect(body.sessionId).toBe(CLAUDE_SESSION_ID);
      expect(body.source).toBe("claude-code");
      expect(body.summary.costUsd).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.costDrivers)).toBe(true);
      for (const rec of body.recommendations) {
        expect(rec.logLearningCall.finding.length).toBeGreaterThan(0);
        expect(rec.logLearningCall.change.length).toBeGreaterThan(0);
      }
      expect(body._meta.approxTokens).toBeGreaterThan(0);
    });

    it("works for a Codex session and marks Claude-only features notAvailable", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "analyze_session",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { source: string; notAvailable?: string[] };
      expect(body.source).toBe("codex");
      expect(body.notAvailable).toContain("repetitions");
    });

    it("404s clearly for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "analyze_session",
        arguments: { source: "claude-code", sessionId: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });
  });

  describe("find_patterns", () => {
    it("kind: 'text' finds sessions across both harnesses", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "find_patterns",
        arguments: { kind: "text", query: "flaky test" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        kind: string;
        textHits: Array<{ source: string; sessionId: string; excerpt: string }>;
        _meta: Meta;
      };
      expect(body.kind).toBe("text");
      expect(
        body.textHits.some(
          (h) => h.source === "codex" && h.excerpt.toLowerCase().includes("flaky"),
        ),
      ).toBe(true);
    });

    it("kind: 'text' without a query errors clearly", async () => {
      client = await connect();
      const result = await client.callTool({ name: "find_patterns", arguments: { kind: "text" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("query");
    });

    it("kind: 'delegation' aggregates sessions by shape", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "find_patterns",
        arguments: { kind: "delegation", days: 30 },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        kind: string;
        delegationPatterns: Array<{ shape: string; sessionCount: number }>;
      };
      expect(body.kind).toBe("delegation");
      expect(Array.isArray(body.delegationPatterns)).toBe(true);
    });

    it("kind: 'waste' rolls up waste classes", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "find_patterns",
        arguments: { kind: "waste", days: 30 },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { kind: string; wastePatterns: unknown[] };
      expect(body.kind).toBe("waste");
      expect(Array.isArray(body.wastePatterns)).toBe(true);
    });
  });

  describe("get_evidence", () => {
    it("select.type 'record' returns one line's full detail", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_evidence",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          select: { type: "record", line: 3 },
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        kind: string;
        data: { line: number; detail: { kind: string } };
        _meta: Meta;
      };
      expect(body.kind).toBe("record");
      expect(body.data.line).toBe(3);
      expect(body.data.detail.kind).toBe("tool-call");
    });

    it("select.type 'tool_call' returns the call+result by toolUseId", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_evidence",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          select: { type: "tool_call", toolUseId: "toolu_read1" },
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        data: { call: { name: string }; result: { text: string } | null };
      };
      expect(body.data.call.name).toBe("Read");
      expect(body.data.result?.text).toBe("const x = 1;");
    });

    it("select.type 'first_prompt' returns the original task", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_evidence",
        arguments: {
          source: "codex",
          sessionId: CODEX_SESSION_ID,
          select: { type: "first_prompt" },
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { data: { firstUserPrompt: string | null } };
      expect(body.data.firstUserPrompt).toBe("Fix the flaky test in foo.spec.ts");
    });

    it("select.type 'task_executions' is notAvailable for a Codex session (never an error)", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_evidence",
        arguments: {
          source: "codex",
          sessionId: CODEX_SESSION_ID,
          select: { type: "task_executions" },
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { notAvailable?: boolean; _meta: Meta };
      expect(body.notAvailable).toBe(true);
      expect(body._meta.nextSteps?.length).toBeGreaterThan(0);
    });

    it("404s clearly for an unknown session id", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_evidence",
        arguments: {
          source: "claude-code",
          sessionId: "does-not-exist",
          select: { type: "first_prompt" },
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Session not found");
    });

    it("rejects agentId for a Codex session", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "get_evidence",
        arguments: {
          source: "codex",
          sessionId: CODEX_SESSION_ID,
          select: { type: "first_prompt" },
          agentId: "x",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("own");
    });
  });

  describe("log_learning + review_learnings (upsert loop)", () => {
    let repoPath: string;

    beforeAll(async () => {
      repoPath = await mkdtemp(join(tmpdir(), "junrei-learnings-"));
    });
    afterAll(async () => {
      await rm(repoPath, { recursive: true, force: true });
    });

    it("creates a learning without an id, then updates it through the applied transition", async () => {
      client = await connect();
      const created = await client.callTool({
        name: "log_learning",
        arguments: { repoPath, finding: "Bash used to read files", change: "Use the Read tool" },
      });
      expect(created.isError).not.toBe(true);
      const createdBody = JSON.parse(textOf(created)) as {
        created: boolean;
        path: string;
        learning: { id: string; status: string };
        _meta: Meta;
      };
      expect(createdBody.created).toBe(true);
      expect(createdBody.learning.status).toBe("open");
      expect(createdBody.path).toContain(join(".junrei", "learnings"));
      expect(createdBody._meta.nextSteps?.length).toBeGreaterThan(0);

      const id = createdBody.learning.id;
      const applied = await client.callTool({
        name: "log_learning",
        arguments: { repoPath, id, status: "applied" },
      });
      expect(applied.isError).not.toBe(true);
      const appliedBody = JSON.parse(textOf(applied)) as {
        created: boolean;
        learning: { status: string; appliedAt?: string };
      };
      expect(appliedBody.created).toBe(false);
      expect(appliedBody.learning.status).toBe("applied");
      expect(appliedBody.learning.appliedAt).toBeTruthy();
    });

    it("creating without finding/change errors clearly", async () => {
      client = await connect();
      const result = await client.callTool({ name: "log_learning", arguments: { repoPath } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/finding.*change|repo root/i);
    });

    it("updating a non-existent id errors clearly", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "log_learning",
        arguments: { repoPath, id: "L-19700101-nope", status: "applied" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    });

    it("review_learnings is read-only and attaches a before/after comparison to applied learnings", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "review_learnings",
        arguments: { repoPath, windowDays: 7 },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        windowDays: number;
        learnings: Array<{
          learning: { id: string; status: string };
          comparison?: {
            windowDays: number;
            after: unknown;
            suggestedVerification: { metric: string };
          };
        }>;
        _meta: Meta;
      };
      expect(body.windowDays).toBe(7);
      const applied = body.learnings.find((l) => l.learning.status === "applied");
      expect(applied?.comparison?.windowDays).toBe(7);
      expect(applied?.comparison?.suggestedVerification.metric).toBe("costPerDayUsd");
    });

    describe("sourceSessions provenance (dogfood fix: create-mode used to silently drop it)", () => {
      it("round-trips an actual analyze_session recommendation's logLearningCall verbatim", async () => {
        client = await connect();
        // A minimal-but-real buildSessionInsight fixture — same shape the live
        // bug was caught with (a large Bash result waste finding).
        const insight = buildSessionInsight({
          source: "claude-code",
          sessionId: "a19ae6e1-b2ef-4c11-8a1a-000000000001",
          title: "30k-char pnpm result inside",
          detail: "full",
          totalCostUsd: 5,
          costIsComplete: true,
          models: ["opus"],
          delegation: {
            main: { tokens: 1000, outputTokens: 400, costUsd: 5, messageCount: 10 },
            subagents: { tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
            byModel: [],
            costIsComplete: true,
          },
          opportunities: [
            {
              class: "large-result",
              title: "30k-char pnpm result inside",
              lever: "command-flag",
              fixText: "Use a quieter pnpm flag instead of piping the full output.",
              estUsdSaved: 0.5,
              savingsBasis: "heuristic",
              occurrenceCount: 1,
              totalChars: 30000,
              threads: ["main"],
              evidence: [],
            },
          ],
          byThread: [
            {
              thread: "main",
              calls: 1,
              errors: 0,
              inputChars: 10,
              resultChars: 30000,
              estimatedTokens: 8000,
              charsSharePct: 100,
            },
          ],
        });

        const recommendation = insight.recommendations[0];
        expect(recommendation).toBeDefined();
        const logLearningCall = recommendation?.logLearningCall;
        // The exact shape a real recommendation hands the caller: finding,
        // change, expectedEffect?, and — the field the bug dropped — sourceSessions.
        expect(logLearningCall?.sourceSessions).toEqual([
          {
            source: "claude-code",
            sessionId: "a19ae6e1-b2ef-4c11-8a1a-000000000001",
            title: "30k-char pnpm result inside",
          },
        ]);

        // Pass the logLearningCall payload VERBATIM, exactly as the tool
        // description and skill instruct — this is the call shape that used
        // to silently save `sourceSessions: []`.
        const created = await client.callTool({
          name: "log_learning",
          arguments: { repoPath, ...logLearningCall },
        });
        expect(created.isError).not.toBe(true);
        const body = JSON.parse(textOf(created)) as {
          learning: { sourceSessions: LearningSource[]; finding: string; change: string };
        };
        expect(body.learning.finding).toBe(logLearningCall?.finding);
        expect(body.learning.change).toBe(logLearningCall?.change);
        expect(body.learning.sourceSessions).toEqual(logLearningCall?.sourceSessions);
      });

      it("an explicit sourceSessions array alone is saved verbatim, multi-entry included", async () => {
        client = await connect();
        const sourceSessions: LearningSource[] = [
          { source: "claude-code", sessionId: "sess-x", title: "Session X" },
          { source: "codex", sessionId: "sess-y" },
        ];
        const created = await client.callTool({
          name: "log_learning",
          arguments: {
            repoPath,
            finding: "multi-session pattern",
            change: "generalize the fix",
            sourceSessions,
          },
        });
        expect(created.isError).not.toBe(true);
        const body = JSON.parse(textOf(created)) as {
          learning: { sourceSessions: LearningSource[] };
        };
        expect(body.learning.sourceSessions).toEqual(sourceSessions);
      });

      it("top-level source+sessionId alone still attaches single-session provenance (pre-existing behavior)", async () => {
        client = await connect();
        const created = await client.callTool({
          name: "log_learning",
          arguments: {
            repoPath,
            finding: "single-session finding",
            change: "single-session fix",
            source: "claude-code",
            sessionId: "sess-legacy",
          },
        });
        expect(created.isError).not.toBe(true);
        const body = JSON.parse(textOf(created)) as {
          learning: { sourceSessions: LearningSource[] };
        };
        expect(body.learning.sourceSessions).toEqual([
          { source: "claude-code", sessionId: "sess-legacy" },
        ]);
      });

      it("both present, top-level pair absent from the array: sourceSessions wins, pair is merged in", async () => {
        client = await connect();
        const created = await client.callTool({
          name: "log_learning",
          arguments: {
            repoPath,
            finding: "merge-in case",
            change: "merge-in fix",
            sourceSessions: [{ source: "claude-code", sessionId: "sess-x" }],
            source: "codex",
            sessionId: "sess-z",
          },
        });
        expect(created.isError).not.toBe(true);
        const body = JSON.parse(textOf(created)) as {
          learning: { sourceSessions: LearningSource[] };
        };
        expect(body.learning.sourceSessions).toEqual([
          { source: "claude-code", sessionId: "sess-x" },
          { source: "codex", sessionId: "sess-z" },
        ]);
      });

      it("both present, top-level pair already in the array: no duplicate is added", async () => {
        client = await connect();
        const sourceSessions: LearningSource[] = [
          { source: "claude-code", sessionId: "sess-x" },
          { source: "codex", sessionId: "sess-z" },
        ];
        const created = await client.callTool({
          name: "log_learning",
          arguments: {
            repoPath,
            finding: "no-dup case",
            change: "no-dup fix",
            sourceSessions,
            source: "codex",
            sessionId: "sess-z",
          },
        });
        expect(created.isError).not.toBe(true);
        const body = JSON.parse(textOf(created)) as {
          learning: { sourceSessions: LearningSource[] };
        };
        expect(body.learning.sourceSessions).toEqual(sourceSessions);
      });
    });
  });

  describe("diagnostics (JUNREI_DIAGNOSTICS=1)", () => {
    beforeAll(() => {
      process.env.JUNREI_DIAGNOSTICS = "1";
    });
    afterAll(() => {
      delete process.env.JUNREI_DIAGNOSTICS;
    });

    it("inspect_wire (mode: reconstructed) with no requestId returns the discovery listing", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "inspect_wire",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID, mode: "reconstructed" },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        mode: string;
        requests: Array<{ requestId?: string; ordinal: number; targetLine: number }>;
        sourceCompleteness: { sources: Array<{ source: string }> };
      };
      expect(body.mode).toBe("reconstructed");
      expect(body.requests.some((r) => r.requestId === "req_1")).toBe(true);
    });

    it("inspect_wire (mode: actual) declares captureAvailable: false when no captures exist", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "inspect_wire",
        arguments: {
          source: "claude-code",
          sessionId: CLAUDE_SESSION_ID,
          mode: "actual",
          requestId: "req_1",
        },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as { mode: string; captureAvailable: boolean };
      expect(body.mode).toBe("actual");
      expect(body.captureAvailable).toBe(false);
    });

    it("inspect_wire rejects Codex sessions", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "inspect_wire",
        arguments: { source: "codex", sessionId: CODEX_SESSION_ID, mode: "reconstructed" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Claude Code only");
    });

    it("export_trace returns a normalized evaluation trace for a Claude session", async () => {
      client = await connect();
      const result = await client.callTool({
        name: "export_trace",
        arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as {
        schema: string;
        events: unknown[];
        totalEvents: number;
        eventsTruncated: boolean;
      };
      expect(body.schema).toBe("junrei-evaluation-trace/v1");
      expect(Array.isArray(body.events)).toBe(true);
    });
  });
});
