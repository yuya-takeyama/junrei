import type { SessionSource } from "@junrei/core";
import { type ClaudeSessionListItem, claudeAdapter } from "./sources/claude.js";
import { type CodexSessionListItem, codexAdapter } from "./sources/codex.js";

/** Either harness's list item, discriminated on `source`. */
export type AnySessionListItem = ClaudeSessionListItem | CodexSessionListItem;

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
 * `listItems(max)` returns AT MOST `max` entries, ordered by `sortMs` desc —
 * the session's start time in epoch ms, falling back to a file-timestamp
 * proxy when the transcript carries no `startedAt`. `max` is a cost bound,
 * not just a truncation: the Claude adapter uses it to skip ANALYZING
 * transcripts that can't make the requested page (the whole point of
 * paginating — the first page no longer parses every session on the
 * machine). `total` is the source's full listable-session count regardless
 * of `max`, so pagination can be sized without analyzing everything.
 */
interface ListingAdapter {
  source: SessionSource;
  listItems(
    max?: number,
  ): Promise<{ entries: { item: AnySessionListItem; sortMs: number }[]; total: number }>;
}

const registry: readonly ListingAdapter[] = [claudeAdapter, codexAdapter];

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
 * app.ts).
 */
export async function listSessions(
  limit: number,
  source: SessionSourceFilter = "all",
  offset = 0,
): Promise<SessionListPage> {
  const adapters = source === "all" ? registry : registry.filter((a) => a.source === source);
  const results = await Promise.all(adapters.map((a) => a.listItems(offset + limit)));
  const sessions = results
    .flatMap((r) => r.entries)
    .sort((a, b) => b.sortMs - a.sortMs)
    .slice(offset, offset + limit)
    .map((r) => r.item);
  return { sessions, total: results.reduce((sum, r) => sum + r.total, 0) };
}

export {
  type ClaudeSessionKey,
  type ClaudeSessionListItem,
  claudeAdapter,
  computeModelMix,
  getAgentSession,
  getClaudeLastActivityAt,
  getSession,
  getSessionRecordDetail,
  getTimeline,
} from "./sources/claude.js";
export {
  type CodexSessionAnalysisWithSubagents,
  type CodexSessionKey,
  type CodexSessionListItem,
  codexAdapter,
  getCodexLastActivityAt,
  getCodexSession,
  getCodexSessionRecordDetail,
  getCodexTimeline,
} from "./sources/codex.js";
