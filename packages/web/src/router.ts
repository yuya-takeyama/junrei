/**
 * Session-detail navigation model (PR4 IA: Story / Orchestration / Evidence).
 *
 * The six historical lenses (overview/timeline/orchestration/context/files/
 * tools) collapsed into three top-level LENSES:
 *  - `story`        — the conclusion-first read: the FROM-THIS-SESSION insight
 *                     callout over the embedded Timeline (absorbs the old
 *                     `overview` + `timeline`).
 *  - `orchestration`— unchanged subagent-forest views (tree/waterfall/flame).
 *  - `evidence`     — the raw-detail lenses, now sub-tabs: `context` (the old
 *                     Context & cost), `files` (Files & skills), `tools` (the
 *                     cross-tool ranking, itself keeping its All | Bash split).
 *                     Evidence is where internal ids (line numbers, tool_use_id)
 *                     are the PRIMARY axis. They aren't exclusive to it, though:
 *                     the Story callout still names thread-id hashes in its waste
 *                     write-ups, and expanding a turn in Story's embedded Timeline
 *                     reveals the same per-record line-number citations it always
 *                     had (that drill-in was relocated wholesale into Story, not
 *                     rebuilt, so its ids came along). The split is about default
 *                     prominence — ids up front in Evidence, incidental elsewhere —
 *                     not a hard boundary.
 *
 * URL shape: `/session/<source>/<id>[/<lens>[/<sub>[/<sub2>]]]`.
 * `story` is the default lens and omits its segment (as `overview` did before);
 * `context` is the default evidence sub and omits its segment; `all` is the
 * default tools sub and omits its segment. So `/session/…/evidence` is the
 * Context sub-tab, `/session/…/evidence/tools` is Tools/All, and
 * `/session/…/evidence/tools/bash` is Tools/Bash.
 *
 * Every legacy lens URL redirects to its new home (see
 * `legacySessionLensRedirect` / `legacyAgentLensRedirect`, both tested):
 * overview→story, timeline→story, turns→story, context→evidence,
 * files→evidence/files, tools→evidence/tools, tools/bash→evidence/tools/bash,
 * bash→evidence/tools/bash.
 */
export type Lens = "story" | "orchestration" | "evidence";

/** Human label per lens — shared by SessionShell (L1) and AgentShell (L3) for the tab bar. */
export const LENS_LABEL: Record<Lens, string> = {
  story: "Story",
  orchestration: "Orchestration",
  evidence: "Evidence",
};

const LENSES: readonly Lens[] = ["story", "orchestration", "evidence"];

/**
 * Session-shell lens lineup — identical for both harnesses (a Codex session's
 * subagent forest / file-access / tool stats are all populated the same way
 * Claude's are; see `LENSES_BY_SOURCE`).
 */
export const SESSION_LENSES: readonly Lens[] = ["story", "orchestration", "evidence"];

/**
 * Lens lineup per source for the SESSION shell — a lookup, so the shell indexes
 * it instead of branching on `source`. Both sources get the full three; kept as
 * a per-source map (rather than one constant) so a future source-specific
 * divergence needs no call-site rename.
 */
export const LENSES_BY_SOURCE: Record<SessionRef["source"], readonly Lens[]> = {
  "claude-code": SESSION_LENSES,
  codex: SESSION_LENSES,
};

/**
 * Lens lineup for the AGENT (subagent detail, L3) shell — only the lenses
 * actually built for a subagent are shown as tabs (PR4 removed the "coming in a
 * later PR" placeholder tabs entirely). A Claude subagent gets Story + Evidence
 * (context/files); a Codex subagent additionally gets Orchestration, since its
 * own analysis carries a real subagent forest (see AgentShell). Tools is not
 * built for either at the agent level, so it never appears.
 */
export function agentLensesFor(source: SessionRef["source"]): readonly Lens[] {
  return source === "codex" ? ["story", "orchestration", "evidence"] : ["story", "evidence"];
}

