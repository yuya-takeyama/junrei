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
- **Evaluation trace export** — merge the session log with OTel/wire-capture
  (when enabled) into one normalized, provenance-carrying event trace for
  external eval pipelines or LLM-judges (`export_evaluation_trace` /
  `GET .../evaluation-trace`), plus a bundled skill encoding an evidence-grade
  session-analysis methodology.

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

**Trends** (`/trends`) — a multi-day cost/usage retrospective across every
session, globally or scoped to one repo: a 7/14/30-day window with KPI deltas
against the prior window, daily cost-by-model and delegation-split charts,
efficiency small multiples (incl. subagent return size vs. the ~1-2k token
benchmark), a cadence panel, and an anomalies panel (spike days, top
sessions).

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

Table order matches registration order in `packages/server/src/mcp.ts`.

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
| `get_trends` | Multi-day trend report (7/14/30 days, global or per-repo): daily cost/token/delegation buckets, a current-vs-previous-window summary with deltas, spike-day detection, and top sessions. | Claude Code + Codex |
| `get_records` | Full record text (bulk, by 1-based JSONL line number) for a session — the same detail the record-detail view shows, with full tool-result text recovery past the log's own capture cap. | Claude Code + Codex |
| `get_tool_call` | One tool call and its result as a single evidence unit, resolved by `toolUseId`, with any records the parser already links to it (e.g. background-task notifications). | Claude Code + Codex |
| `get_reconstructed_request` | Reconstructs the actual Anthropic `/v1/messages` request payload (system prompt, tool schemas, generation params) for one main-loop turn, with an explicit confidence class (`exact`/`template`/`disk-contingent`/`unknown`) per block. | Claude Code only |
| `get_session_observability` | Claude Code's own OTel export for a session, parsed: authoritative cost, api-request latency, tool-decision/health events. Opt-in — see [OTel ingestion](#otel-ingestion-opt-in). | Claude Code only |
| `get_bash_stats` | Bash-command analytics: rankings by command family, program frequency, heavy hitters, background task outcomes, and waste signals (near-duplicates, reruns after error, oversized results). | Claude Code + Codex |
| `get_tool_calls` | Paginated, filterable listing of tool calls in a session, for discovering a `toolUseId` to drill into. | Claude Code + Codex |
| `get_actual_request` | The actual captured wire request/response for a `requestId` (opt-in wire capture): request body, response meta, measured latency, `isSubagent`. | Claude Code only |
| `get_hidden_calls` | Captured API calls whose `requestId` never appears in the session log — the structural cost-undercount evidence (opt-in wire capture). | Claude Code only |
| `export_evaluation_trace` | Exports a session as one normalized, provenance-carrying evaluation trace (`gen_ai.*`/`junrei.*` events; OTel/wire-capture enrichment when opted in) for external eval pipelines or LLM-judges. `GET /api/sessions/claude-code/:id/evaluation-trace` returns the same trace uncapped. | Claude Code only |

## How it works

By default there is nothing to configure: Junrei discovers each agent's local
session logs and reads them in place — nothing is sent anywhere:

- **Claude Code**: `~/.claude/projects/**/*.jsonl` (or `CLAUDE_CONFIG_DIR`),
  plus subagent sidecar transcripts and a join against the Desktop app's
  local session-title store.
- **Codex CLI**: `$CODEX_HOME/sessions/**/*.jsonl` and
  `$CODEX_HOME/archived_sessions/`, with sub-agents resolved as their own
  linked session files.

Optionally, Claude Code sessions can also be read directly from an S3 bucket
— e.g. a remote environment (Claude Agent SDK on AWS AgentCore Runtime)
uploading transcripts that mirror the local `~/.claude/projects/` layout.
This is opt-in and off by default:

- `JUNREI_S3_SOURCE_URI` — an `s3://bucket/` or `s3://bucket/prefix/` URI.
  When set, Junrei lists and reads Claude Code sessions from that bucket
  in addition to local sessions, merged into the same session list (no
  local sync/mirror). Unset, behavior is unchanged.
- `JUNREI_S3_ENDPOINT` — optional custom S3 endpoint (e.g. for MinIO,
  LocalStack, or kumo); also enables path-style addressing. Region and
  credentials are resolved via the AWS SDK's default chain.
- `JUNREI_S3_LIST_TTL_MS` — how long the S3 object listing is cached before
  a fresh `ListObjectsV2` sweep, in milliseconds (default `10000`).

### OTel ingestion (opt-in)

Junrei can also ingest Claude Code's own OpenTelemetry export — an
authoritative side channel Claude Code sends for observability, separate
from (and carrying different information than) the session JSONL. This is
opt-in and off by default; with it unset, Junrei's behavior is completely
unchanged:

