#!/usr/bin/env node
// Summarizes a captured run: reads capture.jsonl (API traffic), otel-*.jsonl
// (telemetry), and session-log/**/*.jsonl (native Claude Code session log),
// and prints/writes a digest comparing what each source captured.
//
// Usage: node summarize-run.mjs <runDir>

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function sha256_8(text) {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex")
    .slice(0, 8);
}

async function readJsonlFile(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ __parseError: true, raw: line });
    }
  }
  return records;
}

async function walkFiles(dir, predicate) {
  const out = [];
  if (!existsSync(dir)) return out;
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

function systemBlocksOf(reqBody) {
  const system = reqBody?.system;
  if (!system) return [];
  if (typeof system === "string") return [{ text: system }];
  if (Array.isArray(system)) return system.map((block) => ({ text: block?.text ?? "" }));
  return [];
}

function extractResponse(entry) {
  if (entry.sse?.assembledMessage) {
    const msg = entry.sse.assembledMessage;
    return { stopReason: msg.stop_reason ?? null, usage: msg.usage ?? null };
  }
  if (entry.resBody && typeof entry.resBody === "object") {
    return { stopReason: entry.resBody.stop_reason ?? null, usage: entry.resBody.usage ?? null };
  }
  return { stopReason: null, usage: null };
}

function pathnameOf(rawPath) {
  return String(rawPath ?? "").split("?")[0];
}

async function summarizeCapture(runDir) {
  const entries = await readJsonlFile(join(runDir, "capture.jsonl"));
  const byPath = {};
  let totalSseEvents = 0;
  for (const entry of entries) {
    const p = pathnameOf(entry.path);
    byPath[p] = (byPath[p] ?? 0) + 1;
    if (entry.sse?.events) totalSseEvents += entry.sse.events.length;
  }

  const messagesRequests = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => pathnameOf(entry.path) === "/v1/messages");

  const digests = messagesRequests.map(({ entry, index }) => {
    const reqBody = entry.reqBody ?? {};
    const reqText = JSON.stringify(reqBody);
    const systemBlocks = systemBlocksOf(reqBody);
    const tools = Array.isArray(reqBody.tools) ? reqBody.tools : [];
    const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
    const response = extractResponse(entry);

    return {
      index,
      path: entry.path,
      status: entry.status,
      model: reqBody.model ?? null,
      stream: Boolean(reqBody.stream),
      maxTokens: reqBody.max_tokens ?? null,
      temperature: reqBody.temperature ?? null,
      thinking: reqBody.thinking ?? null,
      system: {
        blockCount: systemBlocks.length,
        totalChars: systemBlocks.reduce((sum, b) => sum + (b.text?.length ?? 0), 0),
        hashes: systemBlocks.map((b) => sha256_8(b.text ?? "")),
        firstBlockPreview: systemBlocks[0]?.text?.slice(0, 40) ?? null,
      },
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
      messageCount: messages.length,
      roles: messages.map((m) => m.role),
      response,
      containsSystemReminder: reqText.includes("<system-reminder>"),
      containsClaudeMd: reqText.includes("CLAUDE.md"),
      containsNotesTxt: reqText.includes("notes.txt"),
    };
  });

  // Subagent heuristic: the first /v1/messages request establishes the "main"
  // conversation's system-prompt fingerprint (hash of its first system block).
  // Any later request whose first-block hash differs is flagged as likely
  // subagent traffic (Claude Code gives subagents a distinct, shorter system prompt).
  const mainHash = digests[0]?.system.hashes[0] ?? null;
  for (const d of digests) {
    d.likelySubagent = mainHash !== null && d.system.hashes[0] !== mainHash;
  }

  return { totalRequests: entries.length, byPath, totalSseEvents, messagesRequests: digests };
}

