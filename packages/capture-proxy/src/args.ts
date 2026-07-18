/**
 * CLI argument + environment resolution for the capture proxy. The HOST is
 * deliberately NOT configurable — the proxy binds `127.0.0.1` only (hard-coded
 * in `proxy.ts`); a flag may move the PORT but never the interface.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Default localhost port (127.0.0.1:7967). */
export const DEFAULT_PORT = 7967;
/** Default upstream — real Anthropic API; `--upstream` overrides (e.g. for tests). */
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export interface ProxyArgs {
  port: number;
  upstream: string;
  /** Explicit `--dir` value, or `undefined` to fall back to env/default. */
  dir?: string;
}

/**
 * Resolve the captures directory: an explicit `--dir` wins, then
 * `JUNREI_CAPTURES_DIR`, else `~/.junrei/captures` — the SAME resolution the
 * server read side uses (`packages/server/src/sources/captures.ts`), so writer
 * and reader always agree on where captures live.
 */
export function resolveCapturesDir(
  env: Record<string, string | undefined> = process.env,
  dirFlag?: string,
): string {
  if (dirFlag !== undefined && dirFlag.trim() !== "") return dirFlag;
  const fromEnv = env.JUNREI_CAPTURES_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".junrei", "captures");
}

/** Parse `--port`, `--upstream`, `--dir` from an argv slice (`process.argv.slice(2)`). */
export function parseArgs(argv: readonly string[]): ProxyArgs {
  const args: ProxyArgs = { port: DEFAULT_PORT, upstream: DEFAULT_UPSTREAM };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--port") {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isNaN(parsed)) throw new Error("--port requires a number");
      args.port = parsed;
    } else if (flag === "--upstream") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--upstream requires a URL");
      args.upstream = value;
    } else if (flag === "--dir") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--dir requires a path");
      args.dir = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}
