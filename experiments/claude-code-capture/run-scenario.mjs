#!/usr/bin/env node
// Orchestrates one end-to-end capture experiment:
//   1. spins up capture-proxy.mjs + otel-collector.mjs
//   2. runs a scripted headless `claude -p` scenario through them
//   3. copies the resulting ~/.claude/projects session log into the run dir
//   4. writes a manifest.json describing the run
//
// Usage: node run-scenario.mjs [--runs-base <dir>] [--proxy-port 8399]
//        [--otel-port 8398] [--model claude-haiku-4-5] [--timeout-ms 600000]

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RUNS_BASE =
  "/private/tmp/claude-501/-Users-yuya-src-github-com-yuya-takeyama-junrei--claude-worktrees-junrei-prototype-df79a2/26143f1a-0c09-47fc-8349-203422413fa9/scratchpad/runs";

const SCENARIO =
  "Do these steps in order: 1) Read notes.txt and summarize it in one sentence. " +
  "2) Run the Bash command `wc -l data.json` and report the line count. " +
  "3) Use the Task tool (subagent_type general-purpose) to have a subagent count how many " +
  ".txt files exist in the current directory; report its answer. Then reply DONE.";

const NOTES_TXT = `Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
`;

const DATA_JSON = JSON.stringify(
  [
    { id: 1, name: "alpha" },
    { id: 2, name: "beta" },
    { id: 3, name: "gamma" },
  ],
  null,
  2,
);

function parseArgs(argv) {
  const args = {
    runsBase: DEFAULT_RUNS_BASE,
    proxyPort: 8399,
    otelPort: 8398,
    model: "claude-haiku-4-5",
    timeoutMs: 600_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--runs-base") args.runsBase = argv[++i];
    else if (argv[i] === "--proxy-port") args.proxyPort = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--otel-port") args.otelPort = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--timeout-ms") args.timeoutMs = Number.parseInt(argv[++i], 10);
  }
  return args;
}