async function summarizeSessionLog(runDir, needleFromCapture) {
  const sessionLogDir = join(runDir, "session-log");
  const files = await walkFiles(sessionLogDir, (f) => f.endsWith(".jsonl"));

  const perTypeCounts = {};
  const keysByType = {};
  let hasSystemReminder = false;
  let hasClaudeMd = false;
  let hasToolInputSchema = false;
  let hasMaxTokens = false;
  let hasSystemPromptText = false;
  const sidechainFiles = new Set();
  let totalRecords = 0;

  for (const file of files) {
    const records = await readJsonlFile(file);
    for (const record of records) {
      totalRecords += 1;
      const type = record.type ?? "__untyped";
      perTypeCounts[type] = (perTypeCounts[type] ?? 0) + 1;
      keysByType[type] = keysByType[type] ?? new Set();
      for (const key of Object.keys(record)) keysByType[type].add(key);

      if (record.isSidechain === true) sidechainFiles.add(file);

      const text = JSON.stringify(record);
      if (text.includes("<system-reminder>")) hasSystemReminder = true;
      if (text.includes("CLAUDE.md")) hasClaudeMd = true;
      if (text.includes("input_schema")) hasToolInputSchema = true;
      if (text.includes("max_tokens")) hasMaxTokens = true;
      if (needleFromCapture && text.includes(needleFromCapture)) hasSystemPromptText = true;
    }
  }

  const keysByTypeObj = Object.fromEntries(
    Object.entries(keysByType).map(([type, set]) => [type, [...set].sort()]),
  );

  return {
    files: files.map((f) => f.replace(`${runDir}/`, "")),
    totalRecords,
    perTypeCounts,
    keysByType: keysByTypeObj,
    hasSystemReminder,
    hasClaudeMd,
    hasToolInputSchema,
    hasMaxTokens,
    hasSystemPromptText,
    sidechainFiles: [...sidechainFiles].map((f) => f.replace(`${runDir}/`, "")),
  };
}

function collectLogRecords(payload) {
  const out = [];
  for (const rl of payload?.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) out.push(lr);
    }
  }
  return out;
}

function collectMetrics(payload) {
  const out = [];
  for (const rm of payload?.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) out.push(m);
    }
  }
  return out;
}

function attrValue(attr) {
  const v = attr?.value ?? {};
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? JSON.stringify(v);
}

async function summarizeOtel(runDir) {
  const logsPath = join(runDir, "otel-logs.jsonl");
  const metricsPath = join(runDir, "otel-metrics.jsonl");
  const tracesPath = join(runDir, "otel-traces.jsonl");

  const logsEntries = await readJsonlFile(logsPath);
  const metricsEntries = await readJsonlFile(metricsPath);
  const tracesEntries = await readJsonlFile(tracesPath);

  const eventNameCounts = {};
  let exampleApiRequest = null;
  for (const entry of logsEntries) {
    for (const lr of collectLogRecords(entry.body)) {
      const nameAttr = (lr.attributes ?? []).find((a) => a.key === "event.name");
      const eventName = nameAttr ? attrValue(nameAttr) : (lr.body?.stringValue ?? "__unknown");
      eventNameCounts[eventName] = (eventNameCounts[eventName] ?? 0) + 1;
      if (!exampleApiRequest && String(eventName).includes("api_request")) {
        exampleApiRequest = {
          eventName,
          attributeKeys: (lr.attributes ?? []).map((a) => a.key),
        };
      }
    }
  }

  const metricNameCounts = {};
  for (const entry of metricsEntries) {
    for (const m of collectMetrics(entry.body)) {
      metricNameCounts[m.name] = (metricNameCounts[m.name] ?? 0) + 1;
    }
  }

  const needles = ["notes.txt", "wc -l data.json", "Lorem ipsum"];
  const logsRaw = existsSync(logsPath) ? await readFile(logsPath, "utf8") : "";
  const metricsRaw = existsSync(metricsPath) ? await readFile(metricsPath, "utf8") : "";
  const containsPromptOrFileContent = {
    logs: needles.filter((n) => logsRaw.includes(n)),
    metrics: needles.filter((n) => metricsRaw.includes(n)),
  };

  return {
    logsPayloadCount: logsEntries.length,
    metricsPayloadCount: metricsEntries.length,
    tracesPayloadCount: tracesEntries.length,
    eventNameCounts,
    metricNameCounts,
    exampleApiRequestEvent: exampleApiRequest,
    containsPromptOrFileContent,
  };
}

