import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import {
  allocateDevPorts,
  claimPort,
  DEV_SERVER_PORT_START,
  DEV_WEB_PORT_START,
  findAvailablePort,
  isPortAvailable,
  normalPorts,
  PORT_LOCK_DIR,
  PORT_LOCK_STALE_MS,
  reserveDevPorts,
} from "./junrei-launcher.mjs";

// Fake ports far above the launcher's search range: claimPort only touches
// lock files, so no sockets are involved and real launchers never get here.
async function plantLock(port, contents, { ageMs = 0 } = {}) {
  await mkdir(PORT_LOCK_DIR, { recursive: true });
  const lockPath = join(PORT_LOCK_DIR, `${port}.lock`);
  await writeFile(lockPath, contents);
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    await utimes(lockPath, past, past);
  }
  return lockPath;
}

test("findAvailablePort increments until its probe reports a free port", async () => {
  const checked = [];
  const port = await findAvailablePort(9000, async (candidate) => {
    checked.push(candidate);
    return candidate === 9002;
  });
  assert.equal(port, 9002);
  assert.deepEqual(checked, [9000, 9001, 9002]);
});

test("allocateDevPorts starts each service at its own non-default range", async () => {
  const unavailable = new Set([DEV_SERVER_PORT_START, DEV_WEB_PORT_START]);
  const ports = await allocateDevPorts(async (candidate) => !unavailable.has(candidate));
  assert.deepEqual(ports, {
    serverPort: DEV_SERVER_PORT_START + 1,
    webPort: DEV_WEB_PORT_START + 1,
  });
});

test("isPortAvailable detects an IPv6 localhost listener used by Vite", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "::1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  if (address === null || typeof address === "string") return;
  try {
    assert.equal(await isPortAvailable(address.port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await isPortAvailable(address.port), true);
});

test("isPortAvailable detects an IPv6 wildcard listener used by the API server", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "::", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  if (address === null || typeof address === "string") return;
  try {
    assert.equal(await isPortAvailable(address.port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await isPortAvailable(address.port), true);
});

test("reserveDevPorts gives simultaneous launchers distinct port pairs", async () => {
  const [first, second] = await Promise.all([reserveDevPorts(), reserveDevPorts()]);
  try {
    assert.notEqual(first.ports.serverPort, second.ports.serverPort);
    assert.notEqual(first.ports.webPort, second.ports.webPort);
  } finally {
    await Promise.all([first.release(), second.release()]);
  }
});

test("claimPort evicts a lock older than the TTL even if its PID looks alive", async () => {
  const port = 64901;
  const lockPath = await plantLock(port, String(process.pid), {
    ageMs: PORT_LOCK_STALE_MS + 60_000,
  });
  try {
    const claim = await claimPort(port);
    assert.notEqual(claim, undefined);
    await claim.release();
  } finally {
    await rm(lockPath, { force: true });
  }
});

test("claimPort evicts a lock whose recorded PID is no longer running", async () => {
  const port = 64902;
  const lockPath = await plantLock(port, String(2 ** 30));
  try {
    const claim = await claimPort(port);
    assert.notEqual(claim, undefined);
    await claim.release();
  } finally {
    await rm(lockPath, { force: true });
  }
});

test("claimPort respects a fresh lock held by a live process", async () => {
  const port = 64903;
  const lockPath = await plantLock(port, String(process.pid));
  try {
    assert.equal(await claimPort(port), undefined);
  } finally {
    await rm(lockPath, { force: true });
  }
});

test("normalPorts honors explicit ports and maps the API port to the web proxy", () => {
  assert.deepEqual(normalPorts({ JUNREI_PORT: "8123", JUNREI_WEB_PORT: "6123" }), {
    serverPort: 8123,
    webPort: 6123,
  });
});
