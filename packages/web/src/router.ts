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
 * shapes (`ClaudeSessionKey`/`CodexSessionKey` in `@junrei/server`), both now
 * `{id}` alone: session ids are UUIDv4, so Claude no longer needs a project
 * dir to disambiguate a lookup (see `ClaudeSessionKey`'s doc comment on the
 * server) — matching Codex, which never had a project-dir concept.
 */
export type SessionRef = { source: "claude-code"; id: string } | { source: "codex"; id: string };

/** Builds a `SessionRef` from a session-list row (`AnySessionListItem` on the server) — see `SessionRef`. */
export function sessionRefOf(item: {
  source: "claude-code" | "codex";
  sessionId: string;
}): SessionRef {
  return { source: item.source, id: item.sessionId };
}

/**
 * react-router path pattern for the Claude Code session shell route,
 * registered with `createHashRouter` — bare session id, no `:project`
 * segment (dropped once bare-id server lookup made it unnecessary — see
 * `SessionRef`'s doc comment). Symmetric with `CODEX_SESSION_ROUTE_PATH`.
 */
export const CLAUDE_SESSION_ROUTE_PATH = "session/claude-code/:id/:lens?";

/** react-router path pattern for the Codex session shell route — no `:project` segment (Codex has none). */
export const CODEX_SESSION_ROUTE_PATH = "session/codex/:id/:lens?";

/**
 * UUID (v4-shaped) matcher used by the legacy-URL guards below — a
 * `projectDirName` always starts with `-` (an encoded absolute path) and is
 * never a UUID, so this is an unambiguous way to tell a real session id apart
 * from a stale `:project` segment.
 */
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the path for a session route (no leading `#` — `createHashRouter`
 * prepends it, and `<Link to>` targets are always plain pathnames). Omits the
 * lens segment for "overview" to match the historical hash shape
 * (`#/session/.../id` rather than `#/session/.../id/overview`). Both sources
 * share the same shape now (`/session/<source>/<id>[/<lens>]`) — see
 * `SessionRef`'s doc comment.
 */
export function sessionPath(ref: SessionRef, lens: Lens = "overview"): string {
  const base = `/session/${ref.source}/${encodeURIComponent(ref.id)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * True when a Claude Code session route's `:id`/`:lens?` params are actually
 * the legacy 2-segment URL shape (`#/session/claude-code/<projectDirName>/<uuid>`,
 * no explicit lens) — under `CLAUDE_SESSION_ROUTE_PATH`'s pattern, this SHORT
 * legacy shape still matches (`:id` capturing the stale project dir, `:lens`
 * capturing the real id), so `SessionShell` consults this to redirect it
 * on the spot. A `projectDirName` is never UUID-shaped (see `SESSION_UUID_RE`'s
 * doc comment), so "id isn't a UUID but lens is" is unambiguous — never true
 * for a current-shape URL, where the id segment is always the raw UUID.
 * Longer legacy shapes (explicit lens, or the agent-drilldown route) don't
 * match this route at all and fall through to the catch-all instead — see
 * `legacyClaudeSessionRedirectTarget`.
 */
export function isLegacyClaudeProjectScopedUrl(
  idParam: string | undefined,
  lensParam: string | undefined,
): boolean {
  return (
    idParam !== undefined &&
    !SESSION_UUID_RE.test(idParam) &&
    lensParam !== undefined &&
    SESSION_UUID_RE.test(lensParam)
  );
}

/**
 * Legacy URL guard (web-only) for bookmarked Claude Code session links that
 * still carry the old `:project` segment in a shape LONGER than
 * `CLAUDE_SESSION_ROUTE_PATH` can match — `#/session/claude-code/<projectDirName>/<uuid>/<lens>[?record=N]`
 * or the legacy agent-drilldown shape
 * `#/session/claude-code/<projectDirName>/<uuid>/agent/<agentId>[/<lens>]`.
 * These fall through every registered route to react-router's catch-all,
 * where this helper is consulted (see main.tsx). The plain 2-segment legacy
 * shape (`.../<project>/<uuid>` with no lens) is SHORT enough to still match
 * `CLAUDE_SESSION_ROUTE_PATH`'s optional `:lens?`, so it's handled inside
 * `SessionShell` instead (see its own UUID guard).
 *
 * Returns the redirect target (new path + preserved query string), or
 * `undefined` when `pathname` doesn't match the legacy shape — the catch-all
 * falls back to the session list in that case, same as before this guard
 * existed.
 */
export function legacyClaudeSessionRedirectTarget(
  pathname: string,
  search: string,
): string | undefined {
  const match = /^\/session\/claude-code\/([^/]+)\/([^/]+)((?:\/.*)?)$/.exec(pathname);
  if (match === null) return undefined;
  const [, project, id, rest] = match;
  if (project === undefined || id === undefined || rest === undefined) return undefined;
  if (SESSION_UUID_RE.test(project) || !SESSION_UUID_RE.test(id)) return undefined;
  return `/session/claude-code/${id}${rest}${search}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * (L3, screen 8) for a given source line — see `RecordDetail.tsx`.
 *
 * The record slide-over is addressed with a `?record=<line>` query segment
 * appended to the session path (e.g. `#/session/claude-code/id/timeline?record=42`)
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
 * higher, so `/session/claude-code/id/agent/x` matches this pattern rather
 * than being parsed as `CLAUDE_SESSION_ROUTE_PATH` with `lens="agent"` (see
 * router.test.ts).
 */
export const AGENT_ROUTE_PATH = "session/claude-code/:id/agent/:agentId/:lens?";

/**
 * Build the path for an agent (subagent detail, L3) route — mirrors
 * `sessionPath`, omitting the lens segment for "overview". Claude-only, see
 * `AGENT_ROUTE_PATH`.
 */
export function agentPath(id: string, agentId: string, lens: Lens = "overview"): string {
  const base = `/session/claude-code/${encodeURIComponent(id)}/agent/${encodeURIComponent(agentId)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * scoped to one agent's own transcript — mirrors `recordPath`. Claude-only.
 */
export function agentRecordPath(id: string, agentId: string, lens: Lens, line: number): string {
  return `${agentPath(id, agentId, lens)}?record=${line}`;
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

/**
 * Normalizes the `?page=` query param on the session list to a 1-based page
 * number, falling back to 1 for anything missing, non-numeric, or < 1 — same
 * "never break on a stale URL" shape as `parseSourceTab` above.
 */
export function parseListPage(value: string | null): number {
  const page = value !== null && /^\d+$/.test(value) ? Number.parseInt(value, 10) : 0;
  return page >= 1 ? page : 1;
}

/** Sentinel `?repo=` value (and absence thereof) meaning "no repo filter" — see `parseRepoParam`. */
export const ALL_REPOS = "all";

/**
 * Normalizes the `?repo=` query param on the session list to a filter value.
 * Unlike `parseSourceTab`, valid values aren't a fixed enum — they're
 * whatever `repoFilterKey` (see `sessionListHelpers.ts`) produces for the
 * sessions currently loaded, which is normally a `repoRoot` path — so this
 * only normalizes "param absent" to the `"all"` sentinel and passes anything
 * else through verbatim. A stale/unrecognized value just matches zero rows
 * until the user picks again, the same failure mode as any other filter
 * param pointing at data that no longer exists.
 */
export function parseRepoParam(value: string | null): string {
  return value ?? ALL_REPOS;
}
