# Junrei — Design

Junrei is an **Agent Statistics Analyzer**: a local-first tool that parses coding-agent
session logs and turns them into quantitative, reproducible metrics — visualized in a
web UI and exposed to coding agents via MCP.

Junrei computes and presents **logic-derived, quantitative data only**. Qualitative
judgment ("this session was inefficient") is deliberately left to humans or to coding
agents consuming the data through MCP. Junrei never scores, grades, or evaluates.

## Positioning

Prior art is single-purpose:

| Tool | Focus | Gap |
| --- | --- | --- |
| ccusage | Cost/token reports | No behavior/trajectory analysis |
| sniffly | Error-category dashboard | No cost, no trajectory, no MCP |
| claude-code-log / claude-code-trace | Transcript viewers | Viewers, not analytics |
| OTel pipelines | Live metrics | Requires instrumentation; no retroactive analysis |

Junrei's niche: **local JSONL parsing × behavioral/trajectory metrics × MCP access**,
with zero setup and retroactive analysis of accumulated logs.

## v1 scope (Claude Code only)

Data source: `~/.claude/projects/<munged-project-path>/<sessionUuid>.jsonl`
plus per-session sidecar dirs (`<sessionUuid>/subagents/agent-*.jsonl` + `.meta.json`).

### Metric set

**Base (confirmed):**

- Token accounting per model: input / output / cache-read / cache-creation.
  Usage records are deduplicated by `message.id` (one content block per JSONL
  record). Input/cache fields are identical across a message's records, but
  `output_tokens` is a growing streaming snapshot — the LAST occurrence per id
  carries the final billed total and wins.
- Cost (USD) per session and per model, including subagent transcripts.
  Pricing from LiteLLM's `model_prices_and_context_window.json` (bundled snapshot,
  ccusage-compatible approach; ccusage itself is MIT but ships no reusable library).
  Tiered >200k pricing and cache 5m/1h ephemeral rates supported.
- Context growth curve: `input + cache_read + cache_creation` per unique API message
  over time.
- Compaction events: `system/compact_boundary` records (`preTokens`/`postTokens`,
  trigger auto|manual) and `isCompactSummary` user records.
- Tool call histogram + success/failure per tool (`tool_use` → `tool_result` linkage
  via `tool_use_id`; `is_error: null` treated as success).
