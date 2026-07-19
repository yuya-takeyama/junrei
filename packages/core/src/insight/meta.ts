/**
 * `_meta` construction shared by every composition function. Kept tiny and
 * dependency-free so both the pure builders (`briefing`/`sessionInsight`/…)
 * and the fs-backed store can attach the same envelope.
 */
import type { InsightMeta } from "./types.js";

/**
 * Rough token estimate: `JSON.stringify(value).length / 4`. Deliberately the
 * SAME 4-chars-per-token heuristic the rest of `@junrei/core` already uses to
 * label cost/context figures (`bash-stats.ts`, `completeness.ts`) — good for
 * "will this blow my context budget", not exact accounting. A value that
 * can't be serialized (a cycle) falls back to `0` rather than throwing: a
 * size estimate must never be the thing that breaks a response.
 */
export function approxTokens(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value ?? null).length / 4);
  } catch {
    return 0;
  }
}

/**
 * Build the `_meta` envelope for a payload. `approxTokens` is measured over
 * `payload` as passed (i.e. BEFORE `_meta` is attached — attach the returned
 * value to a copy that does not include it, or accept that the figure omits
 * `_meta`'s own small size, which is the convention here). Optional
 * `truncated`/`nextSteps` are included only when meaningful, honoring
 * `exactOptionalPropertyTypes` (omitted, never set to `undefined`).
 */
export function buildMeta(
  payload: unknown,
  opts: { truncated?: boolean; nextSteps?: string[] } = {},
): InsightMeta {
  return {
    approxTokens: approxTokens(payload),
    ...(opts.truncated === true && { truncated: true }),
    ...(opts.nextSteps !== undefined && opts.nextSteps.length > 0 && { nextSteps: opts.nextSteps }),
  };
}
