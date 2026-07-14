# Junrei — Roadmap

Status legend: ✅ done / 🚧 in progress / ⬜ planned

## v1 prototype (current)

### M0 — Foundation

- ✅ Research: Claude Code session log format, ccusage cost logic, agent
  observability metric landscape
- ✅ Scope interview & decisions (see [design.md](./design.md))
- ✅ Repo scaffold: pnpm monorepo (core/server/web), TypeScript strict, Biome,
  Vitest, aqua-managed tooling, CI (typecheck + lint + test + build) (#1)

### M1 — Core engine

- ✅ Session discovery (`~/.claude/projects`, `CLAUDE_CONFIG_DIR` support)
- ✅ Streaming JSONL parser with tolerant schema (unknown types → warnings)
- ✅ Token accounting (dedupe by `message.id`) + cost engine (LiteLLM pricing
  snapshot, tiered >200k, cache 5m/1h)
- ✅ Metrics: context growth, compaction, tool histogram/success, subagent tree
- ✅ Differentiators: repetition detection, error classification, exploration
  profile
- ✅ Unit tests against fixture logs; smoke-tested against real local sessions

### M2 — Server + Web UI

- ✅ Hono server: sessions API (list + detail, mtime-keyed cache), typed
  end-to-end via Hono RPC
- ✅ Session list: project, title, time, turns, tools/errors, agents,
  compactions, tokens, cost
- ✅ Session detail: stat tiles (cost incl. subagent share, cache hit rate),
  context growth chart with compaction markers, tool stats with error
  categories, repetition findings, exploration profile, subagent tree,
  cost by model, first prompt
- ✅ Browser-verified via Claude Code preview loop (real sessions, dark mode)

### M3 — MCP

- ✅ MCP endpoint (`/mcp`, Streamable HTTP via official SDK + @hono/mcp,
  stateless per-request transport) on the same server
- ✅ Tools: `list_sessions`, `get_session_summary`, `get_context_timeline`,
  `find_repetitions`, `get_subagent_tree`, `get_first_prompt`
  (tool stats are part of `get_session_summary`)
- ✅ Verified over Streamable HTTP (initialize / tools/list / tools/call
  against real sessions)

### M3.5 — Task executions (user request)

- ✅ Background task lifecycle: bash (`run_in_background`), async subagents,
  preview servers — joined with `<task-notification>` records (incl. queued
  variants) for duration and outcome; UI card + included in MCP summary
- ✅ Expanded to ALL task executions (foreground Bash/Agent too, matching the
  Background-tasks panel semantics); background-only UI filter;
  `get_task_executions` MCP tool; summary carries kind/status aggregates
- ✅ Fix: task notifications no longer counted as user turns
- ✅ Fix: tool results appearing before their tool_use (parallel batches) are
  now linked (found by independent verifier agent — Edit error undercount)

### M4 — Polish

- ✅ Independent verification by fresh-context agent against raw logs:
  20/21 checks passed; cost model reproduced to the exact digit (5m/1h cache
  rates, per-model). The 1 failure became the out-of-order linkage fix above.
- ⬜ Docs refreshed; README quick start

### Dev harness

- ✅ `cost-efficient-delegation` skill + CLAUDE.md model-cost policy: delegate
  execution to cheaper models (haiku/sonnet/opus) per task, keep the expensive
  orchestrator for planning/judging; grounded in official docs (model-config,
  advisor tool, managed-agents multi-agent) and measured with Junrei itself
- ✅ Isolated worktree development launcher: `pnpm dev` incrementally assigns
  free API/Web ports and prints browser-ready URLs; `junrei-browser-test`
  shares that contract between Codex in-app Browser checks and Claude Code's
  `preview-verifier`

## v2 — Concept & IA redesign

- ✅ Concept doc: mission, research-grounded signal catalog, layered
  information architecture (see [concept.md](./concept.md)); Claude Design
  prompt for screen design ([claude-design-prompt.md](./claude-design-prompt.md))
- ⬜ Transcript API (ordered event stream per session / per subagent)
- ✅ Skill-invocation extraction as first-class events
- ✅ File-access event list (per-file, timestamped, agent-attributed)
- ✅ Subagent drill-down routes (recursive session-shaped detail)
- ✅ New derived signals: subagent return sizes, per-turn token composition
- ✅ New derived signals: delegation share (#38)
- ⬜ New derived signals: concurrency profile, sibling overlap, instruction
  footprint (instruction sizes partially visible via injected-file tracking,
  #40)
- ✅ UI lenses: Timeline / Orchestration / Context & cost / Files & skills

## Value-delivery loop (dogfooding, 2026-07-10)

Dogfooded Junrei on its own repo: 16 sessions / $527 spent at the time, the
top 3 sessions accounting for 78% of spend, and main-thread orchestrator cost
dominant over subagent cost. Every finding required jq and hand-math to
extract — so the missing signals shipped as one same-day PR series instead.

- ✅ Zero-usage models (e.g. `<synthetic>` API-error stubs) no longer flip
  `costIsComplete=false` (#35)
- ✅ Worktree-aware repo identity — `deriveRepoIdentity(cwd)` →
  `repoRoot`/`worktreeName` on analyses + list items (#36)
- ✅ Repo-aware session-list filter (`?repo=`), worktree marker on rows (#37)
- ✅ First-class delegation share signal — core `computeDelegationSummary` →
  `analysis.delegation` (main vs. subagents tokens/cost + byModel, Codex
  serve-time), MCP `get_session_summary` serves it, Overview tile shows
  "$X delegated — N% of cost · M% of tokens", Orchestration header
  "main N% cost · M% tokens" (#38)
- ✅ Skill injected payload — `skillInvocations[].injectedChars`/
  `injectionLine` from `isMeta` injection records; panel shows "N chars
  loaded" (closes #27) (#39)
- ✅ Injected files in `fileAccess` — "Contents of `<path>`" system-reminder
  blocks (CLAUDE.md/MEMORY.md) + SKILL.md injections tracked as
  `injectedCount`/`injectedChars`; file tree shows "· inj N" markers (#40)
- ✅ Multi-model subagents surfaced in Orchestration (activeModels badges +
  per-model breakdown in detail panel) — makes SendMessage model-override
  cost leaks visible at tree level (#41)
- ✅ Repo overview aggregates — list items carry slim `usageByModel` +
  `delegation`; `computeRepoOverview` + `GET /api/overview?repo=`;
  session-list aggregate band (total cost, sessions, delegated share, top
  model, per-day UTC bars) (#42)
- ✅ `get_repo_overview` MCP tool (shares `getRepoOverview` with the HTTP
  route) + tool-description cost semantics (`cacheWriteCostUsd` included in
  `costUsd`; `costIsComplete=false` = lower bound) (#43)
- ✅ Session-list pagination + start-time sort — list order is now session
  `startedAt` desc (was file mtime); `GET /api/sessions` gains `offset` and
  returns `{ sessions, total }`; the Claude adapter analyzes only enough
  transcripts to fill the requested page (file-birthtime start proxy picks
  the candidates), so first paint stops parsing every session on disk; web
  list loads 50/page (was 200 in one shot) with a `?page=` pager — this PR
- ✅ Full-text expansion for truncated prompts — Timeline's truncated
  user/assistant-text/thinking blocks (700-char cap) get an inline "show
  full text" toggle, and the Overview/agent-detail first-prompt strip
  (500-char preview) fetches the untruncated text on first expand; both
  lazily fetch via the existing record API and cache the result — this PR
- ✅ Desktop session titles — Desktop-app sessions write no `ai-title`/
  `custom-title` records, so their rows fell back to the raw session UUID;
  the Claude adapter now joins the Desktop metadata store
  (`claude-code-sessions/**/local_*.json`, `cliSessionId` → `title`,
  mtime-cached) as a title fallback on list items, session detail, and MCP
  (`JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR` overrides the store location) — this
  PR
- ✅ Orchestration Tree view cost/status rework (2026-07-13): the old
  self/subtree "Cost s/t" pair is gone, replaced by a self-cost-only "Cost"
  column plus a new "%" column (each agent's share of the SESSION total, not
  its own subtree); new "Status" column (run/done/fail/—). Status comes from
  a new `SubagentNode.status` field, computed in `analyze.ts` from
  completion EVIDENCE only — a sync launch's parent-side `tool_result`, or an
  async launch's harness task-notification (same join `computeTaskExecutions`
  already used, now shared via the exported `backgroundStatus`) —
  deliberately never from `endedAt` (a still-running agent's sidecar keeps a
  current `endedAt`, so it can't signal completion). Both session-detail
  routes now also return `lastActivityAt` (max mtime across the main
  transcript + every subagent sidecar for Claude, the rollout + child rollout
  mtimes for Codex), computed fresh per request outside the mtime-keyed
  analysis cache, so the web can infer "still running" (`isSessionLive`,
  5-minute generous window) without a live socket. Codex nodes keep `status`
  honestly undefined — no parent-side completion evidence exists to read
- ✅ Server-side date bounds + default last-7-days view: `GET /api/sessions`
  gains optional `sinceMs`/`untilMs` (session START time, epoch ms) via a new
  `SessionListBounds` threaded through `listSessions` to both adapters. The
  Claude adapter prunes analysis by it — a ref whose file-timestamp proxy
  falls outside the window (±24h margin, then an exact post-filter on the
  real `startedAt` once analyzed) is skipped without ever being parsed — the
  mechanism that makes a narrow date filter cheap instead of just a smaller
  page over an unchanged full scan; the Codex adapter (which always analyzes
  its whole pool for sub-agent-forest reasons) applies it as a post-filter
  instead. `total` keeps its unbounded meaning either way. Web: the session
  list now always fetches the whole listable window in one request
  (`LIST_WINDOW_LIMIT`, was `FILTER_SCAN_LIMIT` and only used when a
  client-side filter was active — the separate server-paging mode is gone)
  with `sinceMs`/`untilMs` from the new `dateFilterFetchBounds` (rounded to a
  stable 5-minute mark so the fetch effect doesn't refetch on every render);
  a first-time viewer's date filter now defaults to "last 7 days"
  (`DEFAULT_DATE_FILTER`) instead of "all" — a stored `"all"` or any other
  prior choice is still respected exactly. `RepoOverviewBand` is renamed
  `OverviewBand` and renders for every list view now, not just when a repo is
  selected — with the new default it reads as "this week at a glance" — this
  PR

## Codex CLI sessions

- ✅ Core parsing: rollout JSONL discovery (`$CODEX_HOME`/`~/.codex`,
  `sessions/YYYY/MM/DD/` + `archived_sessions/`), tolerant parser
  (current/legacy/empty format detection), `analyzeCodexSession` producing
  `CodexSessionAnalysis` on the shared `SessionAnalysisCore` shape (#28)
- ✅ Server API + pricing: discriminated `AnySessionListItem` list
  (`source: "claude-code" | "codex"`, merged + sorted by recency, optional
  `source` filter), `GET /api/sessions/codex/:id` detail route, OpenAI
  `gpt-5*` family pricing (LiteLLM snapshot), MCP tools accept
  `project: "codex"` for session-scoped lookups (Claude-only tools reject
  Codex sessions with a clear error) — this PR
- ✅ Web UI: session-list source tabs (All / Claude Code / Codex, persisted
  in `?source=`), Codex detail screen reusing the Overview/Context & cost
  lenses (branched on `source` where Claude-only data — subagents, per-turn
  cache-write composition, API errors — doesn't exist) plus a Codex-only
  Turns lens (per-turn model/duration/tokens/reasoning, provenance chips),
  "est." cost markers wherever a Codex figure is API-list-price estimated
  rather than billed (#30)
- ✅ Timeline lens for Codex sessions: `buildCodexTimeline`/
  `getCodexRecordDetail` map Codex's `event_msg`/`response_item` records onto
  the existing Claude `TimelineEntry`/`RecordDetail` vocabulary (user,
  assistant-text, thinking, tool-call, compaction — no subagent-launch/
  task-notification/api-error, which Codex has no analog for), served by
  `GET /api/sessions/codex/:id/timeline` + `.../record/:line` (registered
  ahead of the generic `:project` routes, transcript cached by mtime like the
  Claude path), and reused as-is by the web's Timeline/RecordDetail
  components via the same generic `:project/:id` fetch path (#31)
- ✅ Sub-agent orchestration for Codex sessions: a Codex sub-agent is its own
  rollout file (not a sidecar like Claude), linked via
  `session_meta.source.subagent.thread_spawn` (`parent_thread_id`/`depth`/
  `agent_nickname`/`agent_role`, tolerating the parentless `review`/`compact`
  `SubAgentSource` variants and top-level-only schema versions) plus the
  parent's own `collab_agent_spawn_end` events. `codex/orchestration.ts`'s
  `buildCodexSubagentForest` assembles these into a Claude-compatible
  `SubagentNode` forest per session; `getCodexSession` attaches it
  (`subagents`/`subagentCount`) and recursively rolls up
  `totalUsage`/`totalUsageByModel` across the whole tree at serve time
  (Claude parity, cached per-file analyses never mutated). `listSessions`
  excludes sub-agent sessions from the list (they surface inside their
  parent's Orchestration lens, same as Claude sidecars, but stay directly
  fetchable via `/api/sessions/codex/:id` for deep links) and reports the
  real recursive `subagentCount` for parents. Web reuses the Orchestration
  lens, StatStrip's Subagents cell, and the session-list SUB column
  unchanged for both sources, branching only on: agent-drill-down links (→
  the sub-agent's own session page, not a Claude-style `agent/:agentId`
  route) and a "sub-agent of `<parent>`" chip on a Codex sub-agent's own
  session page. Also fixed in passing: `base_instructions` can be
  `{text: "..."}` on real Codex Desktop data, not a bare string — the old
  strict-string schema silently degraded the WHOLE `session_meta` line to a
  generic record, losing subagent linkage entirely
- ✅ Files & skills lens for Codex sessions — completes Claude-lens parity
  for Codex (every lens but the Codex-only Turns tab is now shared).
  `codex/files-skills.ts`: edits are DETERMINISTIC (`custom_tool_call`
  `apply_patch` envelopes, parsing every `*** Update/Add/Delete File:`
  header); reads are a conservative HEURISTIC over `exec_command`/`shell`
  calls (a short recognized-command list — cat/head/tail/less/more/rg/grep/
  awk/wc/stat/nl/sed, `sed` only counted with `-n` — never `-i`, never an
  unrecognized command), under-reporting rather than guessing at arbitrary
  shell invocations; relative paths resolve against the session's
  `session_meta`/`turn_context` cwd. Skill invocations are parsed from
  `[$plugin:skill](path-to-SKILL.md)` markdown markers in `user_message`
  event text. `fileAccess`/`skillInvocations` are now `SessionAnalysisCore`
  fields (promoted off the Claude-only `SessionAnalysis`), so the web's
  `FilesSkills`/`FileAccessTree`/`SkillInvocationsPanel` render unbranched
  for either source; `getCodexSession` folds every descendant sub-agent
  thread's own `fileAccess` into the parent's at serve time
  (`mergeCodexFileAccess`, reusing Claude's `mergeFileAccess`/
  `foldFileAccess`), producing the same main/subagent/both `threads` marker
  Claude's subagent merge does. Repetition findings and the per-tool/
  task-execution row stay Claude-only (no honest Codex equivalent) and are
  skipped for Codex, same pattern `ContextCost` uses for its own Claude-only
  panels — this PR
- ✅ Source-symmetric API/naming refactor: routes are now source-prefixed and
  parallel — `/api/sessions/claude-code/:project/:id` (+ `/timeline`,
  `/record/:line`, `/agents/:agentId`) vs. `/api/sessions/codex/:id` (+
  `/timeline`, `/record/:line`); old unprefixed routes are gone (clean break,
  no redirects). `source` query param omitted now means "all" (was a
  Claude-only pre-Codex back-compat shim); both detail routes return the same
  `{ analysis }` envelope. `sessions.ts` split into a thin registry/merge
  module plus `sources/claude.ts`/`sources/codex.ts` adapters
  (`claudeAdapter`/`codexAdapter`), dropping the `projectDirName: "codex"`
  sentinel. Core renames (clean break, no aliases): `SessionAnalysis` →
  `ClaudeSessionAnalysis`, `SessionFileRef` → `ClaudeSessionFileRef`,
  `parseTranscriptFile` → `parseClaudeTranscriptFile`. Web routes:
  `session/claude-code/:project/:id/:lens?` and `session/codex/:id/:lens?`;
  new `sourceCaps.ts` (`capsFor`) replaces some `session.source === "..."`
  checks. MCP `sessionRef` is now `{source: "claude-code" | "codex",
  sessionId, project?}` (was `{project, sessionId}` with a `project: "codex"`
  convention). Pure plumbing/naming refactor — no analysis/metrics/cost logic
  changed — this PR
- ✅ `packages/core/src` restructured into three peer trees, each with an
  explicit barrel (2026-07-13): `shared/` (agent-agnostic vocabulary —
  token/usage totals, timeline/record-detail entry shapes + text helpers,
  the subagent-forest node, pricing, repo identity, search-field flattening,
  the delegation split), `claude/` (everything Claude-Code-specific), and
  `codex/` (unchanged behavior, just relocated imports). This closes the
  import bridge Codex used to need into Claude-only files just to reach
  shared vocabulary (`SubagentNode`, `TokenUsage`/`ParseWarning`,
  `TimelineEntry`/`RecordDetail`, the `FileAccess`/`UsageSummary`/
  `SkillInvocation` merge helpers, `mergeUsageByModel`) — each now lives in
  `shared/` and both harnesses import it the same way. Eight public renames
  give every Claude symbol a name symmetric with its existing Codex
  counterpart: `analyzeSession`→`analyzeClaudeSession`,
  `listSessionFiles`→`listClaudeSessionFiles`,
  `resolveProjectsDirs`→`resolveClaudeProjectsDirs`,
  `buildTimeline`→`buildClaudeTimeline`,
  `getRecordDetail`→`getClaudeRecordDetail`, `Transcript`→`ClaudeTranscript`,
  `TurnUsage`→`ClaudeTurnUsage`, `SessionRecord`→`ClaudeSessionRecord`.
  `packages/server/src/sources/shared.ts` gained a generic `SourceAdapter`
  interface, applied to `claudeAdapter`/`codexAdapter` via `satisfies` so the
  peer-adapter contract is type-enforced, not just conventional. A new
  `core/test/architecture.test.ts` scans every import statement under `src/`
  and fails if `shared/` imports `claude/`/`codex/`, or `claude/`/`codex/`
  import each other. Moves + splits + renames only — zero behavior change,
  same routes/payloads/computations — this PR
- ✅ Claude Code session URLs/API routes are now bare-id, matching Codex's
  existing shape: `session/claude-code/:project/:id/:lens?` →
  `session/claude-code/:id/:lens?` (agent drilldown likewise drops
  `:project`), `GET /api/sessions/claude-code/:project/:id` (+ suffixes) →
  `GET /api/sessions/claude-code/:id`. Server resolves a bare id via
  `findClaudeSessionFileById` (`@junrei/core`'s discovery module): stats one
  `{sessionId}.jsonl` candidate per project dir rather than reading every
  project's full contents; session ids are UUIDv4 so a cross-project
  collision is practically impossible, but the newest-mtime file wins if one
  ever occurs. `ClaudeSessionKey` is now `{id}` alone (was `{project, id}`),
  matching `CodexSessionKey`; the MCP `sessionRef` shape dropped its
  `project` field the same way (session-scoped tools resolve by `sessionId`
  alone now — `search_sessions`' own `project` filter is unrelated and
  unchanged). Old bookmarked URLs still work: a 2-segment legacy URL
  (`.../<project>/<uuid>`, no lens) is redirected inside `SessionShell`
  (its `:id`/`:lens?` params land on the stale project dir/real id
  respectively — a `projectDirName` is never UUID-shaped, so this is
  unambiguous); a longer legacy URL (explicit lens, or the agent-drilldown
  route) falls through to react-router's catch-all, which strips the
  `:project` segment and redirects — this PR
- ✅ Nested agent drill-down for Codex sub-agents, matching Claude Code's URL/
  breadcrumb shape: new `session/codex/:id/agent/:agentId/:lens?` route
  (`CODEX_AGENT_ROUTE_PATH`), `agentPath`/`agentRecordPath` generalized to
  take a `SessionRef`, and `AgentShell` takes a `source` prop like
  `SessionShell`. A Codex agent page fetches the parent session (breadcrumb
  chain via `findAgentPath`, "% of session", tree-node launch metadata) plus
  the sub-agent's own session analysis (`fetchSessionDetail` on the agent id
  — a Codex sub-agent is a full session, so timeline/records/launch-prompt
  fetches are all keyed by its own session id, no `agent` param). Source
  asymmetries in the agent KPI strip mirror the session `StatStrip` (Turns
  cell instead of API msgs, `EstBadge` on cost, honest "return not in log"
  copy — Codex rollouts capture no parent-side return). Codex agent pages
  additionally get the real Orchestration lens (their own analysis carries a
  `subagents` forest, so nesting stays visible at any depth) and the
  Codex-only Turns lens. Orchestration's "open full detail →" now links both
  sources to the nested agent route instead of sending Codex to the
  sub-agent's own top-level session page (that page still works for deep
  links, unchanged). No server changes — `getCodexSession` already resolved
  any session id with its own descendant forest — this PR
- ✅ Per-source branching minimized in the web views by pushing the
  asymmetries into the entity interface: `toolCallCount`/`toolErrorCount`
  promoted to `SessionAnalysisCore` as REQUIRED fields (both harnesses
  genuinely have them — Claude computes them from its tool_use/tool_result
  pairs, Codex moved them up from `CodexSessionExtras`), and
  `apiMessageCount`/`apiErrorCount` declared on the core as OPTIONAL
  (Claude-only concepts; absence MEANS "no such concept", never zero — see
  the field doc). Views now render presence-driven instead of
  source-branched: `StatStrip` and `AgentShell`'s KPI strip pick the
  Turns/msgs-vs-Turns and API-err-vs-tool-err cells off field presence,
  Orchestration's main-row tool tally reads the core field directly, the
  subagent-return wording hangs off a new `capturesSubagentReturn` cap
  (sourceCaps), and the lens lineup is a `LENSES_BY_SOURCE` lookup. The
  `source === ...` checks that remain are the ones that SHOULD exist:
  transport dispatch (api.ts routes per source), the caps table itself, and
  type-narrows that grant access to source-exclusive payloads
  (`session.codex.*` provenance chips, Claude-only panels, CodexTurns) —
  this PR
- ⬜ Fork lineage (`forked_from_id`): parsed and retained on
  `CodexSessionExtras.forkedFromId`, but not yet surfaced in any lens — no
  fork-tree UI exists, unlike the sub-agent forest above
- ⬜ Legacy-format rollout support: pre-2026-02-25 Codex transcripts parse as
  `format: "legacy"` (no records) and are skipped everywhere (list, detail,
  every lens) rather than interpreted — no legacy-schema parser exists yet
- ✅ Thinking content retained and rendered in Timeline/RecordDetail (was
  char-count-only): Claude's `thinking` blocks keep their raw text
  (`ContentBlockThinking.text`); Codex's `reasoning` items keep the
  human-readable `summary[].text` (`summaryText`, joined) — `encrypted_content`
  is never read either way. Timeline shows a truncated preview (700 chars,
  same as assistant text), RecordDetail shows the full text
- ✅ Model families as master data (`web/src/modelClass.ts`): one ordered table
  maps raw model ids → versioned codename label + color accent, replacing the
  Claude-only substring checks. Labels keep the version ("fable 5",
  "sonnet 4.5", "5.6 sol"); GPT-5.6 codenames get their own colors (sol gold,
  terra olive, luna silver), `codex-auto-review` is a distinct cyan
  "auto-review", other GPT/Codex ids render rose with date/`-latest` suffixes
  stripped (fixes the truncated "gpt-5.…" labels); tokens live in
  `styles/tokens.css` (dark + light), every short label carries the raw id as
  a tooltip, and mix bars/badges/tables across all lenses derive from the
  same table — this PR
- ✅ Codex-only "est." cost badge removed (`EstBadge`, `costIsEstimated` cap):
  its premise — Claude Code costs are billed amounts, Codex costs are
  estimates — was false. BOTH sources compute cost the same way, token usage
  from the log × the shared `prices.json` list-price snapshot
  (`estimateCostComponents` in `claude/metrics.ts` and `codex/analyze.ts`);
  no billed amount is ever read from either log. Every dollar figure is an
  estimate, so the per-row/per-cell marker conveyed a false asymmetry
  ("no badge = actual"). The list column header already reads "Cost est";
  the `*` incomplete-cost marker (unpriced model in the mix) stays, and
  `RepoOverviewBand`'s incomplete-cost subline now says "incomplete" instead
  of the misleading "est." — this PR
- ✅ Codex central-worktree repo identity: Codex Desktop runs each task in
  `$CODEX_HOME/worktrees/<hash>/<repoName>` — a cwd with no trace of the
  parent repo's path — so every worktree became its own "repo" (~370
  hash-prefixed dropdown entries on real data). `deriveRepoIdentity` now
  recognizes the layout (worktreeName = `<hash>`, no repoRoot claimed);
  `codex/analyze.ts` records a normalized `gitRepositoryUrl` from
  `session_meta.git.repository_url`; the server resolves worktree sessions
  to a real `repoRoot` via a URL→path map anchored by sessions run at the
  repo's actual checkout (most-used root wins — a one-off `/private/tmp`
  review clone must not hijack the mapping), applied identically to list
  items and session detail. Unanchored URLs group per-repo as a new
  `codex-repo:<url>` fallback bucket (label = URL basename) in
  `repoKeyOf`/`repoFilterKey`; URL buckets join basename disambiguation so
  a same-named path repo stays distinguishable — this PR

## Transcript search (MCP)

- ✅ `search_sessions` MCP tool: plain-substring search across both harnesses'
  transcripts to find WHICH past session mentioned something while spending
  minimal context. Matches run against DECODED string values (user prompts,
  assistant text, tool inputs/results, titles; thinking is opt-in), never
  against raw JSON — log-side escaping can't split a match and queries need
  no escaping. Compact output: matched sessions newest-first, each carrying
  the session-ref fields the session-scoped tools take, per-record snippets
  with source line numbers, an exact `matchCount`, and explicit truncation
  flags (`matchesTruncated`/`resultsTruncated`). Filters:
  source/project/repo (same key semantics as `get_repo_overview`)/sessionId/
  fields/caseSensitive/since/until; opt-in `includeSubagents` also searches
  Claude sidecar transcripts and Codex sub-agent threads, attributing matches
  to the parent session with `agentId`. Scanning streams each candidate JSONL
  with a raw-line fast path for escape-free queries; extraction reads RAW
  records (`@junrei/core` `search.ts`), so tool results past the normalizer's
  2000-char cap and Codex `function_call` arguments (JSON-decoded) still
  match; Codex prompts mirrored as both `event_msg` and `response_item` count
  once (same dedup rule as the timeline) — this PR

## Web routing

- ✅ Web app switched from hash-based routing (`createHashRouter`, `#/session/...`
  URLs) to history/browser routing (`createBrowserRouter`): URLs are now plain
  paths, e.g. `/session/claude-code/<id>/timeline`. `main.tsx` rewrites a
  pre-migration `#/session/...[?record=N]` bookmark into a real path (+ search
  string) via `history.replaceState` before the router reads the location, so
  old hash bookmarks still resolve through the normal route table (and, for
  project-scoped legacy shapes, the existing catch-all redirect). The server
  (`packages/server/src/app.ts`) gained matching production support: `createApp`
  now optionally serves the built web SPA (`@junrei/web`'s `vite build` output,
  `webDistDir`, overridable for tests) — real static assets are served by
  `@hono/node-server`'s `serveStatic` with correct content types, and a
  trailing `app.get("*", ...)` falls back to `index.html` for any unmatched
  non-`/api` path so a deep-link reload resolves client-side, while an
  unmatched `/api/*` path still gets a JSON 404 rather than the SPA shell.
  Only activates when a build is present (dev's Vite server handles SPA
  fallback itself, `appType` defaults to `"spa"`, no config change needed) —
  this PR

## Unified Timeline (Turns × Timeline)

Dogfooding kept surfacing the same friction: the Timeline lens (per-event
transcript) and the Turns lens (per-turn table, Codex-only) show the same
session at two different altitudes with no bridge between them. The fix is a
single lens — the Timeline groups its existing event blocks by user turn, so
a turn header row reads as a dense table (Codex-parity) and expands to reveal
the events underneath, in place. Six phases, static mock in
`design/turns-timeline.dc.html`:

1. ✅ Claude turn spine — this PR. Claude Code main-transcript Timeline groups
   entries into `TurnGroup`s (`turnGroups.ts`, attribution mirrors
   `computeTurnUsage`'s "greatest `turn.line <= entry.line`" rule); turns
   render as a dense `.trg` table (`TurnRow.tsx`) collapsed by default (new
   "turns" detail-dial stop, 4 stops total — `user-only`/`minimal`/`full`
   still expand every turn, same kind subsets as before); a row click toggles
   one turn against the dial's default; an outlier turn (>25% of summed
   per-turn cost AND ≥$0.10) gets an amber tint; compactions stay visible as
   a sibling row even when their turn is collapsed. Codex sessions and
   subagent (`?agent=`) views are unchanged — flat rendering, 3-stop dial.
2. ⬜ Codex turn spine + Turns tab removal (Codex reasoning column, no
   step layer since Codex turns are flat) — the standalone Turns lens folds
   into Timeline for both sources.
3. ⬜ Mini-map rewrite: one tick per turn boundary, amber dashes for
   compactions, tick spacing ∝ event count, click-to-scroll viewport box.
4. ⬜ Per-step (per-API-call) sub-rows inside an expanded turn — collapsed by
   default.
5. ⬜ Long-turn elision — first/last 2 events always render, middle events
   collapse behind a count + "show all"/"show N more" affordance.
6. ⬜ Interaction polish (hover attribution for mixed-model clusters, capped
   dot cluster + "+n" overflow, incomplete-cost tooltips).

## Later (post-v1)

- 🚧 Cross-session aggregates & trends — repo-level overview shipped
  (#42, #43); cross-repo/global trends still open
- ⬜ Export/copy portable summaries (paste into ChatGPT, issues, docs)
- ⬜ Review Skill for agent-driven retrospectives
- ⬜ Desktop packaging (Tauri/Electron)
- ⬜ Live tail / watch mode
