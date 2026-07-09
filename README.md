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
pnpm dev        # starts the API server and the Vite dev server
```

- Web UI (dev): http://localhost:5873 (override with `JUNREI_WEB_PORT`)
- API server: http://localhost:7867 — `JUNREI_PORT` overrides; if the default
  port is taken, an OS-assigned free port is used and printed on startup.

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

Tools: `list_sessions`, `get_session_summary`, `get_context_timeline`,
`find_repetitions`, `get_subagent_tree`, `get_task_executions`, `get_first_prompt`,
`get_repo_overview`.

## License

MIT