function waitForPort(port, host = "127.0.0.1", timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function spawnLogged(command, args, options, logPath) {
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  return child;
}

async function stopProcess(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runClaudeScenario({ cwd, model, proxyPort, otelPort, timeoutMs, runDir }) {
  const stdoutPath = join(runDir, "claude-stdout.json");
  const stderrPath = join(runDir, "claude-stderr.log");
  const stdoutStream = createWriteStream(stdoutPath);
  const stderrStream = createWriteStream(stderrPath);

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otelPort}`,
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_METRIC_EXPORT_INTERVAL: "1000",
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };

  const startedAt = Date.now();
  const child = spawn(
    "claude",
    ["-p", SCENARIO, "--model", model, "--dangerously-skip-permissions", "--output-format", "json"],
    { cwd, env },
  );

  const stdoutChunks = [];
  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    stdoutStream.write(chunk);
  });
  child.stderr.on("data", (chunk) => stderrStream.write(chunk));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", (err) => {
      stderrStream.write(`\n[run-scenario] spawn error: ${err.message}\n`);
      resolve(-1);
    });
  });
  clearTimeout(timer);
  stdoutStream.end();
  stderrStream.end();
  const endedAt = Date.now();

  const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
  let sessionId = null;
  let parsedStdout = null;
  try {
    parsedStdout = JSON.parse(stdoutText);
    sessionId = parsedStdout.session_id ?? null;
  } catch {
    // stdout wasn't parseable JSON; raw copy is already saved to stdoutPath.
  }

  return { exitCode, timedOut, sessionId, startedAt, endedAt, stdoutPath, stderrPath };
}

function mungePath(absPath) {
  return absPath.replace(/[/.]/g, "-");
}

async function findSessionLogDir({ projectDir, sessionId }) {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const munged = mungePath(projectDir);
  const candidate = join(projectsRoot, munged);

  if (sessionId && existsSync(join(candidate, `${sessionId}.jsonl`))) {
    return { dir: candidate, method: "munged-path-match" };
  }

  if (existsSync(candidate)) {
    // Path exists but the exact session file wasn't found there (e.g. sessionId
    // unknown) -- still the best candidate since it matches the cwd mapping.
    return { dir: candidate, method: "munged-path-only" };
  }

  if (sessionId) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(projectsRoot, entry.name);
      if (existsSync(join(dirPath, `${sessionId}.jsonl`))) {
        return { dir: dirPath, method: "scanned-by-session-id" };
      }
    }
  }

  return { dir: null, method: "not-found" };
}

async function buildFileInventory(rootDir) {
  const { readdir } = await import("node:fs/promises");
  const inventory = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const st = await stat(fullPath);
        const relPath = relative(rootDir, fullPath);
        const item = { path: relPath, size: st.size };
        if (fullPath.endsWith(".jsonl")) {
          const text = await readFile(fullPath, "utf8");
          item.lines = text.split("\n").filter((line) => line.trim().length > 0).length;
        }
        inventory.push(item);
      }
    }
  }

  if (existsSync(rootDir)) await walk(rootDir);
  return inventory;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:]/g, "-");
  const runDir = join(args.runsBase, runId);
  const projectDir = join(runDir, "project");

  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "notes.txt"), NOTES_TXT, "utf8");
  await writeFile(join(projectDir, "data.json"), DATA_JSON, "utf8");

  console.log(`[run-scenario] run dir: ${runDir}`);

  const captureProxyPath = join(__dirname, "capture-proxy.mjs");
  const otelCollectorPath = join(__dirname, "otel-collector.mjs");
  const capturePath = join(runDir, "capture.jsonl");

  const proxyChild = spawnLogged(
    process.execPath,
    [captureProxyPath, "--port", String(args.proxyPort), "--out", capturePath],
    {},
    join(runDir, "proxy.log"),
  );
  const otelChild = spawnLogged(
    process.execPath,
    [otelCollectorPath, "--port", String(args.otelPort), "--out-dir", runDir],
    {},
    join(runDir, "otel.log"),
  );

  const proxyReadyAt = await waitForPort(args.proxyPort).then(() => Date.now());
  const otelReadyAt = await waitForPort(args.otelPort).then(() => Date.now());
  console.log("[run-scenario] proxy and otel collector are up");

  const claudeResult = await runClaudeScenario({
    cwd: projectDir,
    model: args.model,
    proxyPort: args.proxyPort,
    otelPort: args.otelPort,
    timeoutMs: args.timeoutMs,
    runDir,
  });
  console.log(
    `[run-scenario] claude exited with code=${claudeResult.exitCode} timedOut=${claudeResult.timedOut} sessionId=${claudeResult.sessionId}`,
  );

  console.log("[run-scenario] sleeping 5s to let OTel flush...");
  await sleep(5000);

  await stopProcess(proxyChild);
  await stopProcess(otelChild);
  console.log("[run-scenario] proxy and otel collector stopped");

  const { dir: sessionSourceDir, method: sessionFindMethod } = await findSessionLogDir({
    projectDir,
    sessionId: claudeResult.sessionId,
  });

  const sessionLogDest = join(runDir, "session-log");
  if (sessionSourceDir) {
    await mkdir(sessionLogDest, { recursive: true });
    await cp(sessionSourceDir, sessionLogDest, { recursive: true });
    console.log(
      `[run-scenario] copied session log from ${sessionSourceDir} (${sessionFindMethod})`,
    );
  } else {
    console.log("[run-scenario] WARNING: could not locate session log directory");
  }

  const files = await buildFileInventory(runDir);

  const manifest = {
    runId,
    runDir,
    ports: { proxyPort: args.proxyPort, otelPort: args.otelPort },
    model: args.model,
    scenario: SCENARIO,
    projectDir,
    sessionId: claudeResult.sessionId,
    sessionLog: {
      sourceDir: sessionSourceDir,
      findMethod: sessionFindMethod,
      copiedTo: sessionSourceDir ? sessionLogDest : null,
    },
    exitCode: claudeResult.exitCode,
    timedOut: claudeResult.timedOut,
    timings: {
      proxyReadyAt: new Date(proxyReadyAt).toISOString(),
      otelReadyAt: new Date(otelReadyAt).toISOString(),
      claudeStartedAt: new Date(claudeResult.startedAt).toISOString(),
      claudeEndedAt: new Date(claudeResult.endedAt).toISOString(),
      claudeDurationMs: claudeResult.endedAt - claudeResult.startedAt,
    },
    files,
  };

  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[run-scenario] wrote manifest.json`);
  console.log(`[run-scenario] DONE. run dir: ${runDir}`);
}

main().catch((err) => {
  console.error(`[run-scenario] fatal error: ${err.stack ?? err.message}`);
  process.exit(1);
});
