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
