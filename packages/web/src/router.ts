/**
 * Lens tabs shown inside a session shell (the persistent "band" + tab bar).
 * Codex gets the same tab order as Claude
 * (overview/timeline/orchestration/context/files/bash — see
 * `codex/orchestration.ts` / `codex/files-skills.ts` / `codex/bash-stats.ts`
 * in `@junrei/core` for how a Codex sub-agent forest, file access/skill
 * invocations, and shell-call analytics are derived) — see
 * `CLAUDE_LENSES`/`CODEX_LENSES` below.
 *
 * A former Codex-only "turns" lens (per-turn model/duration/token table)
 * existed here through Phase 1 of docs/roadmap.md's "Unified Timeline"; it's
 * gone from this union now that Phase 2 folded its table into the Timeline
 * lens's own turn-grouped spine (see `Timeline.tsx`'s `turnGroupable`).
 * `normalizeLens` still accepts the literal string `"turns"` as an input and
 * redirects it to `"timeline"` (see below) so old bookmarks/links keep
 * working — that redirect is what lets it be dropped from the `Lens` union
 * itself rather than kept as a dead tab value.
 *
 * "bash" (command ranking / context consumption / waste detection, backed by
 * `SessionAnalysisCore.bashStats` — see `Bash.tsx`) used to be Claude-only
 * (no Codex shell-call source fed it) — that gap closed once
 * `codex/bash-stats.ts` (`@junrei/core`) started extracting shell calls from
 * `function_call`/`local_shell_call`/the 0.144+ unified-exec
 * `custom_tool_call`, so `CLAUDE_LENSES`/`CODEX_LENSES` are now identical
 * again (kept as separate exports anyway — see `CODEX_LENSES`'s own doc
 * comment).
 */
export type Lens = "overview" | "timeline" | "orchestration" | "context" | "files" | "bash";

const LENSES: readonly Lens[] = [
  "overview",
  "timeline",
  "orchestration",
  "context",
  "files",
  "bash",
];

/** Human label per lens — shared by SessionShell (L1) and AgentShell (L3) for the tab bar and placeholders. */
export const LENS_LABEL: Record<Lens, string> = {
  overview: "Overview",
  timeline: "Timeline",
  orchestration: "Orchestration",
  context: "Context & cost",
  files: "Files & skills",
  bash: "Bash",
};

/** Tab bar for a Claude Code session shell — includes "bash" (Claude-only, see `Lens`'s doc comment). */
export const CLAUDE_LENSES: readonly Lens[] = [
  "overview",
  "timeline",
  "orchestration",
  "context",
  "files",
  "bash",
];

/**
 * Tab bar for a Codex session shell — identical to `CLAUDE_LENSES` (see
 * `Lens`'s doc comment on "bash" for why it's included now). Kept as its own
 * export, rather than collapsed into a single constant, since the two
 * lineups are independent facts that happen to fully overlap today — a
 * future Codex-only (or Claude-only) lens should be free to diverge without
 * an unrelated rename.
 */
export const CODEX_LENSES: readonly Lens[] = [
  "overview",
  "timeline",
  "orchestration",
  "context",
  "files",
  "bash",
];

/**
 * Lens lineup per source — a lookup, so the shells (SessionShell/AgentShell)
 * index it instead of branching on `source` themselves.
 */
export const LENSES_BY_SOURCE: Record<SessionRef["source"], readonly Lens[]> = {
  "claude-code": CLAUDE_LENSES,
  codex: CODEX_LENSES,
};

function isLens(value: string | undefined): value is Lens {
  return value !== undefined && (LENSES as readonly string[]).includes(value);
}

/**
 * Legacy lens URL segments that no longer name a current `Lens`, mapped to
 * where that content now lives — checked by `normalizeLens` before the
 * `isLens` union check, so the alias can resolve even though the target
 * string was deliberately dropped from `Lens` itself (see its doc comment).
 * "turns" is the only entry today: the Codex-only Turns tab folded into
 * Timeline's own turn-grouped spine in docs/roadmap.md's "Unified Timeline"
 * Phase 2.
 */
const LEGACY_LENS_ALIASES: Record<string, Lens> = {
  turns: "timeline",
};

