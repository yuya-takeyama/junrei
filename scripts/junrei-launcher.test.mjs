import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  allocateDevPorts,
  DEV_SERVER_PORT_START,
  DEV_WEB_PORT_START,
  findAvailablePort,
  isPortAvailable,
  normalPorts,
} from "./junrei-launcher.mjs";

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

test("normalPorts honors explicit ports and maps the API port to the web proxy", () => {
  assert.deepEqual(normalPorts({ JUNREI_PORT: "8123", JUNREI_WEB_PORT: "6123" }), {
    serverPort: 8123,
    webPort: 6123,
  });
});
