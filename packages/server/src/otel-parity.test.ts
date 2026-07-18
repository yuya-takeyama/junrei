/**
 * Goshuin Phase E's hard acceptance criterion (docs/milestones/goshuin.md,
 * Decision 7): with `JUNREI_OTEL_DIR` unset, EVERY existing HTTP/MCP
 * response must be byte-for-byte identical to current `main` — the OTel
 * receiver/tool must be a true no-op when disabled, not just "behaves the
 * same in spirit". This file is the explicit regression proof: it renders a
 * representative set of pre-existing responses (two MCP tools via the
 * in-memory transport, same setup `mcp.test.ts` uses; one HTTP route) with
 * `JUNREI_OTEL_DIR` unset vs. set to a real-but-EMPTY dir, and asserts exact
 * string equality — not just status/shape equality, the literal bytes. It
 * also proves the `/otlp/*` routes 404 exactly like any other unregistered
 * route while disabled (see `app.ts`'s `handleOtlpExport` doc comment for
 * why that's true even though the routes stay registered internally).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createMcpServer } from "./mcp.js";

const CLAUDE_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../core/test/fixtures",
);
const CODEX_HOME = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/codex-home");
const CLAUDE_SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** Call one MCP tool over a fresh in-memory client/server pair (mirrors mcp.test.ts's `connect`), returning its raw text content. */
async function callToolText(name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "otel-parity-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), createMcpServer().connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const first = content[0];
    if (first?.type !== "text" || first.text === undefined) {
      throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
    }
    return first.text;
  } finally {
    await client.close();
  }
}

describe("byte-for-byte parity: JUNREI_OTEL_DIR unset vs. set-but-empty", () => {
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;
  let previousOtelDir: string | undefined;
  let emptyOtelDir: string;

  beforeAll(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_FIXTURES_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  beforeEach(async () => {
    previousOtelDir = process.env.JUNREI_OTEL_DIR;
    delete process.env.JUNREI_OTEL_DIR;
    emptyOtelDir = await mkdtemp(join(tmpdir(), "junrei-otel-parity-"));
  });

  afterEach(async () => {
    await rm(emptyOtelDir, { recursive: true, force: true });
    if (previousOtelDir === undefined) delete process.env.JUNREI_OTEL_DIR;
    else process.env.JUNREI_OTEL_DIR = previousOtelDir;
  });

  it("MCP get_session_summary: identical bytes with JUNREI_OTEL_DIR unset vs. set-but-empty", async () => {
    delete process.env.JUNREI_OTEL_DIR;
    const withoutOtel = await callToolText("get_session_summary", {
      source: "claude-code",
      sessionId: CLAUDE_SESSION_ID,
    });

    process.env.JUNREI_OTEL_DIR = emptyOtelDir;
    const withEmptyOtelDir = await callToolText("get_session_summary", {
      source: "claude-code",
      sessionId: CLAUDE_SESSION_ID,
    });

    expect(withEmptyOtelDir).toBe(withoutOtel);
  });

  it("MCP list_sessions: identical bytes with JUNREI_OTEL_DIR unset vs. set-but-empty", async () => {
    delete process.env.JUNREI_OTEL_DIR;
    const withoutOtel = await callToolText("list_sessions", {});

    process.env.JUNREI_OTEL_DIR = emptyOtelDir;
    const withEmptyOtelDir = await callToolText("list_sessions", {});

    expect(withEmptyOtelDir).toBe(withoutOtel);
  });

  it("HTTP GET /api/sessions: identical bytes with JUNREI_OTEL_DIR unset vs. set-but-empty", async () => {
    delete process.env.JUNREI_OTEL_DIR;
    const resWithout = await createApp().request("/api/sessions");
    const bodyWithout = await resWithout.text();

    process.env.JUNREI_OTEL_DIR = emptyOtelDir;
    const resWith = await createApp().request("/api/sessions");
    const bodyWith = await resWith.text();

    expect(resWith.status).toBe(resWithout.status);
    expect(bodyWith).toBe(bodyWithout);
  });

  it("HTTP GET /api/health: identical bytes with JUNREI_OTEL_DIR unset vs. set-but-empty", async () => {
    delete process.env.JUNREI_OTEL_DIR;
    const resWithout = await createApp().request("/api/health");
    const bodyWithout = await resWithout.text();

    process.env.JUNREI_OTEL_DIR = emptyOtelDir;
    const resWith = await createApp().request("/api/health");
    const bodyWith = await resWith.text();

    expect(resWith.status).toBe(resWithout.status);
    expect(bodyWith).toBe(bodyWithout);
  });
});

describe("/otlp/* routes 404 exactly like an unregistered route when JUNREI_OTEL_DIR is unset", () => {
  let previousOtelDir: string | undefined;

  beforeEach(() => {
    previousOtelDir = process.env.JUNREI_OTEL_DIR;
    delete process.env.JUNREI_OTEL_DIR;
  });

  afterEach(() => {
    if (previousOtelDir === undefined) delete process.env.JUNREI_OTEL_DIR;
    else process.env.JUNREI_OTEL_DIR = previousOtelDir;
  });

  it("POST /otlp/v1/logs and POST /otlp/v1/metrics both 404 with the same status/body/content-type as a genuinely unregistered route", async () => {
    const app = createApp();
    const unknownRes = await app.request("/definitely/not/a/real/route", { method: "POST" });
    const [unknownStatus, unknownBody, unknownContentType] = [
      unknownRes.status,
      await unknownRes.text(),
      unknownRes.headers.get("content-type"),
    ];

    for (const path of ["/otlp/v1/logs", "/otlp/v1/metrics"]) {
      const res = await app.request(path, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(unknownStatus);
      expect(await res.text()).toBe(unknownBody);
      expect(res.headers.get("content-type")).toBe(unknownContentType);
    }
  });
});
