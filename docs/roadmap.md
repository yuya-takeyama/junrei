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
- ✅ Token accounting (dedupe by `message.id`, last occurrence wins — output
  is a growing streaming snapshot) + cost engine (LiteLLM pricing snapshot,
  tiered >200k, cache 5m/1h)
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
- ✅ Turborepo-based task running for `build`/`typecheck`/`test` with local
  caching (`turbo.json`, root scripts now `turbo run <task>`); `dev`/`start`
  stay on the pnpm launcher, out of turbo's scope (2026-07-18)

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
  — CLAUDE.md/MEMORY.md detection is legacy-format-only as of CC ~2.1.2xx;
  see "CLAUDE.md injection detection is legacy-only (2026-07-17)" below
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
  shell invocations. Attached shell terminators are stripped and Git revision
  ranges are excluded so neither becomes a false file path; relative paths
  resolve against the session's `session_meta`/`turn_context` cwd. Skill
  invocations are parsed from `[$plugin:skill](path-to-SKILL.md)` markdown markers in `user_message`
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

1. ✅ Claude turn spine — #94. Claude Code main-transcript Timeline groups
   entries into `TurnGroup`s (`turnGroups.ts`, attribution mirrors
   `computeTurnUsage`'s "greatest `turn.line <= entry.line`" rule); turns
   render as a dense `.trg` table (`TurnRow.tsx`) collapsed by default (new
   "turns" detail-dial stop, 4 stops total — `user-only`/`minimal`/`full`
   still expand every turn, same kind subsets as before); a row click toggles
   one turn against the dial's default; an outlier turn (>25% of summed
   per-turn cost AND ≥$0.10) gets an amber tint; compactions stay visible as
   a sibling row even when their turn is collapsed. Codex sessions and
   subagent (`?agent=`) views are unchanged — flat rendering, 3-stop dial.
2. ✅ Codex turn spine + Turns tab removal — #95. `buildCodexTurnGroups`
   (`turnGroups.ts`) attributes entries to `session.codex.turns` by timestamp
   (mirrors Phase 1's line rule with `startedAt` standing in for `line`, since
   Codex turns carry no source line): sort turns by `startedAt` (stable for
   turns missing one), advance the bucket pointer only when the next turn's
   `startedAt` is `<=` the entry's own timestamp, folding pre-first-turn and
   timestamp-less entries into whatever bucket is current rather than
   dropping them. Reuses `TurnRow`/`turnColumns.ts` unchanged — the Codex
   column set (Started/Dur/Input/C·Read/Output/Reasoning, matching mock panel
   2c) falls out of the same presence-driven `visibleTurnColumns` Phase 1
   built, no new grid. `Timeline.tsx`'s grouped-vs-flat gate and adapter
   choice are now presence-driven across both sources (`session.turnUsage` or
   `session.codex.turns` non-empty), not a `source ===` branch, and
   `SessionShell` passes `session` through for both. The standalone Turns
   lens is gone: `CodexTurns.tsx` deleted, `Lens` drops `"turns"`
   (`CODEX_LENSES` now equals `CLAUDE_LENSES`), `normalizeLens` redirects the
   literal string `"turns"` to `"timeline"` so old bookmarks don't 404. The
   Codex-only role/nickname/session-total-reasoning meta chips `CodexTurns`
   used to show had no other home and were dropped rather than ported
   (origin/CLI version were already duplicated in the session header).
3. ✅ Mini-map rewrite — #96. `TurnMiniMap.tsx` replaces the flat rail for
   grouped views only (flat/subagent views keep `MiniMap.tsx` unchanged): one
   band per turn sized by entry count with a min-height clamp
   (`layoutTurnBandHeights`, `turnMiniMapLayout.ts`), a tick per turn
   boundary, amber outlier fill, amber dashed compaction marks, a thin error
   edge, and an amber viewport box that tracks real DOM heights via
   ResizeObserver + a throttled scroll listener (correct across
   expand/collapse and chunk growth) and drags via pointer capture. Clicking
   a band scrolls the turn's header into view even when collapsed, fixing
   the Phase-1 gap.
