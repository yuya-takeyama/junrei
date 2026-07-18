import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureEntry } from "./capture.js";
import { type RunningProxy, startCaptureProxy } from "./proxy.js";

const SSE_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_up","model":"claude-fable-5","content":[],"usage":{"input_tokens":11,"output_tokens":0}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
  "",
].join("\n\n");

const UPSTREAM_DELAY_MS = 25;

/** Planted server-side into every SSE response's set-cookie, to prove response-header redaction. */
const UPSTREAM_COOKIE_SENTINEL = "UPSTREAM_COOKIE_SENTINEL_c42e";

/**
 * Fake Anthropic upstream: `/v1/messages` streams SSE (after a small delay so
 * latency is measurable), stamps a `request-id`, and always emits a
 * `set-cookie` carrying a server-side sentinel (so the redaction test can prove
 * RESPONSE credential headers are redacted at write); `/v1/complete` returns a
 * plain JSON body.
 */
function startFakeUpstream(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/messages")) {
      setTimeout(() => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "request-id": "req_upstream_1",
          "set-cookie": `sid=${UPSTREAM_COOKIE_SENTINEL}`,
        });
        res.end(SSE_STREAM);
      }, UPSTREAM_DELAY_MS);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_json_1" });
    res.end(JSON.stringify({ id: "msg_json", model: "claude-haiku", usage: { output_tokens: 1 } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

interface ClientResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
}): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("capture proxy pass-through + capture", () => {
  let upstream: { server: http.Server; url: string };
  let proxy: RunningProxy;
  let capturesDir: string;

  // Sequential requests: arm nextCapture() BEFORE each request, then await it.
  let pendingCapture: ((v: { entry: CaptureEntry; filePath: string }) => void) | null = null;
  function nextCapture(): Promise<{ entry: CaptureEntry; filePath: string }> {
    return new Promise((resolve) => {
      pendingCapture = resolve;
    });
  }

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    capturesDir = await mkdtemp(join(tmpdir(), "junrei-proxy-captures-"));
    proxy = await startCaptureProxy({
      port: 0,
      upstream: upstream.url,
      capturesDir,
      hooks: {
        onCapture: (entry, filePath) => {
          const resolve = pendingCapture;
          pendingCapture = null;
          resolve?.({ entry, filePath });
        },
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.server.close(() => r()));
    await new Promise<void>((r) => upstream.server.close(() => r()));
    await rm(capturesDir, { recursive: true, force: true });
  });

  it("binds 127.0.0.1 only", () => {
    expect(proxy.address).toBe("127.0.0.1");
  });

  it("streams the SSE response through byte-for-byte and captures the raw stream", async () => {
    const captured = nextCapture();
    const response = await httpRequest({
      port: proxy.port,
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-A" },
      body: JSON.stringify({ model: "claude-fable-5", stream: true, system: [{ text: "main" }] }),
    });
    const { entry, filePath } = await captured;

    // Downstream fidelity: client got the exact upstream bytes + content-type.
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toBe(SSE_STREAM);

    // Capture shape: raw SSE text stored, message reassembled for model/usage.
    expect(entry.method).toBe("POST");
    expect(entry.path).toBe("/v1/messages");
    expect(entry.status).toBe(200);
    expect(entry.contentType).toContain("text/event-stream");
    expect(entry.responseBody).toBe(SSE_STREAM);
    expect(entry.assembledMessage?.model).toBe("claude-fable-5");
    expect(entry.assembledMessage?.usage).toEqual({ input_tokens: 11, output_tokens: 3 });

    // Join keys.
    expect(entry.sessionId).toBe("sess-A");
    expect(entry.requestId).toBe("req_upstream_1");
    expect(entry.isSubagent).toBe(false);

    // Latency measured at the proxy (>= the upstream's deliberate delay).
    expect(entry.latencyMs).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS - 5);

    // Written under <sessionId>.jsonl.
    expect(filePath).toBe(join(capturesDir, "sess-A.jsonl"));
    expect(await readFile(filePath, "utf8")).toContain('"sessionId":"sess-A"');
  });

  it("detects a subagent request from cc_is_subagent=true in the system blocks", async () => {
    const captured = nextCapture();
    await httpRequest({
      port: proxy.port,
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-B" },
      body: JSON.stringify({ system: [{ text: "hdr cc_is_subagent=true" }], stream: true }),
    });
    const { entry } = await captured;
    expect(entry.isSubagent).toBe(true);
  });

  it("falls back to _unassigned.jsonl when there is no session id header", async () => {
    const captured = nextCapture();
    await httpRequest({
      port: proxy.port,
      method: "POST",
      path: "/v1/complete",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    const { entry, filePath } = await captured;
    expect(entry.sessionId).toBeNull();
    expect(filePath).toBe(join(capturesDir, "_unassigned.jsonl"));
    // Non-SSE response body is parsed JSON, and request-id still extracted.
    expect((entry.responseBody as { model?: string }).model).toBe("claude-haiku");
    expect(entry.requestId).toBe("req_json_1");
  });

  it("REDACTION GUARANTEE: no planted secret survives to disk", async () => {
    // SENTINEL rides in REQUEST credential headers; UPSTREAM_COOKIE_SENTINEL
    // rides in the RESPONSE set-cookie. Both must be scrubbed at write time.
    const SENTINEL = "SENTINEL_LEAK_a17b9";
    const captured = nextCapture();
    await httpRequest({
      port: proxy.port,
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "sess-secret",
        authorization: `Bearer ${SENTINEL}`,
        "x-api-key": `sk-ant-${SENTINEL}`,
        cookie: `session=${SENTINEL}`,
        "x-refresh-token": SENTINEL,
        "x-tenant-secret": SENTINEL,
      },
      body: JSON.stringify({ stream: true, system: [{ text: "no secret here" }] }),
    });
    const { entry, filePath } = await captured;

    // The written FILE must not contain either sentinel anywhere.
    const fileBytes = await readFile(filePath, "utf8");
    expect(fileBytes).not.toContain(SENTINEL);
    expect(fileBytes).not.toContain(UPSTREAM_COOKIE_SENTINEL);

    // Redacted values are present as the sentinel marker, not the real value.
    expect(entry.requestHeaders.authorization).toBe("[redacted]");
    expect(entry.requestHeaders["x-api-key"]).toBe("[redacted]");
    expect(entry.requestHeaders.cookie).toBe("[redacted]");
    expect(entry.requestHeaders["x-refresh-token"]).toBe("[redacted]");
    expect(entry.requestHeaders["x-tenant-secret"]).toBe("[redacted]");
    expect(entry.responseHeaders["set-cookie"]).toBe("[redacted]");
    // Non-credential join header is preserved.
    expect(entry.requestHeaders["x-claude-code-session-id"]).toBe("sess-secret");
  });
});