/**
 * Normalizes an optional lens URL segment to a valid `Lens`: a known legacy
 * alias redirects to its replacement (see `LEGACY_LENS_ALIASES`), a current
 * lens passes through, and anything else falls back to "overview".
 * Normalization happens only in the rendered component — the URL itself is
 * never rewritten, so a stale or invalid lens segment stays exactly as typed
 * (matches the pre-react-router `parseRoute` fallback behavior).
 */
export function normalizeLens(value: string | undefined): Lens {
  if (isLens(value)) return value;
  if (value !== undefined && value in LEGACY_LENS_ALIASES) {
    return LEGACY_LENS_ALIASES[value] as Lens;
  }
  return "overview";
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
 * registered with `createBrowserRouter` — bare session id, no `:project`
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
 * Build the path for a session route (`<Link to>` targets are always plain
 * pathnames — `createBrowserRouter` needs no `#` prefix). Omits the lens
 * segment for "overview" to match the app's historical URL shape (formerly
 * `#/session/.../id` under the hash router, now `/session/.../id` — rather
 * than `/session/.../id/overview`). Both sources share the same shape now
 * (`/session/<source>/<id>[/<lens>]`) — see `SessionRef`'s doc comment.
 */
export function sessionPath(ref: SessionRef, lens: Lens = "overview"): string {
  const base = `/session/${ref.source}/${encodeURIComponent(ref.id)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * True when a Claude Code session route's `:id`/`:lens?` params are actually
 * the legacy 2-segment URL shape (`/session/claude-code/<projectDirName>/<uuid>`,
 * no explicit lens — a `#/...` bookmark from before the history-router
 * migration is normalized to this plain-path form by main.tsx before the
 * router ever sees it) — under `CLAUDE_SESSION_ROUTE_PATH`'s pattern, this SHORT
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
 * `CLAUDE_SESSION_ROUTE_PATH` can match — `/session/claude-code/<projectDirName>/<uuid>/<lens>[?record=N]`
 * or the legacy agent-drilldown shape
 * `/session/claude-code/<projectDirName>/<uuid>/agent/<agentId>[/<lens>]`
 * (a pre-history-router `#/...` bookmark is normalized to this plain-path
 * form by main.tsx before the router runs — see `isLegacyClaudeProjectScopedUrl`'s
 * doc comment above).
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
 * appended to the session path (e.g. `/session/claude-code/id/timeline?record=42`)
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
 * react-router path patterns for the agent (subagent detail, L3) shell
 * routes, registered with `createBrowserRouter` alongside the session route
 * patterns — one per source, same split as `CLAUDE_SESSION_ROUTE_PATH`/
 * `CODEX_SESSION_ROUTE_PATH`. A Claude agent is a sidecar transcript scoped
 * under its session; a Codex sub-agent is a full session of its own (see
 * `sources/codex.ts` on the server), but both get the same nested URL shape
 * (`/session/<source>/<id>/agent/<agentId>[/<lens>]`) so a sub-agent's place
 * in its parent's tree is addressable and breadcrumbable for either source.
 * The static `agent` segment disambiguates these from the session patterns'
 * optional `:lens?` — react-router ranks a route with more static segments
 * higher, so `/session/claude-code/id/agent/x` matches this pattern rather
 * than being parsed as `CLAUDE_SESSION_ROUTE_PATH` with `lens="agent"` (see
 * router.test.ts).
 */
export const CLAUDE_AGENT_ROUTE_PATH = "session/claude-code/:id/agent/:agentId/:lens?";
export const CODEX_AGENT_ROUTE_PATH = "session/codex/:id/agent/:agentId/:lens?";

/**
 * Build the path for an agent (subagent detail, L3) route — mirrors
 * `sessionPath`, omitting the lens segment for "overview". `ref` is the
 * PARENT session the agent is viewed under; works for either source (see
 * `CLAUDE_AGENT_ROUTE_PATH`/`CODEX_AGENT_ROUTE_PATH`).
 */
