#!/usr/bin/env node
/**
 * `junrei-capture-proxy` entry point. Parses args, prints the mandatory
 * startup banner, and binds the pass-through proxy to 127.0.0.1. Started
 * explicitly by the user (`pnpm capture`) — never launched implicitly.
 */

import { parseArgs, resolveCapturesDir } from "./args.js";
import { printBanner } from "./banner.js";
import { startCaptureProxy } from "./proxy.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const capturesDir = resolveCapturesDir(process.env, args.dir);

  const { server } = await startCaptureProxy({
    port: args.port,
    upstream: args.upstream,
    capturesDir,
  });

  printBanner({ port: args.port, capturesDir, upstream: args.upstream });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[capture-proxy] fatal: ${message}\n`);
  process.exit(1);
});