function isLens(value: string | undefined): value is Lens {
  return value !== undefined && (LENSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Evidence sub-tabs
// ---------------------------------------------------------------------------

/**
 * The Evidence lens's sub-tabs. `context` is the default (omitted from the
 * URL). `tools` keeps its own further All | Bash split (`ToolsSubTab`),
 * addressed as a third URL segment (`/evidence/tools/bash`). The agent shell
 * only exposes `context`/`files` (no cross-thread Tools ranking there).
 */
export type EvidenceSub = "context" | "files" | "tools";

/** Session-shell Evidence sub-tabs (Tools included). */
export const EVIDENCE_SUBS_SESSION: readonly EvidenceSub[] = ["context", "files", "tools"];
/** Agent-shell Evidence sub-tabs (no cross-thread Tools ranking at the agent level). */
export const EVIDENCE_SUBS_AGENT: readonly EvidenceSub[] = ["context", "files"];

function isEvidenceSub(value: string | undefined): value is EvidenceSub {
  return value === "context" || value === "files" || value === "tools";
}

/**
 * Resolve the active Evidence sub-tab from the URL's `:sub?` segment. `context`
 * is the default when the segment is absent or unrecognized — the "never break
 * on a stale URL" convention every param parser here follows.
 */
export function normalizeEvidenceSub(subParam: string | undefined): EvidenceSub {
  return isEvidenceSub(subParam) ? subParam : "context";
}

/** The two sub-tabs the Evidence Tools sub hosts: `all` (default) and `bash`. */
export type ToolsSubTab = "all" | "bash";

function isToolsSubTab(value: string | undefined): value is ToolsSubTab {
  return value === "all" || value === "bash";
}

/**
 * Resolve the Tools All | Bash sub from the URL's third segment
 * (`/evidence/tools/<sub2>`). Only meaningful when the evidence sub is `tools`;
 * defaults to `all`.
 */
export function normalizeToolsSub(sub2Param: string | undefined): ToolsSubTab {
  return isToolsSubTab(sub2Param) ? sub2Param : "all";
}

// ---------------------------------------------------------------------------
// Lens normalization + legacy redirect matrix
// ---------------------------------------------------------------------------

/**
 * Legacy lens URL segments (dropped from the `Lens` union) mapped to the
 * canonical trailing path they now live at (no leading slash; `""` = the bare
 * story default). `tools`/`bash` are handled specially in the redirect helpers
 * because they carry a further sub segment.
 */
const LEGACY_LENS_TARGET: Record<string, string> = {
  overview: "",
  timeline: "",
  turns: "",
  context: "evidence",
  files: "evidence/files",
};

/** Legacy lens segments that must trigger a redirect (the URL is rewritten to canonical). */
const LEGACY_LENS_SEGMENTS = new Set([
  "overview",
  "timeline",
  "turns",
  "context",
  "files",
  "tools",
  "bash",
]);

/**
 * Canonical trailing path (no leading slash) for a raw lens/sub/sub2 triple,
 * mapping every legacy segment to its new home. `""` means the bare `story`
 * default. Shared by the redirect helpers and the project-scoped-URL rebuild so
 * the mapping can't diverge.
 */
export function canonicalLensSuffix(
  lensParam: string | undefined,
  subParam: string | undefined,
  sub2Param: string | undefined,
): string {
  if (lensParam === undefined) return "";
  if (lensParam === "story") return "";
  if (lensParam === "orchestration") return "orchestration";
  if (lensParam === "evidence") {
    const sub = normalizeEvidenceSub(subParam);
    if (sub === "context") return "evidence";
    if (sub === "files") return "evidence/files";
    return normalizeToolsSub(sub2Param) === "bash" ? "evidence/tools/bash" : "evidence/tools";
  }
  // Legacy lens segments:
  if (lensParam === "tools") {
    return subParam === "bash" ? "evidence/tools/bash" : "evidence/tools";
  }
  if (lensParam === "bash") return "evidence/tools/bash";
  if (lensParam in LEGACY_LENS_TARGET) return LEGACY_LENS_TARGET[lensParam] as string;
  // Unknown segment — fall back to story (rendered, not redirected).
  return "";
}

/**
 * The canonical `Lens` a raw first-segment resolves to (for rendering). A new
 * lens passes through; a legacy segment maps to its replacement; anything else
 * falls back to `story`. Never rewrites the URL itself — the redirect helpers
 * below own that.
 */
export function normalizeLens(value: string | undefined): Lens {
  if (isLens(value)) return value;
  if (value === "context" || value === "files" || value === "tools" || value === "bash") {
    return "evidence";
  }
  return "story";
}

/**
 * When a SESSION lens URL uses a legacy segment (`overview`/`timeline`/`turns`/
 * `context`/`files`/`tools`/`bash`), the canonical trailing path to redirect it
 * to; `undefined` when the URL is already canonical (a current lens, or an
 * unknown segment left to render as story). Pure so main.tsx / SessionShell and
 * the tests share one definition.
 */
export function legacySessionLensRedirect(
  lensParam: string | undefined,
  subParam: string | undefined,
  sub2Param: string | undefined,
): string | undefined {
  if (lensParam === undefined || !LEGACY_LENS_SEGMENTS.has(lensParam)) return undefined;
  return canonicalLensSuffix(lensParam, subParam, sub2Param);
}

/**
 * Agent-shell legacy redirect — same matrix as the session shell, minus the
 * cross-thread Tools ranking (which the agent shell doesn't host): a legacy
 * agent `tools`/`bash` URL lands on Evidence's Context sub instead. `undefined`
 * when already canonical.
 */
export function legacyAgentLensRedirect(lensParam: string | undefined): string | undefined {
  if (lensParam === undefined || !LEGACY_LENS_SEGMENTS.has(lensParam)) return undefined;
  if (lensParam === "context") return "evidence";
  if (lensParam === "files") return "evidence/files";
  // overview/timeline/turns → story; tools/bash have no agent home → Evidence/Context.
  if (lensParam === "tools" || lensParam === "bash") return "evidence";
  return "";
}

// ---------------------------------------------------------------------------
// Session refs + path building
// ---------------------------------------------------------------------------

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
 * react-router path patterns for the session shell routes — bare session id, no
 * `:project` segment. The trailing `:lens?/:sub?/:sub2?` addresses the lens, the
 * Evidence sub-tab, and (for Evidence/Tools) the All|Bash sub — all optional and
 * parsed only for the lens they belong to (SessionShell). A legacy project-scoped
 * URL WITH an explicit lens (`/<project>/<uuid>/<lens>`) still matches this
 * pattern (`:id=<project>`, `:lens=<uuid>`, `:sub=<lens>`, `:sub2=<oldsub>`);
 * SessionShell's own UUID guard (`isLegacyClaudeProjectScopedUrl`) redirects it,
 * preserving the trailing lens.
 */
export const CLAUDE_SESSION_ROUTE_PATH = "session/claude-code/:id/:lens?/:sub?/:sub2?";
/** react-router path pattern for the Codex session shell route — same trailing optional segments. */
export const CODEX_SESSION_ROUTE_PATH = "session/codex/:id/:lens?/:sub?/:sub2?";

/**
 * UUID (v4-shaped) matcher used by the legacy-URL guards below — a
 * `projectDirName` always starts with `-` (an encoded absolute path) and is
 * never a UUID, so this is an unambiguous way to tell a real session id apart
 * from a stale `:project` segment.
 */
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the path for a session route. Omits the segment for every default:
 * `story` lens, `context` evidence sub, `all` tools sub. So:
 *  - `sessionPath(ref)` / `sessionPath(ref, "story")` → `/session/<src>/<id>`
 *  - `sessionPath(ref, "orchestration")`             → `…/orchestration`
 *  - `sessionPath(ref, "evidence")`                  → `…/evidence` (context)
 *  - `sessionPath(ref, "evidence", "files")`         → `…/evidence/files`
 *  - `sessionPath(ref, "evidence", "tools")`         → `…/evidence/tools` (all)
 *  - `sessionPath(ref, "evidence", "tools", "bash")` → `…/evidence/tools/bash`
 * `sub`/`toolsSub` are ignored for any non-evidence lens.
 */
export function sessionPath(
  ref: SessionRef,
  lens: Lens = "story",
  sub?: EvidenceSub,
  toolsSub?: ToolsSubTab,
): string {
  const base = `/session/${ref.source}/${encodeURIComponent(ref.id)}`;
  if (lens === "story") return base;
  if (lens === "orchestration") return `${base}/orchestration`;
  // evidence
  const evSub = sub ?? "context";
  if (evSub === "context") return `${base}/evidence`;
  if (evSub === "files") return `${base}/evidence/files`;
  // tools
  return toolsSub === "bash" ? `${base}/evidence/tools/bash` : `${base}/evidence/tools`;
}

/**
 * True when a Claude Code session route's `:id`/`:lens?` params are actually
 * the legacy 2-segment URL shape (`/session/claude-code/<projectDirName>/<uuid>`,
 * no explicit lens) — under `CLAUDE_SESSION_ROUTE_PATH`'s pattern this SHORT
 * legacy shape still matches (`:id` capturing the stale project dir, `:lens`
 * capturing the real id), so `SessionShell` consults this to redirect it. A
 * `projectDirName` is never UUID-shaped, so "id isn't a UUID but lens is" is
 * unambiguous — never true for a current-shape URL. Longer legacy shapes fall
 * through to the catch-all instead — see `legacyClaudeSessionRedirectTarget`.
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
 * `CLAUDE_SESSION_ROUTE_PATH` can match — e.g. the legacy agent-drilldown shape
 * `/session/claude-code/<projectDirName>/<uuid>/agent/<agentId>[/<lens>]`.
 * These fall through every registered route to react-router's catch-all, where
 * this helper is consulted (see main.tsx). Returns the redirect target (new
 * path + preserved query string), or `undefined` when `pathname` doesn't match
 * the legacy shape.
 *
 * NOTE: this only strips the stale project segment; it does NOT remap legacy
 * lens names in the trailing `rest` (a project-scoped deep link to `…/timeline`
 * lands on `/session/claude-code/<uuid>/timeline`, which the SessionShell's own
 * `legacySessionLensRedirect` then normalizes to `…/story` on arrival). Kept as
 * two hops so each guard stays single-purpose and independently tested.
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
 * Build the path (+ `record` search param, and an optional `agent` search
 * param) that opens the record slide-over (L3) for a given source line — see
 * `RecordDetail.tsx`. The record is addressed with `?record=<line>` appended to
 * the session path so it's shareable/bookmarkable and Back-closable, while the
 * lens/sub segments stay untouched (the underlying lens never unmounts).
 *
 * `opts.agentId` adds a sibling `&agent=<agentId>` param so the SESSION page can
 * open a subagent's own record in-place (the Evidence Tools heavy-hitters rank
 * calls across every thread — see `HeavyHittersTable`). `opts.sub`/`opts.toolsSub`
 * thread through to `sessionPath` so a record opened from an Evidence sub-tab
 * keeps that sub in its URL (and thus in the record's close href).
 */
export function recordPath(
  ref: SessionRef,
  lens: Lens,
  line: number,
  opts: { agentId?: string; sub?: EvidenceSub; toolsSub?: ToolsSubTab } = {},
): string {
  const base = `${sessionPath(ref, lens, opts.sub, opts.toolsSub)}?record=${line}`;
  return opts.agentId !== undefined ? `${base}&agent=${encodeURIComponent(opts.agentId)}` : base;
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
 * Parses the `agent` search param that rides alongside `record` on the SESSION
 * page (see `recordPath`) — the subagent id whose transcript the open record
 * line belongs to. `undefined` when absent.
 */
export function parseRecordAgentParam(searchParams: URLSearchParams): string | undefined {
  const raw = searchParams.get("agent");
  return raw !== null && raw !== "" ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Agent (subagent detail, L3) routes
// ---------------------------------------------------------------------------

/**
 * react-router path patterns for the agent (subagent detail, L3) shell routes.
 * The static `agent` segment outranks the session routes' optional `:lens?`, so
 * `/session/<src>/id/agent/x` matches these rather than the session pattern. The
 * trailing `:lens?/:sub?` addresses the lens and (for Evidence) its sub-tab —
 * the agent shell has no Evidence/Tools split, so no third segment is needed.
 */
export const CLAUDE_AGENT_ROUTE_PATH = "session/claude-code/:id/agent/:agentId/:lens?/:sub?";
export const CODEX_AGENT_ROUTE_PATH = "session/codex/:id/agent/:agentId/:lens?/:sub?";

/**
 * Build the path for an agent (subagent detail, L3) route — mirrors
 * `sessionPath`, omitting the segment for the `story` default and the `context`
 * evidence default. `ref` is the PARENT session the agent is viewed under.
 */
export function agentPath(
  ref: SessionRef,
  agentId: string,
  lens: Lens = "story",
  sub?: EvidenceSub,
): string {
  const base = `/session/${ref.source}/${encodeURIComponent(ref.id)}/agent/${encodeURIComponent(agentId)}`;
  if (lens === "story") return base;
  if (lens === "orchestration") return `${base}/orchestration`;
  return (sub ?? "context") === "files" ? `${base}/evidence/files` : `${base}/evidence`;
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
  sub?: EvidenceSub,
): string {
  return `${agentPath(ref, agentId, lens, sub)}?record=${line}`;
}

// ---------------------------------------------------------------------------
// Session-list query params
// ---------------------------------------------------------------------------

/** Session-list source filter tab — mirrors the server's `SessionSourceFilter` minus omission (the web always passes one explicitly). */
export type SourceTab = "all" | "claude-code" | "codex";

const SOURCE_TABS: readonly SourceTab[] = ["all", "claude-code", "codex"];

function isSourceTab(value: string | null): value is SourceTab {
  return value !== null && (SOURCE_TABS as readonly string[]).includes(value);
}

/**
 * Normalizes the `?source=` query param on the session list to a valid
 * `SourceTab`, defaulting to "all" for anything missing or unrecognized.
 */
export function parseSourceTab(value: string | null): SourceTab {
  return isSourceTab(value) ? value : "all";
}

/**
 * Normalizes the `?page=` query param on the session list to a 1-based page
 * number, falling back to 1 for anything missing, non-numeric, or < 1.
 */
export function parseListPage(value: string | null): number {
  const page = value !== null && /^\d+$/.test(value) ? Number.parseInt(value, 10) : 0;
  return page >= 1 ? page : 1;
}

/** Sentinel `?repo=` value (and absence thereof) meaning "no repo filter" — see `parseRepoParam`. */
export const ALL_REPOS = "all";

/**
 * Normalizes the `?repo=` query param to a filter value. Valid values aren't a
 * fixed enum — they're whatever `repoFilterKey` produces for the loaded
 * sessions (normally a `repoRoot` path) — so this only normalizes "param
 * absent" to the `"all"` sentinel and passes anything else through verbatim.
 * Reused as-is by the Briefing home's own `?repo=` filter (Home.tsx).
 */
export function parseRepoParam(value: string | null): string {
  return value ?? ALL_REPOS;
}

const DAY_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalizes the session list's `?day=` query param — a single LOCAL calendar
 * day (`YYYY-MM-DD`) to filter the list to. `undefined` for anything missing or
 * malformed. (The old Trends-screen drill-down that generated these URLs is
 * gone as of PR3/PR4, but the `?day=` FILTER itself is still honored for any
 * bookmarked list URL — see SessionList.)
 */
export function parseDayParam(value: string | null): string | undefined {
  return value !== null && DAY_PARAM_RE.test(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Top-level navigation (Briefing / Sessions / Learnings) + Home masthead
// ---------------------------------------------------------------------------

/** react-router path for the moved session list — the old bare `/` (now the Briefing home) redirects legacy list URLs here (see `legacySessionListRedirectTarget`). */
export const SESSIONS_ROUTE_PATH = "sessions";

/** react-router path for the Learnings loop board. */
export const LEARNINGS_ROUTE_PATH = "learnings";

/** Legacy `/trends` path — kept only so main.tsx can register the redirect to the Briefing home that absorbed it. */
export const TRENDS_ROUTE_PATH = "trends";

/** The three top-level destinations shown in the left nav rail — key, label, and path (`briefing` is the bare `/` home). */
export type NavKey = "briefing" | "sessions" | "learnings";

export const NAV_ITEMS: readonly { key: NavKey; label: string; path: string }[] = [
  { key: "briefing", label: "Briefing", path: "/" },
  { key: "sessions", label: "Sessions", path: `/${SESSIONS_ROUTE_PATH}` },
  { key: "learnings", label: "Learnings", path: `/${LEARNINGS_ROUTE_PATH}` },
];

/**
 * The Briefing masthead's period toggle (Today = 1 / 7d / 30d) — the `days`
 * window passed straight to `GET /api/briefing`.
 */
export const BRIEFING_PERIOD_DAYS: readonly number[] = [1, 7, 30];

/** Default `days` for a first visit / stale-or-missing `?days=` on the Briefing home. */
export const DEFAULT_BRIEFING_PERIOD_DAYS = 7;

/**
 * Normalizes the Briefing home's `?days=` query param to a value from
 * `BRIEFING_PERIOD_DAYS`, defaulting anything missing or unrecognized to
 * `DEFAULT_BRIEFING_PERIOD_DAYS`.
 */
export function parseBriefingPeriodDays(value: string | null): number {
  const days = value !== null ? Number(value) : Number.NaN;
  return BRIEFING_PERIOD_DAYS.includes(days) ? days : DEFAULT_BRIEFING_PERIOD_DAYS;
}

/**
 * The session list moved from `/` to `/sessions` in PR3 (the bare `/` is now
 * the Briefing home). A bookmarked legacy list URL is recognized by carrying a
 * session-list-only query param — `source`, `page`, or `day` (the Briefing
 * home's own params are `repo`/`days`). Returns the `/sessions` path with the
 * full original query preserved, or `undefined` for a bare (or Briefing-only)
 * `/` visit that should render the home.
 */
export function legacySessionListRedirectTarget(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const isLegacyListUrl = params.has("source") || params.has("page") || params.has("day");
  if (!isLegacyListUrl) return undefined;
  const query = search.startsWith("?") ? search : `?${search}`;
  return `/${SESSIONS_ROUTE_PATH}${query}`;
}
