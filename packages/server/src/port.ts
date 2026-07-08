import net from "node:net";

export const DEFAULT_PORT = 7867;

/**
 * Resolve the port to listen on:
 * 1. `JUNREI_PORT` env var (must be a valid port number) wins.
 * 2. Otherwise try the default port.
 * 3. If the default is taken, fall back to an OS-assigned ephemeral port (0).
 *
 * Never fails on port collision by design — Junrei should coexist with
 * whatever else is running on the machine.
 */
export async function resolvePort(env: Record<string, string | undefined>): Promise<number> {
  const fromEnv = env.JUNREI_PORT;
  if (fromEnv !== undefined) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`Invalid JUNREI_PORT: ${fromEnv}`);
    }
    return parsed;
  }
  if (await isPortFree(DEFAULT_PORT)) {
    return DEFAULT_PORT;
  }
  return 0;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
