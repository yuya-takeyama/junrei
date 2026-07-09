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

## v2 — Concept & IA redesign

- ✅ Concept doc: mission, research-grounded signal catalog, layered
  information architecture (see [concept.md](./concept.md)); Claude Design
  prompt for screen design ([claude-design-prompt.md](./claude-design-prompt.md))
- ⬜ Transcript API (ordered event stream per session / per subagent)
- ✅ Skill-invocation extraction as first-class events
- ✅ File-access event list (per-file, timestamped, agent-attributed)
- ✅ Subagent drill-down routes (recursive session-shaped detail)
- ✅ New derived signals: subagent return sizes, per-turn token composition
- ⬜ New derived signals: delegation share, concurrency profile, sibling
  overlap, instruction footprint
- ✅ UI lenses: Timeline / Orchestration / Context & cost / Files & skills

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
  components via the same generic `:project/:id` fetch path — this PR

## Later (post-v1)

- ⬜ Cross-session aggregates & trends
- ⬜ Export/copy portable summaries (paste into ChatGPT, issues, docs)
- ⬜ Review Skill for agent-driven retrospectives
- ⬜ Desktop packaging (Tauri/Electron)
- ⬜ Live tail / watch mode
