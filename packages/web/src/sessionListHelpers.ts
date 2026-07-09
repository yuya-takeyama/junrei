import type { SessionListItem } from "./api.js";
import type { SourceTab } from "./router.js";

/**
 * Query params for `GET /api/sessions` given the active source tab — pulled
 * out of `SessionList` so the "which source did we actually ask the server
 * for" decision is independently testable without mocking `fetch`/the Hono
 * RPC client. `SourceTab` already matches the server's `source` query values
 * 1:1 (`"all" | "claude-code" | "codex"`), so this is mostly identity, but
 * keeping it a named function documents that the web always passes `source`
 * explicitly now — omitting it would silently fall back to Claude-only on
 * the server (see `sessions.ts`'s `listSessions` default).
 */
export function sessionsListQuery(
  tab: SourceTab,
  limit: string,
): { limit: string; source: SourceTab } {
  return { limit, source: tab };
}

/**
 * Subagent-count cell text — shows the real count for both harnesses now
 * that Codex sub-agent threads have a real count too (see
 * `codex/orchestration.ts` in `@junrei/core`); a literal "0" still reads
 * as "checked, found none" rather than "not applicable", so both sources
 * fall back to an em dash for the common no-delegation case instead.
 */
export function subagentCellText(item: SessionListItem): string {
  return item.subagentCount > 0 ? String(item.subagentCount) : "—";
}

/** Compact per-row source label for the "All" tab's badge column. */
export function sourceBadgeLabel(source: SessionListItem["source"]): string {
  return source === "codex" ? "Codex" : "Claude";
}

/** Whether a session-list row's cost figure is a Codex API-list-price estimate rather than a billed amount. */
export function isEstimatedCost(item: SessionListItem): boolean {
  return item.source === "codex";
}
