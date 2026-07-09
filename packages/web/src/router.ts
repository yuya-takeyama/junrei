/**
 * Lens tabs shown inside a session shell (the persistent "band" + tab bar).
 * "turns" is Codex-only (per-turn model/duration/token table). Codex gets
 * the same tab order as Claude (overview/timeline/orchestration/context/
 * files — see `codex/orchestration.ts` / `codex/files-skills.ts` in
 * `@junrei/core` for how a Codex sub-agent forest and file access/skill
 * invocations are derived), with "turns" appended last as its one extra,
 * Codex-only tab — see `CLAUDE_LENSES`/`CODEX_LENSES` below.
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

/** Tab bar for a Codex session shell — Claude's tab order, plus "turns" (Codex-only) appended last. */
export const CODEX_LENSES: readonly Lens[] = [
  "overview",
  "timeline",
  "orchestration",
  "context",
  "files",
  "turns",
];

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

/**
 * Identifies one session to link/fetch — mirrors the server's per-source key
 * shapes (`ClaudeSessionKey`/`CodexSessionKey` in `@junrei/server`): Claude
 * scopes by `{project, id}`, Codex by `{id}` alone. `sessionPath`/`recordPath`
 * below take this instead of a bare `project`/`id` pair (the pre-refactor
 * shape, back when a `projectDirName: "codex"` sentinel let Codex sessions
 * pretend to have a project) so a caller can never build a URL for the wrong
 * source by accident.
 */
export type SessionRef =
  | { source: "claude-code"; project: string; id: string }
  | { source: "codex"; id: string };

/** Builds a `SessionRef` from a session-list row (`AnySessionListItem` on the server) — see `SessionRef`. */
export function sessionRefOf(item: {
  source: "claude-code" | "codex";
  sessionId: string;
  projectDirName?: string;
}): SessionRef {
  return item.source === "codex"
    ? { source: "codex", id: item.sessionId }
    : { source: "claude-code", project: item.projectDirName ?? "", id: item.sessionId };
}

/** react-router path pattern for the Claude Code session shell route, registered with `createHashRouter`. */
export const CLAUDE_SESSION_ROUTE_PATH = "session/claude-code/:project/:id/:lens?";

/** react-router path pattern for the Codex session shell route — no `:project` segment (Codex has none). */
export const CODEX_SESSION_ROUTE_PATH = "session/codex/:id/:lens?";

/**
 * Build the path for a session route (no leading `#` — `createHashRouter`
 * prepends it, and `<Link to>` targets are always plain pathnames). Omits the
 * lens segment for "overview" to match the historical hash shape
 * (`#/session/.../id` rather than `#/session/.../id/overview`).
 */
export function sessionPath(ref: SessionRef, lens: Lens = "overview"): string {
  const base =
    ref.source === "codex"
      ? `/session/codex/${encodeURIComponent(ref.id)}`
      : `/session/claude-code/${encodeURIComponent(ref.project)}/${encodeURIComponent(ref.id)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * (L3, screen 8) for a given source line — see `RecordDetail.tsx`.
 *
 * The record slide-over is addressed with a `?record=<line>` query segment
 * appended to the session path (e.g. `#/session/claude-code/proj/id/timeline?record=42`)
 * rather than component-local state. Reasons: (1) it makes a specific record
 * shareable/bookmarkable, matching how every other drill-down in this app is
 * a real URL; (2) opening the panel pushes a history entry, so the browser
 * Back button closes it; (3) the lens path segment is untouched, so the
 * underlying lens component never unmounts and its scroll position survives
 * open/close, satisfying "without losing place".
 */
export function recordPath(ref: SessionRef, lens: Lens, line: number): string {
  return `${sessionPath(ref, lens)}?record=${line}`;
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
 * registered with `createHashRouter` alongside `CLAUDE_SESSION_ROUTE_PATH`.
 * Claude-only — Codex sub-agent threads are full sessions in their own right
 * (see `sources/codex.ts` on the server), not sidecar transcripts scoped
 * under a parent session, so there's no Codex equivalent of this route. The
 * static `agent` segment disambiguates it from `CLAUDE_SESSION_ROUTE_PATH`'s
 * optional `:lens?` — react-router ranks a route with more static segments
 * higher, so `/session/claude-code/p/id/agent/x` matches this pattern rather
 * than being parsed as `CLAUDE_SESSION_ROUTE_PATH` with `lens="agent"` (see
 * router.test.ts).
 */
export const AGENT_ROUTE_PATH = "session/claude-code/:project/:id/agent/:agentId/:lens?";

/**
 * Build the path for an agent (subagent detail, L3) route — mirrors
 * `sessionPath`, omitting the lens segment for "overview". Claude-only, see
 * `AGENT_ROUTE_PATH`.
 */
export function agentPath(
  project: string,
  id: string,
  agentId: string,
  lens: Lens = "overview",
): string {
  const base = `/session/claude-code/${encodeURIComponent(project)}/${encodeURIComponent(id)}/agent/${encodeURIComponent(agentId)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * scoped to one agent's own transcript — mirrors `recordPath`. Claude-only.
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
