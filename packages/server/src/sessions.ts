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
 * to merge every source's list items into one recency-sorted feed. Each
 * concrete adapter (`claudeAdapter`/`codexAdapter`, in `sources/claude.ts` /
 * `sources/codex.ts`) is a richer object with its own `getDetail`/
 * `getTimeline`/`getRecordDetail` methods keyed by that source's own key
 * shape (`ClaudeSessionKey`/`CodexSessionKey`) — those aren't part of this
 * shared interface because the key shapes differ (Claude scopes by
 * `{project, id}`, Codex by `{id}` alone) and app.ts already knows statically
 * which source's route it's handling, so it calls each adapter's own typed
 * methods directly rather than through this generic surface.
 */
interface ListingAdapter {
  source: SessionSource;
  listItems(): Promise<{ item: AnySessionListItem; mtimeMs: number }[]>;
}

const registry: readonly ListingAdapter[] = [claudeAdapter, codexAdapter];

/**
 * List sessions for one or both harnesses, newest first (by file mtime —
 * both discovery functions already sort that way, and merging preserves it).
 * `"all"` merges both, applying `limit` once *after* the merge so the cutoff
 * reflects true recency across sources rather than truncating each source
 * independently. Omitted `source` also means `"all"` — every client (web,
 * MCP) is expected to pass `source` explicitly when it wants one harness
 * only; there is no back-compat Claude-only default left (see app.ts).
 */
export async function listSessions(
  limit: number,
  source: SessionSourceFilter = "all",
): Promise<AnySessionListItem[]> {
  const adapters = source === "all" ? registry : registry.filter((a) => a.source === source);
  const lists = await Promise.all(adapters.map((a) => a.listItems()));
  return lists
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((r) => r.item);
}

export {
  type ClaudeSessionKey,
  type ClaudeSessionListItem,
  claudeAdapter,
  computeModelMix,
  getAgentSession,
  getSession,
  getSessionRecordDetail,
  getTimeline,
} from "./sources/claude.js";
export {
  type CodexSessionAnalysisWithSubagents,
  type CodexSessionKey,
  type CodexSessionListItem,
  codexAdapter,
  getCodexSession,
  getCodexSessionRecordDetail,
  getCodexTimeline,
} from "./sources/codex.js";