- Subagent execution tree: from `subagents/agent-*.jsonl` + `agent-*.meta.json`
  (`toolUseId` links to the parent's `tool_use` block; `spawnDepth` for nesting).
  Some Claude Code versions (observed on 2.1.138) write meta.json without
  `toolUseId`; the analyzer then recovers the link from the parent-side
  `toolUseResult.agentId` (present for sync and async launches alike). The only
  case left unlinked is a launch whose `tool_result` never landed in the parent
  transcript (session interrupted mid-agent) — its return is honestly reported
  as not captured. Each subagent node carries its own model, prompt, token/cost
  accounting, and its transcript can be analyzed with the same pipeline
  recursively.

**Differentiators (from interview):**

- **Loop / repetition detection**: near-duplicate consecutive tool calls (same tool +
  similar input), same-file re-reads above a threshold, repeated failing commands.
- **Tool error classification**: pattern-based categories over `is_error` results
  (file-not-found, string-not-found, command-failed, permission-denied, …).
- **Exploration profile**: Read:Edit ratio, turns-to-first-edit, distinct files
  read vs. edited.

**Added during v1 (user request):**

- **Task executions**: every Bash command and Agent run — foreground and
  background — plus preview dev servers, matching how Claude Code's
  Background-tasks panel counts tasks. Foreground executions complete with
  their `tool_result` (duration = result timestamp − call timestamp);
  background launches (`toolUseResult.backgroundTaskId`,
  `status == "async_launched"`) are joined with harness `<task-notification>`
  records by task id. Notifications that arrived while the agent was mid-turn
  are recorded as `queue-operation` / `attachment(queued_command)` records and
  are handled too. Note the panel itself is ephemeral UI state (entries can be
  cleared and are capped), so Junrei's log-derived list is a superset.

**Explicitly out of v1:** LLM-as-judge scoring, Codex support, live OTel ingestion,
cross-session aggregate dashboards, interruption/outcome proxies.

### Quantitative-data principles

Every metric must be:

- reproducibly computable from the session data alone,
- clearly defined,
- traceable to source events (provenance: record UUIDs / line numbers),
- stable for identical input,
- free of model-based subjective judgment.

## Architecture

pnpm workspace monorepo, TypeScript strict everywhere:

```
packages/
  core/    Session log discovery, streaming JSONL parsers, metric computation,
           pricing/cost engine. Pure TypeScript, no I/O framework deps.
           src/ is three peer trees, each with its own barrel (index.ts):
             shared/  agent-agnostic vocabulary and helpers (token/usage
                      types, timeline/record-detail shapes, pricing, repo
                      identity, search-field flattening, delegation split).
                      Never imports claude/ or codex/.
             claude/  everything Claude-Code-specific (JSONL parser, session
                      analysis, subagent-sidecar resolution, timeline
                      builder). May import shared/, never codex/.
             codex/   everything Codex-specific (rollout parser, session
                      analysis, sub-agent-thread forest, timeline builder).
                      May import shared/, never claude/.
           The top-level src/index.ts re-exports all three barrels plus the
           `AnySessionAnalysis` discriminated union.
  server/  Hono (Node) server: REST API for the web UI, MCP endpoint
           (Streamable HTTP, official @modelcontextprotocol/sdk), serves the
           built SPA in production. `sources/claude.ts` and `sources/codex.ts`
           each implement the `SourceAdapter` contract (`sources/shared.ts`)
           via `satisfies`, so the two harnesses are peer implementations
           app.ts/sessions.ts dispatch to instead of branching on `source`.
  web/     Vite + React SPA. Talks to the server API (typed via Hono RPC client).
```

Rationale:

- **Hono over Next.js**: no SSR need for a local tool; single lightweight process;
  clean migration path to Tauri/Electron sidecar later; Hono RPC gives end-to-end
  API types without codegen.
- **MCP over Streamable HTTP only** (interview decision): one process serves UI,
  API, and MCP. Register in Claude Code with the printed URL.
- **Parsing is tolerant by design**: unknown record types, missing fields, and
  malformed lines are skipped but counted (surfaced as `parseWarnings`), since the
  log schema changes across Claude Code versions.
- **shared/claude/codex as peer trees**: Claude Code and Codex CLI support grew
  organically with Codex modules nested under `core/src/codex/` while
  Claude-specific modules sat at the top level, so Codex quietly imported
  Claude-only files just to reach genuinely shared vocabulary (token totals,
  timeline entry shapes, the subagent-forest node). Promoting that vocabulary
  into `shared/` and making `claude/` a real peer of `codex/` makes the
  boundary structural: an architecture test (`core/test/architecture.test.ts`)
  scans imports and fails the build if either harness reaches into the other,
  or if `shared/` reaches into either.

### Port strategy

`pnpm start` uses API port 7867 and Web port 5873 by default; override them with
`JUNREI_PORT` and `JUNREI_WEB_PORT`. `pnpm dev` is the concurrent-worktree mode:
it searches from 7868/5874 upward for free API/Web ports and prints the resolved
Web, API, and MCP URLs before starting the servers. The Vite proxy always uses
the same resolved API port.

### Session log parsing notes (observed CC 2.1.138–2.1.209)

- Record types: `user`, `assistant`, `system` (subtypes `compact_boundary`,
  `api_error`, `stop_hook_summary`, `local_command`), `attachment`, plus metadata
  records (`ai-title`, `custom-title`, `last-prompt`, `pr-link`, `queue-operation`,
  `mode`) that lack the common envelope.
- File order is authoritative; timestamps can invert by ~1ms. Sort by file order.
- `assistant` records hold exactly one content block; group by `message.id`.
- Tool results: `user` records with `message.content[].tool_result`, structured
  detail in top-level `toolUseResult` (shape varies per tool).
- Sidechains live in separate files with `isSidechain: true` and `agentId`;
  their usage is NOT included in the parent file. Cost must sum both.
- `input_tokens`/`output_tokens` in logs can be streaming lower bounds; cache
  fields are reliable. Costs are estimates and labeled as such.
- A message's records repeat its usage with `output_tokens` growing across
  occurrences (e.g. 5→5→473); only the last occurrence holds the final billed
  output. Measured on a real Workflow-heavy session: first-occurrence dedup
  undercounted subagent cost $13.05 vs $17.39; summing without dedup
  multiplies cache tokens ($43.31).
- Tool results can appear BEFORE their `tool_use` record in file order
  (parallel batches interleave) — linkage must be two-pass.
- `<task-notification>` user records are harness events, not human prompts —
  they must be excluded from user-turn counts.
- Desktop-app sessions (`entrypoint: "claude-desktop"`) write NO
  `ai-title`/`custom-title` records; their title lives only in the Desktop
  metadata store (`~/Library/Application Support/Claude/claude-code-sessions/
  <install>/<scope>/local_<desktopId>.json`, `cliSessionId` = transcript UUID).
  Junrei reads that store as a title fallback (`loadClaudeDesktopTitles`,
  override dir with `JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR`); a transcript's own
  title records win when both exist.
- Context injections are NOT persisted by current Claude Code (verified on
  CC 2.1.202–2.1.209 transcripts, 2026-07): the `<system-reminder>` blocks
  the harness prepends to a user turn — including the
  `Contents of <abs-path> (<label>):` headers carrying CLAUDE.md and the
  auto-memory MEMORY.md — never reach the transcript JSONL; the first user
  message records only the command/prompt content. Injected-file detection
  (`CONTENTS_OF_HEADER` → `fileAccess.injectedCount`/`injectedChars`, #40)
  therefore fires only on older-format transcripts and is kept for
  legacy-log compatibility; on current logs CLAUDE.md legitimately never
  appears in the Files & skills lens (data absence, not a Junrei bug).

## MCP interface (v1)

Few, high-leverage tools (not a 1:1 dump of the data model):

- `list_sessions` — recent sessions with project, title, time range, turns, cost.
- `get_session_summary` — full quantitative summary for one session.
- `get_context_timeline` — context-size series + compaction events.
- `get_tool_stats` — per-tool histogram, error rates, error categories.
- `find_repetitions` — loop/repetition findings with source event references.
- `get_subagent_tree` — subagent tree with per-node prompt/model/cost.

## License note

ccusage (MIT, © 2025 ryoppippi) was studied as a reference for cost calculation.
Junrei implements its own cost engine against the same public pricing sources
(LiteLLM). Any copied snippet must carry an MIT attribution notice.
