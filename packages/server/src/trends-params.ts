/**
 * `days`/`timeZone` query-param parsing shared by every trends surface —
 * `GET /api/trends` (app.ts) and the `get_trends` MCP tool (mcp.ts) — so the
 * whitelist/default/validation logic can't drift between the two. Both
 * surfaces hand the SAME `days`/`timeZone` pair to `@junrei/core`'s
 * `computeTrends` and use the SAME `2*days + 2` day lookback margin when
 * calling `listAllSessionsInBounds` — see each call site's own doc comment
 * for why that margin is a safe superset of both the current and previous
 * window.
 */

/** One day in milliseconds — the lookback-margin unit both trends surfaces use. */
export const TRENDS_DAY_MS = 24 * 60 * 60 * 1000;

/** `days` query/tool param — a fixed whitelist (not an arbitrary integer) so the 2×`days` lookback fetch stays cheap and predictable. */
export const TRENDS_DAYS_WHITELIST = new Set([7, 14, 30]);
export const DEFAULT_TRENDS_DAYS = 14;
export const DEFAULT_TRENDS_TIMEZONE = "UTC";

/** A `days` value outside the whitelist (missing, non-numeric, or some other integer) silently falls back to the default — same "coerce, don't error" convention `GET /api/sessions`'s `limit`/`offset` already use. */
export function parseTrendsDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return TRENDS_DAYS_WHITELIST.has(parsed) ? parsed : DEFAULT_TRENDS_DAYS;
}

/** `Intl.DateTimeFormat` throws `RangeError` for a `timeZone` it doesn't recognize as a valid IANA name — the cheapest correct validator, no IANA database bundled/parsed by hand. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
