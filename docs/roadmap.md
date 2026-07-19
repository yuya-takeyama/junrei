# Junrei — Roadmap

Status legend: ✅ done / 🚧 in progress / ⬜ planned

Completed work lives in [roadmap-archive.md](./roadmap-archive.md) — this
file tracks only what is in progress or ahead.

## In progress

### Cross-session aggregates & trends (2026-07-19)

Repo-level and multi-day cost/usage retrospectives across every session
(both harnesses), so a user or an agent can see beyond one session at a time.

- ✅ Repo-level overview: `computeRepoOverview`, `GET /api/overview`,
  `get_repo_overview` MCP tool (#42, #43)
- ✅ Core: `computeTrends` in `@junrei/core` (`shared/trends.ts`) — LOCAL
  calendar-day buckets over a `days`-day window ending today, a
  current-vs-previous-window summary with null-safe deltas, and simple
  spike-day detection (#138)
- ✅ Server: `GET /api/trends` — `days` whitelist (7/14/30, default 14) and
  IANA `tz` validation shared with the MCP tool below (`trends-params.ts`),
  optional `repo` scope (#138)
- ✅ Web: `/trends` screen — KPI deltas vs the prior window, daily
  cost-by-model + delegation-split charts, efficiency small multiples (incl.
  subagent return size vs. the 1–2k token benchmark), a cadence panel, and an
  anomalies panel (spike days, top sessions) (#139)
- ✅ MCP: `get_trends` tool exposes the same aggregation to agents, sharing
  `GET /api/trends`'s `days`/`tz` parsing (`trends-params.ts`) so the two
  surfaces can't drift

### S3 as an additional Claude session source (2026-07-17)

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

### Bash-command analysis (2026-07-18)

Per-command Bash analytics for Claude Code sessions: result-char/token-heavy
command ranking, top-10 heavy hitters, and quantitative waste detection
(near-duplicate reruns, oversized results, rerun-after-error, Bash calls
standing in for Read) — every entry attributed per thread (main vs.
subagent), estimated-token figures always marked as estimates
(`Math.ceil(chars / 4)`, not a real tokenizer).

- ✅ Core: `computeBashStats` in `@junrei/core` (`claude/bash-stats.ts`) — one
  joint pass over every thread's `Bash` tool calls, feeding
  `ClaudeSessionAnalysis.bashStats` (#128)
- ✅ MCP: `get_bash_stats` + `get_tool_calls` surface the same data to
  analyzing agents (#131)
- ✅ Fix: `hasOutputRedirect` narrowed to stdout-only, so a call redirecting
  only stderr (`2> file`) still counts as a `bashAsRead` candidate (#134)
- ✅ Web: "Bash" lens tab (Claude sessions only, `Lens` union in
  `router.ts`) — command ranking table, a context-consumption stat row +
  heavy hitters table, and the four waste subsections; quantitative only,
  no advice/hint prose
- ✅ Codex shell-call support (PR 4 of 4) — `computeBashStats` extracted
  into a harness-neutral engine (`@junrei/core`'s `shared/bash-stats.ts`);
  Claude's own adapter (`claude/bash-stats.ts`) unchanged in behavior. Codex
  adapter (`codex/bash-stats.ts` + `codex/tool-calls.ts`) extracts shell
  calls from three wire surfaces: `function_call` `shell`/`exec_command`
  (unwrapping a `bash`/`sh`/`zsh -lc`/`-c` wrapper argv, reassembling a plain
  argv with quoting), `local_shell_call` + `exec_command_end` (the only
  source of that surface's command text — it carries no real output, only a
  synthesized "exited with code N"), and the 0.144+ unified-exec
  `custom_tool_call` (embedded `tools.exec_command(...)` calls joined into
  one entry, reusing `files-skills.ts`'s existing extractor). `bashStats`
  moved onto `SessionAnalysisCore` (both harnesses); a Codex session's
  sub-agent forest is folded in with a joint recompute at serve time
  (`getCodexSession`, mirroring `fileAccess`'s override pattern — ranking
  fields can't be additively merged). MCP: `get_bash_stats`/`get_tool_calls`
  now serve both sources (`get_tool_calls` lists Codex's own wire tool names
  generically). Web: "Bash" tab added to `CODEX_LENSES` (now identical to
  `CLAUDE_LENSES`); the agent-detail (L3) placeholder applies to both
  sources' sub-agents. `exec_command_end.duration` is NOT mapped to
  `wallClockMs` (undocumented wire shape); Codex has no
  `run_in_background` concept, so a Codex session's `background` is always
  `[]`.
- ✅ v2 redesign — the v1 tab was rejected by the product owner as a data
  dump ("これを見てどんなインサイトが得られるんだよ"); a 4-lens design
  process ("Goshuin"-style decision doc) converged on money-attribution +
  actionable fixes over raw counts.
  - ✅ Web: sortable columns for the Bash tab's tables, via a reusable
    `tableSort.ts` primitive (#145)
  - ✅ Core: $-weighting (`estUsdForChars`, `BashStats.totals.estUsd`/
    `byThread[].estUsd`/`byCommand[].estUsd`) + `computeBashOpportunities`
    (`bash-opportunities.ts`) turning `waste`/`byThread` into ranked,
    templated fix suggestions (`BashOpportunity[]`, class/lever/fixText/
    estUsdSaved with a measured\|heuristic\|none savings basis) (#146)
  - ✅ Baselines: `bashSummary` on session-list items, `RepoOverview.bash`
    (repo-wide rollup + per-session `resultChars`/`estUsd` distribution),
    and `percentileRank` (`@junrei/core`) for ranking one session's figure
    against its repo's history (#147)
  - ✅ Web: the redesigned tab itself — a header strip (headline ~$ figure +
    a server-computed percentile chip, `bash-percentile.ts` on
    `packages/server`, gated on >=5 Bash-tracked sessions in the repo; a
    Codex session's chip carries a main-thread-only-basis caveat), a WHO
    PAID panel (chars-share vs. $-share bars per thread, subagent rows
    aggregated by model beyond the top 3), a Fix Queue (ranked
    `BashOpportunity` cards with a copy-ready `fixText` block and an
    expandable evidence list wired to the record slide-over), and the
    Cost by command table re-anchored on money (chars available behind a
    toggle). The four v1 waste subsections and the four stat tiles are
    gone — the Fix Queue and header strip replace them respectively; heavy
    hitters survives as a collapsed-by-default Evidence drill-down.
  - ✅ MCP mirror (part D) — `get_bash_stats` gains `byThread` (capped at
    50), a ranked `opportunities` list (new `topOpportunities` param,
    default 10/max 50, standard `{items,totalCount,truncated}` shape; each
    item carries the full `BashOpportunity` fields including a copy-ready
    `fixText`, with `title`/`fixText`/`heuristicNote` under the same
    explicit `capTextField` truncation contract every other MCP text field
    uses), and `totals.estUsd` (already flowed through unchanged — verified,
    no code change needed), so an orchestrator agent can self-diagnose a
    session's Bash spend in the same call. `bashPercentile` reuses the v2 PR
    C seam (`bash-percentile.ts`'s `resolveBashPercentile`, moved there from
    `app.ts` so both the HTTP detail routes and this MCP tool share it) —
    same >=5-Bash-tracked-sessions gate, same Codex main-thread-only basis
    (plus an explicit `note` field on a Codex response explaining the
    basis). Perf fix alongside it: `getRepoOverview` (`overview.ts`) now
    memoizes per `repoKey` with a 30s TTL — `resolveBashPercentile` was
    triggering a full `listSessions(500)` sweep on every session-detail
    request (HTTP or MCP); the per-file analysis one layer down was already
    mtime-cached, but the directory sweep + repo aggregation pass was not.
    Bash-analysis v2 is now complete (parts A-D).

### Tools lens (All + Bash) — cross-tool usage analytics

The top-level "Bash" lens becomes "Tools", with an "All" sub-tab (new
cross-tool, per-tool, $-weighted analysis) and the existing Bash lens re-homed
under a "Bash" sub-tab. Delivered as two sequential PRs (never stacked).

- ✅ Core + MCP (PR1) — `computeToolUsageStats` in `@junrei/core`
  (harness-neutral `shared/tool-usage-stats.ts`, sibling to `bash-stats.ts`),
  with Claude (`claude/tool-usage-stats.ts`, maps EVERY tool call) and Codex
  (`codex/tool-usage-stats.ts`, over the generic `tool-calls.ts` listing)
  adapters, feeding a new required `SessionAnalysisCore.toolUsageStats`. Ranks
  every tool by context-cost contribution (`byTool`, sorted by `estUsd`, each
  with a per-category error tally — `errorCategories`, reusing `ToolErrorCategory`
  promoted to `shared/tool-error.ts`), a per-thread money rollup (`byThread`,
  byte-identical to `bash-stats.ts` so the web "Who paid" panel is reusable),
  and cross-tool `heavyHitters`. Estimation/$-weighting reuse `bash-stats.ts`'s
  `estimateTokens`/`estUsdForChars` (no duplication); no `inputChars` (tool
  inputs are params, not context chars). A Codex sub-agent forest is folded in
  with a joint recompute at serve time (`getCodexSession`), mirroring
  `bashStats`. MCP: `get_tool_usage_stats` mirrors `get_bash_stats`'s
  registration (sessionRef, `includeSubagents` default true, `topTools`/
  `topHeavyHitters` caps with `{items,totalCount,truncated}` markers,
  main-only recompute when `includeSubagents: false`); the Bash tool appears
  as one aggregate row and `get_bash_stats` remains its per-command drill-down.
- ✅ Web (PR2) — the "Tools" lens replaces the standalone "Bash" lens in the
  `Lens` union / `CLAUDE_LENSES`/`CODEX_LENSES`, with a two-level sub-nav
  (`Tools.tsx`) dispatching to an "All" sub-tab (`tools/AllView.tsx`) and the
  existing Bash lens re-homed under a "Bash" sub-tab (mounted unchanged).
  Routing (`router.ts`): the session route gains a `:sub?` segment, `/tools`
  (default "all") + `/tools/bash` parse via `normalizeToolsSub`, and the legacy
  `/bash` URL redirects onto the Bash sub-tab (`LEGACY_LENS_ALIASES`);
  `sessionPath`/`recordPath` thread the optional sub. The All view derives the
  decision strip, cross-tool ranking (`ToolRankingTable`, inline $-share bars,
  Bash row drills into the Bash sub-tab), built-in-vs-MCP source split,
  errors-by-tool × category matrix, and cross-tool heavy hitters
  (`ToolHeavyHittersTable`) from `toolUsageStats` in plain view code
  (`tools/toolsLensFormat.ts`), reusing `WhoPaidPanel` unchanged. Approved
  deviation: the re-homed Bash "Cost by command" table adopts the same shared
  `.bcmd`/`.shcell` treatment (inline $-share bars) in place rather than being
  forked. All figures keep `~`/"(est)" labels; no scoring/judgment language.

## Open items

- ⬜ Docs refreshed; README quick start (v1 M4)
- ⬜ Transcript API (ordered event stream per session / per subagent)
- ⬜ New derived signals: concurrency profile, sibling overlap, instruction
  footprint (instruction sizes partially visible via injected-file tracking,
  #40)
- ⬜ Codex fork lineage (`forked_from_id`) — parsed, no fork-tree UI yet
- ⬜ Codex legacy-format rollout support (pre-2026-02-25 transcripts)
- ⬜ Trends: per-day subagent-return-size distribution (p90/max per call) —
  today's `subagentReturn` is mean/max only, which hides a call-level outlier
  a per-session mean can average away
- ⬜ Trends: cost→outcome hooks — connect an expensive day back to what it
  actually produced (top sessions / commits / PRs), not just how much it cost
- ⬜ Trends: unify/dedupe `get_repo_overview`'s per-day cost timeline with the
  `/trends` per-repo view — two separate per-day cost rollups exist today

## Later (post-v1)

- ⬜ Export/copy portable summaries (paste into ChatGPT, issues, docs)
- ⬜ Desktop packaging (Tauri/Electron)
- ⬜ Live tail / watch mode
