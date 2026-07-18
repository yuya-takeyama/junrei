import type { SessionSource } from "@junrei/core";
import { type ClaudeSessionListItem, claudeAdapter, s3ClaudeAdapter } from "./sources/claude.js";
import { type CodexSessionListItem, codexAdapter } from "./sources/codex.js";
import type { SessionListBounds } from "./sources/shared.js";

/** Either harness's list item, discriminated on `source`. */
export type AnySessionListItem = ClaudeSessionListItem | CodexSessionListItem;

/**
 * Session-START-time bounds, epoch ms — `sinceMs` inclusive, `untilMs`
 * exclusive. Re-exported from `sources/shared.ts`, where it's actually
 * defined (see that file's doc comment on why: `shared.ts` can't import back
 * from this module without creating a cycle).
 */
export type { SessionListBounds } from "./sources/shared.js";

/** `"all"` merges both harnesses. */
export type SessionSourceFilter = SessionSource | "all";

/**
 * Ceiling shared by every full-repo listing: `/api/sessions`'s own upper
 * clamp AND `getRepoOverview` (`overview.ts`, called by both `GET
 * /api/overview` and the `get_repo_overview` MCP tool) — a repo-level rollup
 * shouldn't silently drop sessions the plain list would still show.
 */
export const MAX_LIST_LIMIT = 500;

/**
 * The minimal shape `listSessions` needs from a source adapter — just enough
 * to merge every source's list items into one start-time-sorted feed. Each
 * concrete adapter (`claudeAdapter`/`codexAdapter`, in `sources/claude.ts` /
 * `sources/codex.ts`) is a richer object with its own `getDetail`/
 * `getTimeline`/`getRecordDetail` methods keyed by that source's own key
 * shape (`ClaudeSessionKey`/`CodexSessionKey`) — those aren't part of this
 * shared interface because, even though both key shapes are now `{id}` alone
 * (see `ClaudeSessionKey`'s doc comment), app.ts already knows statically
 * which source's route it's handling, so it calls each adapter's own typed
 * methods directly rather than through this generic surface.
 *
 * `listItems(max, bounds)` returns AT MOST `max` entries, ordered by
 * `sortMs` desc — the session's start time in epoch ms, falling back to a
 * file-timestamp proxy when the transcript carries no `startedAt`. `max` is
 * a cost bound, not just a truncation: the Claude adapter uses it to skip
 * ANALYZING transcripts that can't make the requested page (the whole point
 * of paginating — the first page no longer parses every session on the
 * machine). `bounds` (see `SessionListBounds`, re-exported above) is a
 * second, independent cost bound on the same axis: a date filter narrows
 * which sessions are eligible at all, so the Claude adapter also uses it to
 * skip analysis for refs outside the window (see `claudeListItems`) — the
 * mechanism that makes a 7-day default list view cheap even when `max` alone
 * wouldn't have excluded an old session. `total` is the source's full
 * listable-session count regardless of `max`/`bounds`, so pagination can be
 * sized without analyzing everything.
 */
interface ListingAdapter {
  source: SessionSource;
  listItems(
    max?: number,
    bounds?: SessionListBounds,
  ): Promise<{ entries: { item: AnySessionListItem; sortMs: number }[]; total: number }>;
}

/**
 * `s3ClaudeAdapter` is only defined when `JUNREI_S3_SOURCE_URI` is set (see
 * `sources/claude.ts`) — registered as its OWN entry (not merged into
 * `claudeAdapter`) so S3 sessions show up in the merged list independently of
 * local ones, including the accepted case where the same session id exists
 * in both stores and both rows appear.
 */
const registry: readonly ListingAdapter[] = [
  claudeAdapter,
  ...(s3ClaudeAdapter !== undefined ? [s3ClaudeAdapter] : []),
  codexAdapter,
];

/** One page of the merged session list, plus the full count for pagination. */
export interface SessionListPage {
  sessions: AnySessionListItem[];
  /** Listable sessions across the selected source(s) — NOT the page length. */
  total: number;
}

/**
 * List one page of sessions for one or both harnesses, newest first by START
 * time (`startedAt`, falling back to a file-timestamp proxy — see
 * `ListingAdapter`). `"all"` merges both sources BEFORE applying
 * `offset`/`limit`, so the page window reflects true start-time order across
 * sources rather than truncating each source independently; each adapter is
 * asked for `offset + limit` entries, the most any single source could
 * contribute to the window. Omitted `source` also means `"all"` — every
 * client (web, MCP) is expected to pass `source` explicitly when it wants
 * one harness only; there is no back-compat Claude-only default left (see
 * app.ts). `bounds` (optional session-START-time bounds, see
 * `SessionListBounds`) is passed through to every adapter unchanged — it
 * narrows which sessions are eligible BEFORE `offset`/`limit` apply, and
 * never affects `total` (still every listable session regardless of
 * `bounds`, same as it's always been regardless of `limit`).
 */
export async function listSessions(
  limit: number,
  source: SessionSourceFilter = "all",
  offset = 0,
  bounds?: SessionListBounds,
): Promise<SessionListPage> {
  const adapters = source === "all" ? registry : registry.filter((a) => a.source === source);
  const results = await Promise.all(adapters.map((a) => a.listItems(offset + limit, bounds)));
  const sessions = results
    .flatMap((r) => r.entries)
    .sort((a, b) => b.sortMs - a.sortMs)
    .slice(offset, offset + limit)
    .map((r) => r.item);
  return { sessions, total: results.reduce((sum, r) => sum + r.total, 0) };
}

/**
 * Every session across the selected source(s) whose START time falls in
 * `bounds`, with NO page-size cap — unlike `listSessions`, which always asks
 * each adapter for `offset + limit` entries (capped publicly by callers at
 * `MAX_LIST_LIMIT`). `GET /api/trends` needs every session in its (up to)
 * 2×`days` window to compute accurate per-day buckets and a real
 * "previous window" total, not just a page of them.
 *
 * Passing `max: undefined` to an adapter's own `listItems` is exactly the
 * "no cap" mechanism that already exists (see `ListingAdapter`'s doc
 * comment: `max !== undefined` is the only condition that breaks the scan
 * early), so this doesn't require raising `MAX_LIST_LIMIT` itself — that
 * constant stays the public list/overview ceiling; this helper is a
 * DIFFERENT, narrower lever (bounded by date, not by page size) for a route
 * that genuinely needs everything in a date range.
 */
export async function listAllSessionsInBounds(
  bounds: SessionListBounds,
  source: SessionSourceFilter = "all",
): Promise<AnySessionListItem[]> {
  const adapters = source === "all" ? registry : registry.filter((a) => a.source === source);
  const results = await Promise.all(adapters.map((a) => a.listItems(undefined, bounds)));
  return results.flatMap((r) => r.entries).map((r) => r.item);
}

export {
  type ClaudeSessionKey,
  type ClaudeSessionListItem,
  claudeAdapter,
  computeModelMix,
  getAgentSession,
  getClaudeLastActivityAt,
  getSession,
  getSessionData,
  getSessionRecordDetail,
  getSessionToolCallDetail,
  getTimeline,
} from "./sources/claude.js";
export {
  type CodexSessionAnalysisWithSubagents,
  type CodexSessionKey,
  type CodexSessionListItem,
  codexAdapter,
  collectCodexToolCallThreads,
  getCodexLastActivityAt,
  getCodexSession,
  getCodexSessionBashStatsMainOnly,
  getCodexSessionRecordDetail,
  getCodexSessionToolCallDetail,
  getCodexTimeline,
} from "./sources/codex.js";
