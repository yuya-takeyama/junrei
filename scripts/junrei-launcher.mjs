import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SERVER_PORT = 7867;
export const DEFAULT_WEB_PORT = 5873;
export const DEV_SERVER_PORT_START = DEFAULT_SERVER_PORT + 1;
export const DEV_WEB_PORT_START = DEFAULT_WEB_PORT + 1;

export const PORT_LOCK_DIR = join(tmpdir(), "junrei-dev-ports");
// Locks left behind by crashed or killed launchers would otherwise linger
// forever: PID recycling can make their recorded owner look alive, so age is
// the backstop for staleness.
export const PORT_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

function parsePort(value, variableName) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variableName} must be an integer from 1 to 65535`);
  }
  return port;
}

export async function isPortAvailable(port) {
  for (const host of ["127.0.0.1", "::1", "::"]) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    // Vite commonly listens on `::1` while the Hono server uses `::`. macOS
    // allows wildcard and loopback binds to coexist in some combinations, so
    // IPv4, IPv6 loopback, and IPv6 wildcard must all be checked explicitly.
    // Check them sequentially: Linux considers the probe's own `::` and
    // `::1` listeners conflicting when they overlap in time.
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(start, probe = isPortAvailable) {
  for (let port = start; port <= 65535; port += 1) {
    if (await probe(port)) return port;
  }
  throw new Error(`No free port found from ${start}`);
}

export async function allocateDevPorts(probe = isPortAvailable) {
  const serverPort = await findAvailablePort(DEV_SERVER_PORT_START, probe);
  const webPort = await findAvailablePort(DEV_WEB_PORT_START, probe);
  return { serverPort, webPort };
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function isLockStale(lockPath) {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > PORT_LOCK_STALE_MS) return true;
    const pid = Number.parseInt(await readFile(lockPath, "utf8"), 10);
    // A fresh lock without a parseable PID is mid-creation, not stale: its
    // owner opened the file but has not written its PID yet.
    return Number.isInteger(pid) && !isProcessRunning(pid);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return true; // released while being inspected; re-run the claim
  }
}

let evictionSequence = 0;

// Evict via rename so two claimants that both saw the same stale lock cannot
// each delete-and-recreate it and end up sharing a port: rename is atomic, so
// exactly one eviction wins and the loser re-runs the claim.
async function evictStaleLock(lockPath) {
  const evictedPath = `${lockPath}.evicted.${process.pid}.${evictionSequence++}`;
  try {
    await rename(lockPath, evictedPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }
  await rm(evictedPath, { force: true });
}

export async function claimPort(port) {
  await mkdir(PORT_LOCK_DIR, { recursive: true });
  const lockPath = join(PORT_LOCK_DIR, `${port}.lock`);
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    return {
      release: async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      },
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  if (!(await isLockStale(lockPath))) return undefined;
  await evictStaleLock(lockPath);
  return claimPort(port);
}

async function reserveAvailablePort(start) {
  for (let port = start; port <= 65535; port += 1) {
    if (!(await isPortAvailable(port))) continue;
    const claim = await claimPort(port);
    if (claim === undefined) continue;
    if (await isPortAvailable(port)) return { port, release: claim.release };
    await claim.release();
  }
  throw new Error(`No free port found from ${start}`);
}

export async function reserveDevPorts() {
  const server = await reserveAvailablePort(DEV_SERVER_PORT_START);
  try {
    const web = await reserveAvailablePort(DEV_WEB_PORT_START);
    return {
      ports: { serverPort: server.port, webPort: web.port },
      release: async () => {
        await Promise.all([server.release(), web.release()]);
      },
    };
  } catch (error) {
    await server.release();
    throw error;
  }
}

export function normalPorts(env) {
  const serverPort = parsePort(
    env.JUNREI_PORT ?? env.JUNREI_SERVER_PORT ?? String(DEFAULT_SERVER_PORT),
    "JUNREI_PORT",
  );
  const webPort = parsePort(env.JUNREI_WEB_PORT ?? String(DEFAULT_WEB_PORT), "JUNREI_WEB_PORT");
  return { serverPort, webPort };
}

export function printEndpoints(kind, { serverPort, webPort }) {
  console.log(`Junrei ${kind} ready`);
  console.log(`  Web: http://localhost:${webPort}`);
  console.log(`  API: http://localhost:${serverPort}`);
  console.log(`  MCP: http://localhost:${serverPort}/mcp`);
}

export function launchWorkspaceDev({ serverPort, webPort }, release = async () => {}) {
  const child = spawn("pnpm", ["-r", "--parallel", "dev"], {
    env: {
      ...process.env,
      JUNREI_PORT: String(serverPort),
      JUNREI_SERVER_PORT: String(serverPort),
      JUNREI_WEB_PORT: String(webPort),
    },
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.once("exit", (code, signal) => {
    release().finally(() => {
      if (signal !== null) process.exit(1);
      process.exit(code ?? 1);
    });
  });
}
