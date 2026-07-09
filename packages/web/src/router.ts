/**
 * Lens tabs shown inside a session shell (the persistent "band" + tab bar).
 * "turns" is Codex-only (per-turn model/duration/token table). Codex now
 * also gets "timeline" (see `codex/timeline.ts` in `@junrei/core`), but has
 * no subagent tree, files/skills, or orchestration concept, so a Codex
 * session shell shows overview/timeline/context/turns — see
 * `CLAUDE_LENSES`/`CODEX_LENSES` below.
 */
export type Lens = "overview" | "timeline" | "orchestration" | "context" | "files" | "turns";

const LENSES: readonly Lens[] = [
  "overview",
  "timeline",
  "orchestration",
  "context",
  "files",
  "turns",
];

/** Human label per lens — shared by SessionShell (L1) and AgentShell (L3) for the tab bar and placeholders. */
export const LENS_LABEL: Record<Lens, string> = {
  overview: "Overview",
  timeline: "Timeline",
  orchestration: "Orchestration",
  context: "Context & cost",
  files: "Files & skills",
  turns: "Turns",
};

/** Tab bar for a Claude Code session shell — unchanged from the pre-Codex lineup. */
export const CLAUDE_LENSES: readonly Lens[] = [
  "overview",
  "timeline",
  "orchestration",
  "context",
  "files",
];

/** Tab bar for a Codex session shell — no subagent tree, orchestration, or files/skills data exists to show. */
export const CODEX_LENSES: readonly Lens[] = ["overview", "timeline", "context", "turns"];

function isLens(value: string | undefined): value is Lens {
  return value !== undefined && (LENSES as readonly string[]).includes(value);
}

/**
 * Normalizes an optional lens URL segment to a valid `Lens`, defaulting to
 * "overview" for anything unrecognized. Normalization happens only in the
 * rendered component — the URL itself is never rewritten, so a stale or
 * invalid lens segment stays exactly as typed (matches the pre-react-router
 * `parseRoute` fallback behavior).
 */
export function normalizeLens(value: string | undefined): Lens {
  return isLens(value) ? value : "overview";
}

/** react-router path pattern for the session shell route, registered with `createHashRouter`. */
export const SESSION_ROUTE_PATH = "session/:project/:id/:lens?";

/**
 * Build the path for a session route (no leading `#` — `createHashRouter`
 * prepends it, and `<Link to>` targets are always plain pathnames). Omits the
 * lens segment for "overview" to match the historical hash shape
 * (`#/session/p/id` rather than `#/session/p/id/overview`).
 */
export function sessionPath(project: string, id: string, lens: Lens = "overview"): string {
  const base = `/session/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * (L3, screen 8) for a given source line — see `RecordDetail.tsx`.
 *
 * The record slide-over is addressed with a `?record=<line>` query segment
 * appended to the session path (e.g. `#/session/proj/id/timeline?record=42`)
 * rather than component-local state. Reasons: (1) it makes a specific record
 * shareable/bookmarkable, matching how every other drill-down in this app is
 * a real URL; (2) opening the panel pushes a history entry, so the browser
 * Back button closes it; (3) the lens path segment is untouched, so the
 * underlying lens component never unmounts and its scroll position survives
 * open/close, satisfying "without losing place".
 */
export function recordPath(project: string, id: string, lens: Lens, line: number): string {
  return `${sessionPath(project, id, lens)}?record=${line}`;
}

/**
 * Parses the `record` search param the same way the old hash parser did: a
 * bare non-negative integer, or nothing.
 */
export function parseRecordParam(searchParams: URLSearchParams): number | undefined {
  const raw = searchParams.get("record");
  return raw !== null && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
}

/**
 * react-router path pattern for the agent (subagent detail, L3) shell route,
 * registered with `createHashRouter` alongside `SESSION_ROUTE_PATH`. The
 * static `agent` segment disambiguates it from `SESSION_ROUTE_PATH`'s
 * optional `:lens?` — react-router ranks a route with more static segments
 * higher, so `/session/p/id/agent/x` matches this pattern rather than being
 * parsed as `SESSION_ROUTE_PATH` with `lens="agent"` (see router.test.ts).
 */
export const AGENT_ROUTE_PATH = "session/:project/:id/agent/:agentId/:lens?";

/**
 * Build the path for an agent (subagent detail, L3) route — mirrors
 * `sessionPath`, omitting the lens segment for "overview".
 */
export function agentPath(
  project: string,
  id: string,
  agentId: string,
  lens: Lens = "overview",
): string {
  const base = `/session/${encodeURIComponent(project)}/${encodeURIComponent(id)}/agent/${encodeURIComponent(agentId)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * scoped to one agent's own transcript — mirrors `recordPath`.
 */
export function agentRecordPath(
  project: string,
  id: string,
  agentId: string,
  lens: Lens,
  line: number,
): string {
  return `${agentPath(project, id, agentId, lens)}?record=${line}`;
}

/** Session-list source filter tab — mirrors the server's `SessionSourceFilter` minus omission (the web always passes one explicitly). */
export type SourceTab = "all" | "claude-code" | "codex";

const SOURCE_TABS: readonly SourceTab[] = ["all", "claude-code", "codex"];

function isSourceTab(value: string | null): value is SourceTab {
  return value !== null && (SOURCE_TABS as readonly string[]).includes(value);
}

/**
 * Normalizes the `?source=` query param on the session list to a valid
 * `SourceTab`, defaulting to "all" for anything missing or unrecognized —
 * same fallback shape as `normalizeLens` above, so a stale/invalid `source`
 * value never breaks the page, it just falls back to the merged view.
 */
export function parseSourceTab(value: string | null): SourceTab {
  return isSourceTab(value) ? value : "all";
}
