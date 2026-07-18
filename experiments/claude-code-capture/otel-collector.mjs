#!/usr/bin/env node
// Minimal local OTLP/HTTP collector. Accepts JSON POSTs of logs/metrics/traces,
// acknowledges them, and tees each payload to a JSONL file per signal.
//
// Usage: node otel-collector.mjs --port 8398 --out-dir /path/to/rundir

import { appendFile, mkdir } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

const SIGNAL_FILES = {
  "/v1/logs": "otel-logs.jsonl",
  "/v1/metrics": "otel-metrics.jsonl",
  "/v1/traces": "otel-traces.jsonl",
};

function parseArgs(argv) {
  const args = { port: 8398, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") args.port = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--out-dir") args.outDir = argv[++i];
  }
  if (!args.outDir) throw new Error("--out-dir <path> is required");
  return args;
}

async function main() {
  const { port, outDir } = parseArgs(process.argv.slice(2));
  await mkdir(outDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const fileName = SIGNAL_FILES[req.url];
    if (req.method !== "POST" || !fileName) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const contentType = String(req.headers["content-type"] ?? "");
      const ts = new Date().toISOString();
      const outPath = join(outDir, fileName);

      let entry;
      if (contentType.includes("json")) {
        const text = body.toString("utf8");
        try {
          entry = { ts, path: req.url, body: JSON.parse(text) };
        } catch {
          entry = { ts, path: req.url, body: text };
        }
      } else {
        entry = { ts, path: req.url, contentType, base64: body.toString("base64") };
      }

      try {
        await appendFile(outPath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch (err) {
        console.error(`[otel-collector] failed to write ${outPath}: ${err.message}`);
      }

      console.error(`[otel-collector] POST ${req.url} (${body.length} bytes)`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(`[otel-collector] listening on http://127.0.0.1:${port}`);
    console.error(`[otel-collector] writing to ${outDir}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
