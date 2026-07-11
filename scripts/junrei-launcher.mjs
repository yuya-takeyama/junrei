import { spawn } from "node:child_process";
import net from "node:net";

export const DEFAULT_SERVER_PORT = 7867;
export const DEFAULT_WEB_PORT = 5873;
export const DEV_SERVER_PORT_START = DEFAULT_SERVER_PORT + 1;
export const DEV_WEB_PORT_START = DEFAULT_WEB_PORT + 1;

function parsePort(value, variableName) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variableName} must be an integer from 1 to 65535`);
  }
  return port;
}

export function isPortAvailable(port) {
  return Promise.all(["127.0.0.1", "::1", "::"].map((host) => canBind(port, host))).then(
    (results) => results.every(Boolean),
  );
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    // Vite commonly listens on `::1` while the Hono server uses `::`. macOS
    // allows wildcard and loopback binds to coexist in some combinations, so
    // IPv4, IPv6 loopback, and IPv6 wildcard must all be checked explicitly.
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

export function launchWorkspaceDev({ serverPort, webPort }) {
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
    if (signal !== null) process.exit(1);
    process.exit(code ?? 1);
  });
}