4. ✅ Per-step (per-API-call) sub-rows inside an expanded turn — #97.
   `computeTurnUsage` (`@junrei/core`) now collects one `ClaudeTurnStep` per
   usage-bearing API message in the same per-turn walk (`steps.length ===
   apiMessageCount`); `buildClaudeTurnGroups` maps it onto `TurnGroup.steps`
   (line/timestamp dropped — the UI never needs them), Codex leaves it
   undefined. `StepsRow.tsx` renders at the top of an expanded turn's
   content whenever `steps` is present and non-empty: collapsed by default
   (toggle + first-two-steps inline preview + "… sN" overflow), expanded
   shows every step's full token breakdown, prefixed with its model dot only
   for turns that actually spanned more than one model. ⌥-click on a turn
   row now expands the turn and its steps together (mock 2i); a plain click
   is unchanged, and collapsing a turn resets its own steps back to
   collapsed.
5. ✅ Long-turn elision — #98. `elision.ts`'s `elideEntries` splits an
   expanded turn's chip/dial-filtered entries into first-2/last-2 anchors
   plus a collapsed middle once the list exceeds `ELISION_THRESHOLD` (16);
   `hiddenKindCounts` tallies the hidden middle into the same seven
   chip-shaped buckets the filter row uses. `Timeline.tsx` renders the
   summary row (`.elide`/`.eline`, mock panel 2d) between the anchors with
   real "show all"/"show 25 more" buttons; per-turn reveal progress resets
   on that turn's own collapse, and for every turn together on a dial or
   chip change (the filtered list it runs over just changed shape). Flat
   (Codex/subagent) views and `turnsUpToBudget`'s whole-turn chunking are
   untouched — elision is purely a render-level reshaping of one already-
   filtered, already-chunked turn's entries.
6. ✅ Interaction polish + meta restoration + a11y pass — #99. Shift-click on
   a turn row now applies ONE state (expand or collapse, taken from the
   shift-clicked row's own pre-click state) to the whole inclusive range
   since the last plain-/⌥-clicked row — `computeShiftClickRange`
   (`turnRangeSelect.ts`) is a pure, unit-tested helper; the anchor then
   moves to the shift-clicked row, and a shift-click with no prior anchor
   falls back to a plain click (mock 2i). `button.trow` gets `user-select:
   none` so the drag-select a shift-click naturally performs never leaves a
   text-selection artifact behind. The dial gained a "N overridden" badge
   (`.chip`, mono/muted/dotted-border) next to it whenever `turnOverrides` is
   non-empty; clicking it resets every turn to the dial's own default. Light
   a11y pass: the dial is a `role="radiogroup"` of `role="radio"` buttons
   (`aria-checked`), filter chips carry `aria-pressed`, the turn-aware
   minimap's drag-only viewport box is `aria-hidden` (bands were already real
   `<button>`s with `aria-label`s), and a shared `:focus-visible` amber
   outline now covers turn rows, the steps toggle, elide buttons, chips, and
   dial stops in both themes. Codex's `agentRole`/`agentNickname` — dropped
   with Phase 2's `CodexMetaChips` — are back, presence-driven, as `role X`/
   `as Y` segments in the session header's `MetaLine`; the session-total
   reasoning badge stays dropped (per-turn Reasoning is now a visible
   Timeline column).

All six phases shipped: #94, #95, #96, #97, #98, #99.

