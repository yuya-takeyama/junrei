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

- ⬜ Hono server: sessions API, dynamic port (`JUNREI_PORT` → default → ephemeral)
- ⬜ Session list: project, title, time, turns, models, cost
- ⬜ Session detail: context growth chart, compactions, tool stats,
  subagent tree, repetition/error findings, exploration profile
- ⬜ Browser-verified via Claude Code preview loop

### M3 — MCP

- ⬜ MCP endpoint (Streamable HTTP, official SDK) on the same server
- ⬜ Tools: `list_sessions`, `get_session_summary`, `get_context_timeline`,
  `get_tool_stats`, `find_repetitions`, `get_subagent_tree`
- ⬜ Verified from Claude Code as an MCP client

### M4 — Polish

- ⬜ End-to-end verification against real sessions (incl. this project's own)
- ⬜ Docs refreshed; README quick start

## Later (post-v1)

- ⬜ Codex session support (adapter layer in core)
- ⬜ Cross-session aggregates & trends
- ⬜ Export/copy portable summaries (paste into ChatGPT, issues, docs)
- ⬜ Review Skill for agent-driven retrospectives
- ⬜ Desktop packaging (Tauri/Electron)
- ⬜ Live tail / watch mode
