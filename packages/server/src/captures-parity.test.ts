/**
 * Byte-for-byte parity guard: the opt-in wire capture must be PURELY ADDITIVE.
 * Every non-diagnostic MCP tool must produce identical output whether the
 * captures directory is absent or present-but-empty — i.e. no core loop tool
 * reads captures. Only the diagnostic `inspect_wire` tool (JUNREI_DIAGNOSTICS
 * =1, mode: actual/hidden) touches the capture store, and it's excluded here.
 *
 * (The model for this is the same "representative responses, two configs,
 * assert identical" shape the OTel parity test uses.)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./mcp.js";

const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);
const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");
const CLAUDE_SESSION_ID = "11111111-1111-1111-1111-111111111111";

async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), createMcpServer().connect(serverTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

/** Representative core-loop tools — none of which should ever read captures. */
const EXISTING_TOOL_CALLS = [
  { name: "briefing", arguments: { days: 30 } },
  {
    name: "analyze_session",
    arguments: { source: "claude-code", sessionId: CLAUDE_SESSION_ID },
  },
  {
    name: "get_evidence",
    arguments: {
      source: "claude-code",
      sessionId: CLAUDE_SESSION_ID,
      select: { type: "first_prompt" },
    },
  },
  { name: "find_patterns", arguments: { kind: "text", query: "Fix the bug" } },
] as const;

async function collectResponses(): Promise<string[]> {
  const client = await connect();
  try {
    const out: string[] = [];
    for (const call of EXISTING_TOOL_CALLS) {
      out.push(textOf(await client.callTool(call)));
    }
    return out;
  } finally {
    await client.close();
  }
}

describe("captures are purely additive: existing tools are byte-identical with captures absent vs empty", () => {
  let emptyCapturesDir: string;
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;
  let previousCapturesDir: string | undefined;

  beforeAll(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    previousCapturesDir = process.env.JUNREI_CAPTURES_DIR;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
    emptyCapturesDir = await mkdtemp(join(tmpdir(), "junrei-parity-empty-caps-"));
  });

  afterAll(async () => {
    await rm(emptyCapturesDir, { recursive: true, force: true });
    for (const [key, prev] of [
      ["CLAUDE_CONFIG_DIR", previousConfigDir],
      ["CODEX_HOME", previousCodexHome],
      ["JUNREI_CAPTURES_DIR", previousCapturesDir],
    ] as const) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("produces identical responses for every existing tool", async () => {
    // Run A: captures dir ABSENT (points at a path that does not exist).
    process.env.JUNREI_CAPTURES_DIR = join(emptyCapturesDir, "does-not-exist");
    const absent = await collectResponses();

    // Run B: captures dir present but EMPTY.
    process.env.JUNREI_CAPTURES_DIR = emptyCapturesDir;
    const empty = await collectResponses();

    expect(absent).toEqual(empty);
    // And each response is non-trivial (guards against comparing two errors).
    for (const response of absent) expect(response.length).toBeGreaterThan(0);
  });
});
