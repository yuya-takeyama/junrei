# Junrei

**Agent Statistics Analyzer** — a local-first tool that parses coding-agent session
logs (Claude Code first) and turns them into quantitative, reproducible metrics:
token/cost accounting, context growth, compaction, tool success rates, subagent
trees, repetition detection, and more. Visualized in a web UI and exposed to
coding agents via MCP.

Junrei provides **logic-derived quantitative data only** — the evaluation and
improvement loop belongs to humans and to agents consuming the data over MCP.

See [docs/concept.md](docs/concept.md) (mission, signal model, information
architecture), [docs/design.md](docs/design.md) (technical design), and
[docs/roadmap.md](docs/roadmap.md).

## Development

Tooling is managed with [aqua](https://aquaproj.github.io/):

```sh
aqua i -l
pnpm install
pnpm dev        # starts the API server and Vite on incrementally selected free ports
```

`pnpm dev` starts from API port 7868 and Web port 5874, incrementing each until
it finds a free port. It prints the resolved Web, API, and MCP URLs before the
servers start, so agents can navigate to the exact Web URL without probing.

Use `pnpm start` for the normal fixed-port mode (hot reload remains enabled):

- Web UI: http://localhost:5873 (override with `JUNREI_WEB_PORT`)
- API server: http://localhost:7867 (override with `JUNREI_PORT`)

`JUNREI_SERVER_PORT` remains accepted as an API-port alias for existing Web
proxy configuration. Both commands configure the Web proxy to use the resolved
API port.

```sh
pnpm typecheck
pnpm lint
pnpm test
```

## MCP

The server exposes an MCP endpoint (Streamable HTTP) at `/mcp`. Register it in
Claude Code with:

```sh
claude mcp add --transport http junrei http://localhost:7867/mcp
```

Tools: `list_sessions`, `search_sessions`, `get_session_summary`,
`get_context_timeline`, `find_repetitions`, `get_subagent_tree`,
`get_task_executions`, `get_first_prompt`, `get_repo_overview`.

`search_sessions` finds which past session mentioned a plain substring —
matched against decoded prompt/assistant/tool text (never raw JSON), returning
compact per-session snippets with source line numbers plus filters
(source/project/repo/fields/since/until) so an agent can reach the right
session while spending minimal context.

## License

MIT
