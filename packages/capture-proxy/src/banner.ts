/**
 * The startup banner (Goshuin Phase D, Decision 6 — MANDATORY, always printed).
 * It states plainly what is captured, that captures are sensitive and must
 * never be committed/shared, that auth headers are redacted at write time, the
 * subscription-vs-API-key ToS distinction, and that retention is the user's to
 * manage — then prints the exact usage line the user pastes to route Claude
 * Code through the proxy.
 */

/** The exact usage line: `ANTHROPIC_BASE_URL=http://localhost:<port> claude`. */
export function usageLine(port: number): string {
  return `ANTHROPIC_BASE_URL=http://localhost:${port} claude`;
}

export interface BannerContext {
  port: number;
  capturesDir: string;
  upstream: string;
}

/**
 * The full banner as a list of lines. Kept as data (not a single template) so
 * it can be asserted piecewise in tests and printed line-by-line to stderr.
 */
export function bannerLines(ctx: BannerContext): string[] {
  return [
    "===============================================================================",
    " Junrei wire-capture proxy — LOCAL-ONLY, OPT-IN",
    "===============================================================================",
    ` Listening : http://127.0.0.1:${ctx.port}  (127.0.0.1 only — never a public interface)`,
    ` Upstream  : ${ctx.upstream}`,
    ` Captures  : ${ctx.capturesDir}`,
    "",
    " This proxy captures your FULL API traffic — INCLUDING PROMPT CONTENTS — to",
    " local JSONL files. Treat those files as SENSITIVE: never commit or share them.",
    "",
    " Auth headers (authorization, x-api-key, cookies, *token*, *secret*) are",
    " REDACTED at write time; the pass-through to the API stays byte-faithful.",
    "",
    " ToS note: for Anthropic SUBSCRIPTION (OAuth) accounts, routing traffic through",
    " a local proxy sits in a DOCUMENTED ToS GRAY ZONE (see docs/milestones/",
    " goshuin.md) — it is entirely your own local, opt-in choice. API-KEY usage",
    " carries no such caveat.",
    "",
    " Retention is USER-MANAGED: delete ~/.junrei/captures (or the dir above)",
    " anytime.",
    "",
    " To capture a Claude Code session, run it against this proxy:",
    "",
    `   ${usageLine(ctx.port)}`,
    "",
    "===============================================================================",
  ];
}

/** Print the banner to `out` (stderr by default, so it never pollutes stdout). */
export function printBanner(
  ctx: BannerContext,
  out: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  for (const line of bannerLines(ctx)) out(line);
}
