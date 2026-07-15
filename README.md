# Junrei

**Zero-config agent statistics analyzer for Claude Code and Codex** — a
local-first tool that turns your existing session logs into quantitative,
reproducible metrics.

Junrei (巡礼, "pilgrimage") walks a session's route again after the fact and
shows where the tokens, dollars, and time actually went. It parses session
logs from Claude Code and Codex CLI and computes **logic-derived quantitative
data only** — token/cost accounting, context growth, tool success rates,
subagent orchestration, repetition detection, and more. There is no LLM
judgment or scoring anywhere in the pipeline; interpreting the numbers is left
to humans, or to agents consuming them over MCP.

![Orchestration lens for a live Junrei session, showing the delegation tree from a main agent to six subagents with per-agent model, cost, and duration](docs/images/session-orchestration.png)

*A real Junrei session, viewed in Junrei — the orchestration lens breaking
down cost and delegation across a main agent and its subagents.*

## Features

- **Two sources, one model** — Claude Code and Codex CLI sessions (including
  subagents) are normalized into the same shape and shown side by side.
- **Cost & token accounting** — per-model usage and estimated USD cost, with a
  main-thread-vs-subagents delegation split.
- **Context timeline** — effective context size per API message, plus
  compaction events.
- **Orchestration tree** — subagent/sub-agent nesting, per-node cost, and
  tool call/error counts.
- **Repetition detection** — consecutive identical tool calls, repeated
  file reads, repeated failing calls (Claude Code sessions).
- **Files & skills** — file access tree, skill invocations, tool stats, and
  task executions.
- **Web UI** — a session list with search/filters and a per-session detail
  view with multiple lenses.
- **MCP server** — the same data exposed as tools so a coding agent can query
  its own (or another session's) history directly.

## Quick start

Requirements are pinned in `aqua.yaml` (Node.js, `pnpm`, `gh`) and managed via
[aqua](https://aquaproj.github.io/):

```sh
aqua i -l
pnpm install
```

Start the app with fixed ports:

```sh
pnpm start
```

- Web UI: http://localhost:5873 (override with `JUNREI_WEB_PORT`)
- API server: http://localhost:7867 (override with `JUNREI_PORT`;
  `JUNREI_SERVER_PORT` is accepted as an alias)
- MCP endpoint: http://localhost:7867/mcp

For local development, `pnpm dev` instead searches upward from port 7868
(API) and 5874 (Web) for the first free ports, and prints the resolved Web,
API, and MCP URLs at startup. Both commands run the API server and web UI
with hot reload enabled.

## Web UI

**Session list** — every session from either source in one table, with tabs
to filter by source (all / Claude Code / Codex), a title search box, a repo
filter, and a date filter (last 7/14/30 days, or all time; last 7 days by
default). An always-on overview band above the table summarizes total cost,
session count, delegated share, and top model for whatever the current
filters leave visible. Results are paginated.

**Session detail** opens into a set of lenses:

- **Overview** — top-line usage, cost, and delegation numbers for the session.
- **Timeline** — the record-by-record transcript with filters and a turn-aware
  mini-map; the main session view groups events into a per-turn table (model,
  duration, tokens, per-step breakdown) that expands in place, eliding a long
  turn's middle behind a "show more" summary.
- **Orchestration** — the subagent tree, as a tree, waterfall, or flame view.
- **Context & cost** — context growth over time, compactions, and per-model
  cost breakdown.
- **Files & skills** — file access, skill invocations, tool stats, repetition
  findings, and task executions.

Subagents are drillable: opening one reuses the same lens set, scoped to that
subagent's own transcript.

![Overview lens showing total cost, turns, cache hit rate, output tokens, and a context-growth chart for a session](docs/images/session-overview.png)

*Overview lens — top-line cost, cache hit rate, and context growth at a
glance.*

![Context and cost lens showing a context-growth chart, cache hit/write stats, and per-turn token composition](docs/images/session-context.png)

*Context & cost lens — context growth over time plus cache economics and
per-turn token composition.*

## MCP server

Register Junrei's MCP endpoint in Claude Code with:

```sh
claude mcp add --transport http junrei http://localhost:7867/mcp
```

| Tool | Purpose | Source support |
| --- | --- | --- |
| `list_sessions` | List recent sessions with a quantitative overview (turns, tool calls, tokens, cost, delegation). | Claude Code + Codex |
| `search_sessions` | Substring search across session transcripts, returning snippets and source line numbers. | Claude Code + Codex |
| `get_session_summary` | Full per-session summary: usage/cost per model, delegation split, tool stats, counts. | Claude Code + Codex |
| `get_context_timeline` | Effective context size per API message, plus compaction events. | Claude Code + Codex |
| `find_repetitions` | Repeated tool calls, re-reads, and repeated failures. | Claude Code only |
| `get_subagent_tree` | Subagent/sub-agent execution tree with per-node usage and cost. | Claude Code + Codex |
| `get_task_executions` | Every Bash command and Agent run, with duration and outcome. | Claude Code only |
| `get_first_prompt` | The first user prompt of a session. | Claude Code + Codex |
| `get_repo_overview` | Repo-level rollup across every session in a repo: cost timeline, per-model breakdown, top sessions. | Claude Code + Codex |

## How it works

There is nothing to configure: Junrei discovers each agent's local session
logs and reads them in place — nothing is sent anywhere:

- **Claude Code**: `~/.claude/projects/**/*.jsonl` (or `CLAUDE_CONFIG_DIR`),
  plus subagent sidecar transcripts and a join against the Desktop app's
  local session-title store.
- **Codex CLI**: `$CODEX_HOME/sessions/**/*.jsonl` and
  `$CODEX_HOME/archived_sessions/`, with sub-agents resolved as their own
  linked session files.

Architecture (pnpm workspace):

- `packages/core` — parsers and metric computation for both sources, plus the
  bundled cost model.
- `packages/server` — a Hono REST API and the Streamable HTTP MCP endpoint
  (`/mcp`); serves the built web UI in production.
- `packages/web` — the Vite + React single-page app.

Costs are **estimates**: list-price rates from a bundled snapshot of
LiteLLM's `model_prices_and_context_window.json`, multiplied by observed
token counts (including tiered >200k and 5m/1h cache pricing where
applicable). They are not your actual bill.

## Development

```sh
aqua i -l
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Linting/formatting is via Biome; tests run each package's vitest suite plus a
launcher `node --test` suite and skill validation. CI runs the same gates.

See [docs/design.md](docs/design.md) (v1 technical design),
[docs/concept.md](docs/concept.md) (v2 concept & signal model), and
[docs/roadmap.md](docs/roadmap.md) (feature history/status) for more.

## License

MIT
