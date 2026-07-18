/**
 * The localhost-only pass-through proxy (Goshuin Phase D). Behavior ported from
 * the validated experiment (`experiments/claude-code-capture/capture-proxy.mjs`):
 * the request body is buffered, forwarded to the upstream unchanged, and the
 * response is STREAMED THROUGH to the client byte-for-byte (each chunk written
 * as it arrives — SSE is never buffered client-side) while a copy is teed into
 * a buffer for capture. Redaction happens only when building the stored entry,
 * so the forwarded traffic stays faithful.
 *
 * HARD CONSTRAINT: the server binds `127.0.0.1` ONLY (see `startCaptureProxy`).
 * The upstream is flag-configurable (default `https://api.anthropic.com`); an
 * `http://` upstream is supported so tests can point at a local fake.
 */

import http from "node:http";
import https from "node:https";
import {
  appendCapture,
  type CaptureEntry,
  detectIsSubagent,
  extractRequestId,
  extractSessionId,
} from "./capture.js";
import { redactHeaders } from "./redact.js";
import { assembleMessage, parseSse, tryParseJson } from "./sse.js";

/** The single hard-coded bind interface — NEVER configurable. */
export const BIND_HOST = "127.0.0.1";

export interface ProxyHooks {
  /** Fired after a capture entry is durably appended — tests await on this. */
  onCapture?: (entry: CaptureEntry, filePath: string) => void;
  /** Fired when writing a capture entry fails (disk error) — never blocks the response. */
  onCaptureError?: (error: Error) => void;
}

export interface ProxyOptions {
  /** Upstream base URL, e.g. `https://api.anthropic.com`. */
  upstream: string;
  /** Directory capture JSONL is written under. */
  capturesDir: string;
  hooks?: ProxyHooks;
}

interface UpstreamTarget {
  transport: typeof http | typeof https;
  hostname: string;
  port: number;
  hostHeader: string;
}

function resolveUpstream(upstream: string): UpstreamTarget {
  const url = new URL(upstream);
  const isHttps = url.protocol === "https:";
  return {
    transport: isHttps ? https : http,
    hostname: url.hostname,
    port: url.port !== "" ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80,
    hostHeader: url.host,
  };
}

/** Headers forwarded upstream: caller's headers minus hop-by-hop bits we recompute, with Host rewritten. */
function buildUpstreamHeaders(
  clientHeaders: http.IncomingHttpHeaders,
  hostHeader: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...clientHeaders };
  delete headers["accept-encoding"]; // avoid a compressed body we'd have to decode to capture
  delete headers["content-length"]; // recomputed from the body we pass
  headers.host = hostHeader;
  return headers;
}

function isEventStream(contentType: string): boolean {
  return contentType.includes("text/event-stream");
}

/**
 * Build the capture entry for a completed exchange. Header maps are redacted
 * HERE (the only place they touch a to-be-stored object). For an SSE response
 * the raw event-stream text is stored as `responseBody` and the reassembled
 * message as `assembledMessage`; otherwise the parsed JSON body (or raw string).
 */
function buildEntry(params: {
  start: number;
  end: number;
  method: string;
  path: string;
  status: number;
  clientHeaders: http.IncomingHttpHeaders;
  requestBodyRaw: Buffer;
  responseHeaders: http.IncomingHttpHeaders;
  responseBodyRaw: Buffer;
  error?: string;
}): CaptureEntry {
  const reqBodyText = params.requestBodyRaw.toString("utf8");
  const reqParsed = reqBodyText ? tryParseJson(reqBodyText) : { ok: true as const, value: null };
  const requestBody = reqParsed.ok ? reqParsed.value : reqBodyText;
  const contentType = String(params.responseHeaders["content-type"] ?? "");

  let responseBody: unknown = null;
  let assembledMessage: Record<string, unknown> | null = null;
  if (params.responseBodyRaw.length > 0) {
    const resText = params.responseBodyRaw.toString("utf8");
    if (isEventStream(contentType)) {
      responseBody = resText; // full raw event-stream text (calibration ground truth)
      assembledMessage = assembleMessage(parseSse(resText));
    } else {
      const parsed = tryParseJson(resText);
      responseBody = parsed.ok ? parsed.value : resText;
    }
  }

  return {
    startedAt: new Date(params.start).toISOString(),
    endedAt: new Date(params.end).toISOString(),
    latencyMs: params.end - params.start,
    method: params.method,
    path: params.path,
    status: params.status,
    sessionId: extractSessionId(params.clientHeaders),
    requestId: extractRequestId(params.responseHeaders),
    isSubagent: detectIsSubagent(requestBody, params.clientHeaders),
    requestHeaders: redactHeaders(params.clientHeaders),
    requestBody,
    requestBytes: params.requestBodyRaw.length,
    responseHeaders: redactHeaders(params.responseHeaders),
    contentType,
    responseBody,
    assembledMessage,
    responseBytes: params.responseBodyRaw.length,
    ...(params.error !== undefined && { error: params.error }),
  };
}