function renderDigest({ runDir, capture, sessionLog, otel }) {
  const lines = [];
  lines.push(`# Capture digest: ${runDir}`, "");

  lines.push("## API capture (capture.jsonl)", "");
  lines.push(`- Total requests captured: ${capture.totalRequests}`);
  lines.push(`- By path: ${JSON.stringify(capture.byPath)}`);
  lines.push(`- Total SSE events across all streamed responses: ${capture.totalSseEvents}`);
  lines.push("");
  for (const d of capture.messagesRequests) {
    lines.push(`### Request #${d.index} — ${d.path} (status ${d.status})`);
    lines.push(`- model: ${d.model}, stream: ${d.stream}, likelySubagent: ${d.likelySubagent}`);
    lines.push(
      `- max_tokens: ${d.maxTokens}, temperature: ${d.temperature}, thinking: ${JSON.stringify(d.thinking)}`,
    );
    lines.push(
      `- system: ${d.system.blockCount} block(s), ${d.system.totalChars} chars, hashes=${JSON.stringify(d.system.hashes)}`,
    );
    lines.push(`  - first block preview: ${JSON.stringify(d.system.firstBlockPreview)}`);
    lines.push(`- tools: ${d.toolCount} — ${JSON.stringify(d.toolNames)}`);
    lines.push(`- messages: ${d.messageCount} — roles=${JSON.stringify(d.roles)}`);
    lines.push(
      `- response: stop_reason=${d.response.stopReason}, usage=${JSON.stringify(d.response.usage)}`,
    );
    lines.push(
      `- contains <system-reminder>: ${d.containsSystemReminder}, contains "CLAUDE.md": ${d.containsClaudeMd}, contains "notes.txt": ${d.containsNotesTxt}`,
    );
    lines.push("");
  }

  lines.push("## Session JSONL (session-log/**/*.jsonl)", "");
  lines.push(`- Files: ${JSON.stringify(sessionLog.files)}`);
  lines.push(`- Total records: ${sessionLog.totalRecords}`);
  lines.push(`- Count per type: ${JSON.stringify(sessionLog.perTypeCounts)}`);
  lines.push(`- Distinct top-level keys per type: ${JSON.stringify(sessionLog.keysByType)}`);
  lines.push(`- Contains <system-reminder>: ${sessionLog.hasSystemReminder}`);
  lines.push(`- Contains "CLAUDE.md": ${sessionLog.hasClaudeMd}`);
  lines.push(`- Contains tool input_schema: ${sessionLog.hasToolInputSchema}`);
  lines.push(`- Contains "max_tokens": ${sessionLog.hasMaxTokens}`);
  lines.push(
    `- Contains system-prompt text (first-40-chars needle from capture): ${sessionLog.hasSystemPromptText}`,
  );
  lines.push(`- Sidechain (isSidechain=true) files: ${JSON.stringify(sessionLog.sidechainFiles)}`);
  lines.push("");

  lines.push("## OTel export (otel-*.jsonl)", "");
  lines.push(`- Log payloads received: ${otel.logsPayloadCount}`);
  lines.push(`- Metric payloads received: ${otel.metricsPayloadCount}`);
  lines.push(`- Trace payloads received: ${otel.tracesPayloadCount}`);
  lines.push(`- Distinct event names (from logRecords): ${JSON.stringify(otel.eventNameCounts)}`);
  lines.push(`- Distinct metric names: ${JSON.stringify(otel.metricNameCounts)}`);
  lines.push(
    `- Example api_request event attribute keys: ${JSON.stringify(otel.exampleApiRequestEvent)}`,
  );
  lines.push(
    `- OTel payloads containing prompt/file-content needles: ${JSON.stringify(otel.containsPromptOrFileContent)}`,
  );
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: node summarize-run.mjs <runDir>");
    process.exit(1);
  }

  const capture = await summarizeCapture(runDir);
  const needle = capture.messagesRequests[0]?.system.firstBlockPreview ?? null;
  const sessionLog = await summarizeSessionLog(runDir, needle);
  const otel = await summarizeOtel(runDir);

  const digest = renderDigest({ runDir, capture, sessionLog, otel });
  console.log(digest);
  await writeFile(join(runDir, "digest.md"), digest, "utf8");
}

main().catch((err) => {
  console.error(`[summarize-run] fatal error: ${err.stack ?? err.message}`);
  process.exit(1);
});