Follow-up: the turn Cost column silently undercounted — `buildClaudeTurnGroups`
summed only `assistant-text` entries' `costUsd`, but that field only exists on
API calls that emitted a text block, so tool-use-only calls (most agentic
steps) contributed $0 with no `costIncomplete` warning. Fixed: `ClaudeTurnStep`
(`@junrei/core`'s `metrics.ts`) now carries its own `costUsd` from the same
pricing helper, and the adapter sums ALL of a turn's steps instead. Second
half: a turn's Cost cell was still only its own main-loop spend, with no
column for cost it delegated to subagents. `buildClaudeTurnGroups` now takes
the session's subagent forest and joins each turn's `subagent-launch` entries
against a per-root subtree-cost map (`buildSubagentSubtreeCosts` — own usage
plus every nested descendant's, recursively; NOT the launch entry's own
`costUsd`, which prices the sidecar transcript alone and excludes nested
children), producing `TurnGroup.delegatedCostUsd`/`delegatedCostIncomplete`. A
new `deleg` column (`turnColumns.ts`, after Cost) renders it presence-driven,
so Σ(Cost) + Σ(Deleg) now reconciles against the session's total cost.

## Workflow-tool subagents (2026-07-15)

Shipped in #102. Claude Code's Workflow tool persists its spawned agents
under `<sessionDir>/subagents/workflows/<runId>/` with run state at
`<sessionDir>/workflows/<runId>.json` — a layout Junrei never scanned, so a
workflow-heavy session reported `subagentCount: 0` and dropped most of its
real cost (the motivating session showed $4.71 instead of $17.76; ~73% of
spend was invisible). `listSubagentRefs` now scans the workflow layout one
level deep (tagging refs with `workflowRunId`, skipping `journal.jsonl`), a
new `claude/workflows.ts` parses run-state files tolerantly, and the analysis
exposes session-level `workflowRuns` (name, status, phases, agentCount,
`toolUseId`/`launchLine` matched per runId via the Workflow call's own
tool_result text). Workflow agents join the subagent forest as flat root
nodes carrying `workflowRunId`/`workflowLabel`/`workflowPhase`/`queuedAt` —
run summaries deliberately carry no usage, so per-model totals and the
delegation split include them with no double counting. The web orchestration
tree groups them under a per-run header (client-side rollup) with phase
sub-headers; waterfall/flame pick up labels via `displayName`; `Workflow`
timeline entries get a lazy `name · N agents · $cost` rollup; the MCP
subagent tree passes `workflowRuns` through.

Follow-up shipped same day in #103: `computeUsage` deduped API messages by
`message.id` keeping the FIRST occurrence, but Claude Code streams the same
message across lines with growing `output_tokens` — dedup now keeps the last
occurrence, which is billing-correct (the motivating session's workflow
agents: $13.05 under first-occurrence vs $17.39 correct).

## Files & Skills file-tree rework (2026-07-16)

Shipped in #107. The Files & skills lens's file list was a flat list grouped
by directory-header rows — repo files interleaved with `~/` and `/` paths,
nothing collapsible, nothing filterable. `fileTree.ts` now classifies each
absolute path into Repository / Home / System scope sections (repo wins when
the cwd itself sits under the guessed home prefix) and builds a per-scope
compact directory tree (single-child chains fold into one `a/b/c/` row,
VSCode compact-folders style) with per-directory aggregated reads/edits
rendered muted on collapsible, default-expanded chevron rows. A new
`fuzzy.ts` implements a case-insensitive subsequence matcher: the
FileAccessTree header input filters files against their scope-relative paths
(ancestors force-expand while filtering, matched basename characters
highlight amber via `.fzy-hl`, and sections/aggregates/counts narrow to the
matched set), and SkillInvocationsPanel gets the same filter against skill
names.

Follow-up in #108: file rows now also pad by the 16px chevron column
(`TREE_CHEVRON_PX`) directory rows render before their label, so a
directory's children start visibly deeper than the directory's own label —
previously a file at depth N+1 (15px) landed at its parent's label x
(15·N + 16) and read as a sibling.

## Codex AGENTS.md injections in fileAccess (2026-07-17)

Codex's rollout persists its AGENTS.md context injection as a synthetic
`role:"user"` response_item starting with `# AGENTS.md instructions for
<cwd>` — previously recognized only to keep it out of the prompt count
(`isSyntheticUserText`), never surfaced as an injection. The core previously
skipped `injectedCount`/`injectedChars` for Codex entirely because the marker
names a directory, not a file (Codex merges root + nested AGENTS.md /
AGENTS.override.md into one message; individual paths never reach the log).
`computeCodexFileAccess` now emits an injected-only `FileAccessAgg` entry
keyed by the header's directory itself — the honest granularity, no
fabricated `<cwd>/AGENTS.md` path. When the body carries the
`--- project-doc ---` separator (present only when both a user-level
`~/.codex/AGENTS.md` and project docs exist), the halves' sizes split into
new optional `injectedUserDocChars`/`injectedProjectDocChars` fields
(`FileAccessAgg`/`FileAccessEntry`; summed through `mergeFileAccess`/
`foldFileAccess` and the Codex serve-time merge). The web file tree
previously rendered such a root-pointing entry as a file named "." —
injected-only root entries now display as "AGENTS.md instructions (merged)"
(fuzzy-findable by that label), and the `inj N` marker's tooltip appends the
user/project char split when known.

Follow-up: since the merged file paths are unknowable but the merged CONTENT
is fully persisted, the injected text itself is now viewable. A new
`injected-context` RecordDetail kind ("Injected context") — Codex's
`getCodexRecordDetail` previously returned `undefined` for every synthetic
user response_item; it now returns the full text (header included, char
count attached) for AGENTS.md merges and the other injected-context markers
(`<user_instructions>`/`<environment_context>`), while a response_item
duplicate of a real event-sourced prompt still dedups to `undefined`. The
Files lens links each injected-only Codex fileAccess row (whose
`firstTouchLine` is by construction an injection record) to the existing
record slide-over via the same `onOpenRecord` wiring Timeline uses, in both
the session and agent shells. Claude's isMeta injection records stay
unexposed — its record detail skips them, so no link is rendered for Claude
sessions.

## S3 as an additional Claude session source (2026-07-17)

🚧 A remote environment (Claude Agent SDK on AWS AgentCore Runtime) can upload
session transcripts to S3 mirroring the local `~/.claude/projects/` layout;
setting `JUNREI_S3_SOURCE_URI` (`s3://bucket/prefix/`) makes Junrei list and
read those sessions directly from the bucket as an additional source, merged
into the same session list — no local sync/mirror, and byte-for-byte
unchanged behavior when the env var is unset.

Introduced a minimal `ClaudeSessionStore` interface in `@junrei/core`
(`claude/store.ts`: `listSessionFiles`/`findSessionFileById`/`openLines`/
`readFile`/`listSidecarFiles`) and threaded it through `parser.ts`,
`subagents.ts`, `workflows.ts`, `analyze.ts`, and `timeline.ts` — every fs
touch in the Claude module now goes through a store, defaulting to a
`localClaudeSessionStore` that's a pure refactor of the old direct-`node:fs`
code (existing tests pass unmodified). `ClaudeSessionFileRef.filePath` is now
documented as a store-scoped URI (local absolute path, or `s3://bucket/key`)
and carries a new `changeToken` field (local: `String(mtimeMs)`, unchanged
behavior) generalizing the server's mtime-keyed parse caches to an opaque
string. A `joinPath` helper (`paths.ts`) replaces `node:path`'s `join` for any
store-scoped path, since `path.join` collapses the `://` in an S3 URI.

The S3 implementation itself (`@junrei/server`'s `sources/s3-store.ts`, the
only file importing `@aws-sdk/client-s3` — never `@junrei/core`, which
`@junrei/web` bundles via vite) does one paginated `ListObjectsV2` sweep
under `<prefix>projects/` per TTL window (`JUNREI_S3_LIST_TTL_MS`, default
10s) to answer every discovery query, derives session/sidecar structure from
key shape, uses `ETag` as the change token (falling back to
`LastModified`+`Size`), warns on a shrunk object size (possible remote
rollback) or an unparseable/path-traversal key, and reads file contents via
`GetObject`. `sources/claude.ts` builds one adapter bundle per store (local +
optional S3) with independent caches; single-session lookups
(`getSession`/`getTimeline`/etc.) try local first, then S3 — an accepted
"local wins" precedence when the same session id exists in both. `search.ts`
routes transcript scanning through the right store per file so S3 sessions
are searchable too.

Tests: server-side unit tests mock the S3 client at the `send` level
(pagination, key parsing, TTL caching with fake timers, ETag invalidation,
size-decrease/invalid-key warnings). One integration test spawns
[kumo](https://github.com/sivchari/kumo) (a single-binary S3-compatible
emulator, added to `aqua.yaml` via a local registry —
`aqua/kumo-registry.yaml` + `aqua-policy.yaml`, since it isn't in the standard
aqua registry), uploads the existing core fixtures, and exercises the store
end to end; it skips gracefully when `kumo` isn't on `PATH`.

## CLAUDE.md injection detection is legacy-only (2026-07-17)

Investigated why CLAUDE.md stopped appearing in the Files & skills lens. Not
a Junrei bug — the data no longer exists: current Claude Code (verified on
CC 2.1.202–2.1.209 transcripts) does not persist the `<system-reminder>`
context injections — including the "Contents of `<abs-path>` (`<label>`):"
headers carrying CLAUDE.md and the auto-memory MEMORY.md — into the
transcript JSONL. The first user message records only the command/prompt
content blocks. Verified across all local `~/.claude/projects/*/*.jsonl`
transcripts written since 2026-07-01: zero genuine headers and zero
`<system-reminder>` strings (the only hits were investigation sessions
quoting the regex/fixtures themselves). The `CONTENTS_OF_HEADER` matcher and
the `injectedCount`/`injectedChars` tally (#40) still work on older-format
transcripts and stay in place for legacy-log compatibility. SKILL.md
injection tracking is unaffected (it derives from `isMeta` injection
records, which are still written).

Options considered for restoring CLAUDE.md/MEMORY.md visibility on current
logs:

- (a) Disk-based inference: at analysis time, read the conventional paths
  (`<cwd>/CLAUDE.md`, `~/.claude/CLAUDE.md`, the project auto-memory
  `MEMORY.md`) and show them as "presumably injected" rows with char counts.
  Problem: today's disk state can differ from what the session actually saw
  (files edited since, sessions run under other configurations), so every
  such row would need an explicit "estimated from current disk state, not
  from the log" caveat in both UI and MCP output — and it breaks the
  quantitative-data principle that metrics are reproducible from session
  data alone.
- (b) Document the limitation and do nothing else (chosen for now): the
  lens stays strictly log-derived; injected CLAUDE.md/MEMORY.md rows simply
  don't exist for current-format sessions.

## Next milestone — Goshuin (proposal, 2026-07-18)

Evidence-grade agent analysis over Junrei MCP: give analyzing agents
verifiable, provenance-backed access to what actually happened in a session —
including what the session JSONL alone cannot show (system prompt, tool
schemas/action space, generation params, injected context, hidden API calls,
latency). Grounded in the
[session-log completeness study](./research/claude-code-session-log-completeness.md)
and new measured verification (API-payload reconstruction from log+disk:
85–100% byte-exact; per-CLI-version stability of system prompt/tools/params).
Full insight dump, candidate approaches (A–F), recommended phasing, and open
decisions: [milestones/goshuin.md](./milestones/goshuin.md).

- ✅ Insight/idea capture: evidence base, six candidate approaches
  (drill-down tools, blind-spot metadata, reconstruction "virtual wire",
  wire-capture ingestion, OTel ingestion, eval-trace export), open decisions
- ⬜ Decision stage: settle the open decisions (C-first vs D-first,
  epistemics of labeled non-log-derived values, template-library logistics,
  MCP surface philosophy)
- ⬜ Implementation: phased per the decisions

## Later (post-v1)

- 🚧 Cross-session aggregates & trends — repo-level overview shipped
  (#42, #43); cross-repo/global trends still open
- ⬜ Export/copy portable summaries (paste into ChatGPT, issues, docs)
- ⬜ Review Skill for agent-driven retrospectives
- ⬜ Desktop packaging (Tauri/Electron)
- ⬜ Live tail / watch mode