- `JUNREI_OTEL_DIR` — an absolute directory path. When set, the junrei
  server accepts OTLP/HTTP JSON POSTs at `/otlp/v1/logs` and
  `/otlp/v1/metrics` and stores them as one JSONL file per Claude Code
  `session.id` under this directory (`_unassigned.jsonl` for any record
  whose session id couldn't be resolved). Unset, those routes don't exist —
  a request to them 404s exactly like any other unknown route.

On the Claude Code side, point its OTel exporters at the junrei server:

```sh
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:7867/otlp
```

Once both sides are configured, the `get_session_observability` MCP tool
returns authoritative billing-computed cost (`costBasis: "otel"`) alongside
the usual pricing-table estimate (`costBasis: "pricing-table-estimate"`) and
their delta, per-`api_request` latency stats, `tool_decision`
(permission accept/reject) events, and MCP/hook health events — none of
which the session JSONL carries. OTel carries no prompt or tool content at
all (no user/assistant text, no tool arguments/results, no system prompt or
schemas) — it's a pure ops/billing channel, never a content source.
Retention of `JUNREI_OTEL_DIR`'s contents is user-managed; Junrei never
deletes what it wrote there.

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

## Wire capture (opt-in, local-only)

The session log is a lossy record: it never captures per-request latency, and
some background API calls (e.g. a task-state classifier) are invisible to it,
so log-based cost accounting structurally undercounts. **Wire capture** closes
that gap by recording the actual API traffic — but it is strictly opt-in and
runs only on your own machine.

`junrei-capture-proxy` is a tiny localhost pass-through proxy. It binds
`127.0.0.1` **only** (never a public interface), forwards every request to
`https://api.anthropic.com` unchanged (SSE streams through untouched), and tees
a copy of each exchange to `~/.junrei/captures/<sessionId>.jsonl`.

**Security / ToS — read before enabling:**

- It captures your **full API traffic, including prompt contents**. Treat the
  files under `~/.junrei/captures/` as **sensitive**: never commit or share
  them.
- **Auth headers are redacted at write time** — `authorization`, `x-api-key`,
  cookies, and any header whose name contains `token`/`secret` are replaced
  with `[redacted]` before anything touches disk. The pass-through to the API
  stays byte-faithful; only the stored copy is redacted.
- For Anthropic **subscription (OAuth)** accounts, routing traffic through a
  local proxy sits in a **documented ToS gray zone** (see
  [docs/milestones/goshuin.md](docs/milestones/goshuin.md)) — it is entirely
  your own local, opt-in choice. **API-key** usage carries no such caveat.
- **Retention is user-managed**: delete `~/.junrei/captures` anytime.

Setup — start the proxy, then point a Claude Code session at it:

```sh
pnpm capture
# then, in another shell, run Claude Code through the proxy:
ANTHROPIC_BASE_URL=http://localhost:7967 claude
```

The proxy prints a full banner (including the exact `ANTHROPIC_BASE_URL` line)
on startup. Override the port with `--port`, the captures dir with `--dir` (or
`JUNREI_CAPTURES_DIR`), and the upstream with `--upstream`.

Once captures exist, two MCP tools read them (joined to the session log by the
same `requestId` the log records):

- **`get_actual_request(sessionRef, requestId)`** — the captured wire request
  body, response meta (status/model/usage), **measured** `latencyMs`, and
  `isSubagent` for that request.
- **`get_hidden_calls(sessionRef)`** — the captured requests whose `requestId`
  never appears in the session log: the concrete evidence of undercounted
  cost/latency (each call's content is fetched via `get_actual_request`).

Captures also serve as the **calibration ground truth** for the reconstruction
layer (`get_reconstructed_request`): whenever a capture exists for a session,
reconstruction accuracy is measured against the real wire bytes rather than
assumed (see `experiments/claude-code-capture/recon/`).

## Development

`aqua.yaml` references a local (non-standard) registry (`aqua/kumo-registry.yaml`,
for the `kumo` S3-compatible test server) — aqua v2 requires trusting it once
before `aqua i -l` will install from it:

```sh
aqua policy allow aqua-policy.yaml
```

CI does the non-interactive equivalent via aqua-installer's `policy_allow`
input, so this is a one-time local step only.

```sh
aqua i -l
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

`build`, `typecheck`, and `test` are orchestrated by
[Turborepo](https://turborepo.dev) (`turbo.json`) for task ordering and local
caching across the workspace; `pnpm dev`/`pnpm start` are unaffected and keep
using the launcher scripts above. Linting/formatting is via Biome; tests run
each package's vitest suite plus a launcher `node --test` suite and skill
validation. CI runs the same gates.

See [docs/design.md](docs/design.md) (v1 technical design),
[docs/concept.md](docs/concept.md) (v2 concept & signal model), and
[docs/roadmap.md](docs/roadmap.md) (feature history/status) for more.

## License

MIT
