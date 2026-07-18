#!/usr/bin/env node
// Local capture proxy: forwards every request to https://api.anthropic.com,
// streams the response back to the client unchanged, and tees the full
// exchange (headers + body, with auth redacted) to a JSONL capture file.
//
// Usage: node capture-proxy.mjs --port 8399 --out /path/to/capture.jsonl

import { appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const UPSTREAM_HOST = "api.anthropic.com";
const REDACT_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);

function parseArgs(argv) {
  const args = { port: 8399, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") args.port = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.out) throw new Error("--out <path> is required");
  return args;
}

export function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = REDACT_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: text };
  }
}

// Parse a raw SSE byte stream into a list of {event, data} entries.
// `data` is JSON-parsed when possible, otherwise left as the raw string.
export function parseSse(rawText) {
  const events = [];
  const blocks = rawText.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join("\n");
    const parsed = tryParseJson(rawData);
    events.push({ event: eventName, data: parsed.ok ? parsed.value : rawData });
  }
  return events;
}

// Reassemble the final Anthropic message object from a stream of SSE events
// (message_start / content_block_start / content_block_delta / content_block_stop /
// message_delta / message_stop), mirroring what the SDK does client-side.
export function assembleMessage(events) {
  let message = null;
  const partialJson = new Map();

  for (const { data } of events) {
    if (!data || typeof data !== "object") continue;
    switch (data.type) {
      case "message_start": {
        message = structuredClone(data.message);
        message.content = message.content ?? [];
        break;
      }
      case "content_block_start": {
        if (!message) break;
        message.content[data.index] = structuredClone(data.content_block);
        break;
      }
      case "content_block_delta": {
        if (!message) break;
        const block = message.content[data.index];
        if (!block) break;
        const delta = data.delta;
        if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
        else if (delta.type === "thinking_delta")
          block.thinking = (block.thinking ?? "") + delta.thinking;
        else if (delta.type === "signature_delta") block.signature = delta.signature;
        else if (delta.type === "input_json_delta") {
          const prev = partialJson.get(data.index) ?? "";
          partialJson.set(data.index, prev + (delta.partial_json ?? ""));
        }
        break;
      }
      case "content_block_stop": {
        if (!message) break;
        const block = message.content[data.index];
        if (block && partialJson.has(data.index)) {
          const parsed = tryParseJson(partialJson.get(data.index));
          block.input = parsed.ok ? parsed.value : partialJson.get(data.index);
        }
        break;
      }
      case "message_delta": {
        if (!message) break;
        Object.assign(message, data.delta ?? {});
        if (data.usage) message.usage = { ...(message.usage ?? {}), ...data.usage };
        break;
      }
      default:
        break;
    }
  }
  return message;
}

async function appendCapture(outPath, entry) {
  await appendFile(outPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function buildUpstreamHeaders(clientHeaders) {
  const headers = { ...clientHeaders };
  delete headers["accept-encoding"];
  delete headers["content-length"]; // recomputed by https.request from the body we pass
  headers.host = UPSTREAM_HOST;
  return headers;
}

function main() {
  const { port, out } = parseArgs(process.argv.slice(2));

  const server = http.createServer((clientReq, clientRes) => {
    const start = Date.now();
    const reqChunks = [];
    clientReq.on("data", (chunk) => reqChunks.push(chunk));
    clientReq.on("end", () => {
      const reqBodyRaw = Buffer.concat(reqChunks);
      const upstreamHeaders = buildUpstreamHeaders(clientReq.headers);

      const upstreamReq = https.request(
        {
          hostname: UPSTREAM_HOST,
          port: 443,
          method: clientReq.method,
          path: clientReq.url,
          headers: upstreamHeaders,
        },
        (upstreamRes) => {
          clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          const resChunks = [];
          upstreamRes.on("data", (chunk) => {
            resChunks.push(chunk);
            clientRes.write(chunk); // stream through immediately (no SSE buffering)
          });
          upstreamRes.on("end", () => {
            clientRes.end();
            const durMs = Date.now() - start;
            const resBodyRaw = Buffer.concat(resChunks);
            const contentType = String(upstreamRes.headers["content-type"] ?? "");
            const reqBodyText = reqBodyRaw.toString("utf8");
            const reqParsed = reqBodyText ? tryParseJson(reqBodyText) : { ok: true, value: null };

            const entry = {
              ts: new Date(start).toISOString(),
              durMs,
              method: clientReq.method,
              path: clientReq.url,
              status: upstreamRes.statusCode,
              reqHeaders: redactHeaders(clientReq.headers),
              reqBody: reqParsed.value,
              resHeaders: redactHeaders(upstreamRes.headers),
              resBody: null,
              sse: null,
            };

            if (contentType.includes("text/event-stream")) {
              const rawText = resBodyRaw.toString("utf8");
              const events = parseSse(rawText);
              entry.sse = {
                rawLength: resBodyRaw.length,
                events,
                assembledMessage: assembleMessage(events),
              };
            } else {
              const resText = resBodyRaw.toString("utf8");
              const parsed = resText ? tryParseJson(resText) : { ok: true, value: null };
              entry.resBody = parsed.value;
            }

            appendCapture(out, entry).catch((err) => {
              console.error(`[capture-proxy] failed to write capture: ${err.message}`);
            });
            console.error(
              `[capture-proxy] ${clientReq.method} ${clientReq.url} -> ${upstreamRes.statusCode} (${durMs}ms)`,
            );
          });
        },
      );

      upstreamReq.on("error", (err) => {
        const durMs = Date.now() - start;
        console.error(`[capture-proxy] upstream error for ${clientReq.url}: ${err.message}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
        }
        clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
        appendCapture(out, {
          ts: new Date(start).toISOString(),
          durMs,
          method: clientReq.method,
          path: clientReq.url,
          status: 502,
          reqHeaders: redactHeaders(clientReq.headers),
          reqBody: tryParseJson(reqBodyRaw.toString("utf8")).value,
          resHeaders: {},
          resBody: null,
          sse: null,
          error: err.message,
        }).catch((writeErr) => {
          console.error(`[capture-proxy] failed to write error capture: ${writeErr.message}`);
        });
      });

      upstreamReq.end(reqBodyRaw);
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(
      `[capture-proxy] listening on http://127.0.0.1:${port} -> https://${UPSTREAM_HOST}`,
    );
    console.error(`[capture-proxy] capturing to ${out}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