export function agentPath(ref: SessionRef, agentId: string, lens: Lens = "overview"): string {
  const base = `/session/${ref.source}/${encodeURIComponent(ref.id)}/agent/${encodeURIComponent(agentId)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/**
 * Build the path (+ `record` search param) that opens the record slide-over
 * scoped to one agent's own transcript — mirrors `recordPath`.
 */
export function agentRecordPath(
  ref: SessionRef,
  agentId: string,
  lens: Lens,
  line: number,
): string {
  return `${agentPath(ref, agentId, lens)}?record=${line}`;
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
 *
 * Reused as-is by the Trends screen's own `?repo=` filter (Trends.tsx) — the
 * key semantics are identical (`GET /api/trends`'s `repo` param accepts the
 * same `repoRoot`/fallback-bucket keys as `GET /api/overview`'s, see
 * `trendRepoKey` in `@junrei/core`'s `trends.ts`), so it needs no
 * screen-specific variant.
 */
export function parseRepoParam(value: string | null): string {
  return value ?? ALL_REPOS;
}

const DAY_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalizes the session list's `?day=` query param — a single LOCAL
 * calendar day (`YYYY-MM-DD`) to filter the list to, the drill-down target
 * from a Trends screen spike-day row / daily chart column (see
 * `sessionListDayFilterPath` below). `undefined` for anything missing or
 * malformed, same "never break on a stale URL" convention as
 * `parseRepoParam`/`parseTrendsWindowDays` — a bad value just falls back to
 * whatever date filter was already active instead of throwing.
 */
export function parseDayParam(value: string | null): string | undefined {
  return value !== null && DAY_PARAM_RE.test(value) ? value : undefined;
}

/**
 * Session list URL that filters to exactly one local calendar day (and,
 * when given, a repo) — used by the Trends screen's drill-down links
 * (`AnomaliesPanel.tsx`'s spike-day rows, `DailyCostChart.tsx`'s columns).
 * `day` is expected to be a `TrendBucket.date`/`TrendSpikeDay.date` value
 * (`YYYY-MM-DD`, already a LOCAL calendar day in the viewer's own tz — see
 * `@junrei/core`'s `localDayKey`), and the session list's `?day=` filter
 * resolves it via `dateFilter.ts`'s `localDayStartMs`, which interprets the
 * same `YYYY-MM-DD` string in the BROWSER's own local timezone — since the
 * Trends screen always sends `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * (the browser's own tz) as its `tz` param, both screens agree on exactly
 * the same day boundaries for the same viewer. `repoKey` is omitted from the
 * URL when absent or the `ALL_REPOS` sentinel, matching every other repo-filter
 * link in this app.
 */
export function sessionListDayFilterPath(day: string, repoKey?: string): string {
  const params = new URLSearchParams({ day });
  if (repoKey !== undefined && repoKey !== ALL_REPOS) params.set("repo", repoKey);
  return `/?${params.toString()}`;
}

/** react-router path for the Trends screen — no dynamic segments, so (unlike the session/agent routes) no path-builder function is needed; a literal `/trends` Link target suffices, same as the session list's own bare `/`. */
export const TRENDS_ROUTE_PATH = "trends";

/**
 * `GET /api/trends`'s `days` whitelist, mirrored from the server
 * (`TRENDS_DAYS_WHITELIST` in `packages/server/src/app.ts`) so the window
 * selector only ever offers values the API actually accepts. Declared
 * independently from the session list's `DATE_FILTER_PRESET_DAYS`
 * (`dateFilter.ts`) even though the three numbers coincide today — the two
 * features' day-count choices are unrelated facts (one bounds a
 * client-filtered fetch window, the other bounds a fixed-shape server
 * aggregation) that could diverge later.
 */
export const TRENDS_WINDOW_DAYS: readonly number[] = [7, 14, 30];

/** Default `days` for a first visit / stale-or-missing `?days=` — matches the server's `DEFAULT_TRENDS_DAYS`. */
export const DEFAULT_TRENDS_WINDOW_DAYS = 14;

/**
 * Normalizes the Trends screen's `?days=` query param to a value from
 * `TRENDS_WINDOW_DAYS`, defaulting (like `parseListPage`/`parseSourceTab`)
 * anything missing or unrecognized to `DEFAULT_TRENDS_WINDOW_DAYS` rather
 * than erroring — same "never break on a stale URL" convention every other
 * query-param parser here follows.
 */
export function parseTrendsWindowDays(value: string | null): number {
  const days = value !== null ? Number(value) : Number.NaN;
  return TRENDS_WINDOW_DAYS.includes(days) ? days : DEFAULT_TRENDS_WINDOW_DAYS;
}