function writeCapture(options: ProxyOptions, entry: CaptureEntry): void {
  appendCapture(options.capturesDir, entry)
    .then((filePath) => options.hooks?.onCapture?.(entry, filePath))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      options.hooks?.onCaptureError?.(error);
      process.stderr.write(`[capture-proxy] failed to write capture: ${error.message}\n`);
    });
}

/** Create the proxy's `http.Server` (not yet listening). Use `startCaptureProxy` to bind it. */
export function createProxyServer(options: ProxyOptions): http.Server {
  const target = resolveUpstream(options.upstream);

  return http.createServer((clientReq, clientRes) => {
    const start = Date.now();
    const reqChunks: Buffer[] = [];
    clientReq.on("data", (chunk: Buffer) => reqChunks.push(chunk));
    clientReq.on("end", () => {
      const requestBodyRaw = Buffer.concat(reqChunks);
      const upstreamReq = target.transport.request(
        {
          hostname: target.hostname,
          port: target.port,
          method: clientReq.method,
          path: clientReq.url,
          headers: buildUpstreamHeaders(clientReq.headers, target.hostHeader),
        },
        (upstreamRes) => {
          // Byte-faithful downstream: forward the REAL upstream status + headers.
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          const resChunks: Buffer[] = [];
          upstreamRes.on("data", (chunk: Buffer) => {
            resChunks.push(chunk);
            clientRes.write(chunk); // stream through immediately — no SSE buffering
          });
          upstreamRes.on("end", () => {
            clientRes.end();
            writeCapture(
              options,
              buildEntry({
                start,
                end: Date.now(),
                method: clientReq.method ?? "GET",
                path: clientReq.url ?? "",
                status: upstreamRes.statusCode ?? 0,
                clientHeaders: clientReq.headers,
                requestBodyRaw,
                responseHeaders: upstreamRes.headers,
                responseBodyRaw: Buffer.concat(resChunks),
              }),
            );
          });
        },
      );

      upstreamReq.on("error", (err: Error) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
        }
        clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
        writeCapture(
          options,
          buildEntry({
            start,
            end: Date.now(),
            method: clientReq.method ?? "GET",
            path: clientReq.url ?? "",
            status: 502,
            clientHeaders: clientReq.headers,
            requestBodyRaw,
            responseHeaders: {},
            responseBodyRaw: Buffer.alloc(0),
            error: err.message,
          }),
        );
      });

      upstreamReq.end(requestBodyRaw);
    });
  });
}

export interface RunningProxy {
  server: http.Server;
  port: number;
  address: string;
}

/**
 * Bind the proxy to `127.0.0.1:<port>` (port `0` → an ephemeral port, for
 * tests). Resolves once listening, with the actual bound port/address.
 */
export function startCaptureProxy(options: ProxyOptions & { port: number }): Promise<RunningProxy> {
  const server = createProxyServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, BIND_HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : options.port;
      const address = typeof addr === "object" && addr !== null ? addr.address : BIND_HOST;
      server.removeListener("error", reject);
      resolve({ server, port, address });
    });
  });
}
