# Junrei — Design

Junrei is **self-improvement-loop infrastructure for coding agents**: a
local-first tool that parses coding-agent session logs into quantitative,
reproducible observations and closes the loop between "what did the agents cost
and do" and "what did we change about it". The observations are visualized in a
web UI and — the primary surface — exposed to the agents themselves via MCP.

Junrei computes and presents **logic-derived, quantitative data only**.
Qualitative judgment ("this session was inefficient") is deliberately left to
humans or to the agents consuming the data through MCP. Junrei never scores,
grades, or evaluates — see [Concept (v3)](#concept-v3) for how that principle
survives even the `recommendations`/`waste` fix suggestions.

## Concept (v3)

### North star: the agent self-improvement loop

The product is not a dashboard; the dashboard is a peephole. The north star is
an **autonomous improvement loop the agents run on their own activity**:

```
Measure  ──▶  Learn  ──▶  Change  ──▶  Verify
(briefing/    (log a       (apply the   (review_learnings:
 analyze:      learning,    fix in the   before/after around
 what cost     open)        repo/config) the change)
 what)                                         │
   ▲───────────────────────────────────────────┘
```

An agent (or a human) calls `briefing` to see the week's waste, `analyze_session`
to understand one session, records the fix as a **learning**, applies it, and
later calls `review_learnings` to see whether the metrics moved. The web UI
(Briefing / Sessions / Learnings) is a human-facing window onto the same loop —
useful, but not where the leverage is.

### MCP-first: few, high-leverage, self-describing tools

The MCP surface is the product's primary interface, so it is designed for an
agent's context budget, not for completeness:

- **Few tools, conclusion-first.** Six loop tools (plus two opt-in
  diagnostics), each returning the answer ranked first, not a raw data dump.
- **`_meta` on every response.** `approxTokens` (a cheap size estimate so a
  caller can budget context before spending it), optional `truncated`, and
  `nextSteps` that are ALWAYS populated on empty/error paths — a response never
  dead-ends; it always says what to call next.
- **`detail` staging.** Every composition tool takes `detail: 'concise' | 'full'`
  so a caller controls response size in two steps rather than paying for
  everything up front.
- **A schema-size guard.** A test caps the total MCP schema token estimate,
  because schema bloat is a permanent per-call cost on every session.

### The learnings ledger: repo-local, committable, team-shared

A learning is a durable record — `<repoRoot>/.junrei/learnings/<id>.json`, one
file per learning — of "what did we learn about how this repo's agents behave,
and did changing it help". Storing it **in the repo** (not in a private DB)
makes it git-committable, reviewable in a PR, and shared across a team and
across every worktree of the same checkout (the repoRoot is normalized to strip
`.claude/worktrees/<name>` suffixes). `log_learning` is the only writer (an
upsert over status transitions and verification); `review_learnings` reads it
and computes — never persists — a before/after comparison. See
[the ledger types](#learnings-ledger) below.

### Acceptance gates (G1–G5)

The loop is considered real when:

- **G1 — three calls to the next action.** An agent reaches a concrete next
  action within three MCP calls. *Measured:* `briefing → analyze_session →
  log_learning` is exactly three calls, and each response's
  `_meta.nextSteps` names the following one — G1 is met at 3 calls.
- **G2 — persistence.** A recorded learning survives as a committable file the
  next session can read (`.junrei/learnings/`).
- **G3 — before/after.** `review_learnings` attaches a computed
  before/after comparison to every applied learning.
- **G4 — five-second read.** The Briefing home surfaces learnings, waste, and
  wins visibly within about five seconds of opening it.
- **G5 — no number drift.** Every figure the web UI shows traces to one server
  response (`GET /api/briefing` etc.); the client never re-aggregates, so two
  panels can't disagree.

### "Junrei doesn't evaluate" — restated for the loop

The no-judgment principle is unchanged but sharper now that the tools emit
`recommendations` and ranked `waste`: those are **deterministic, provenance-
attached observations with templated fix text**, mechanically derived from the
same quantitative signals (Bash opportunities, oversized returns) — NOT LLM
judgments of a session. Junrei ranks the costliest recoverable item and states
the mechanical fix for its class; deciding whether that finding was actually
avoidable, and acting on it, stays with the human or the consuming agent.

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

## MCP interface (6 + 2)

The surface is the six-tool self-improvement loop (see [Concept (v3)](#concept-v3)),
plus two opt-in diagnostics. The earlier `get_*`-per-metric lineup (≈20 tools)
was retired: the underlying analysis functions in `@junrei/core` remain, but the
MCP layer now exposes them only through these conclusion-first composers. Every
tool is a thin binder over the `@junrei/core` `insight/` layer and returns a
`_meta` envelope.

**Core loop (always registered, both harnesses unless noted):**

- `briefing` — conclusion-first roll-up of a repo (or all repos) over `days`:
  period summary with previous-window deltas, dollar-ranked `waste[]`, `wins[]`,
  learning-ledger standing, `dailyCosts[]`, `topSessions`.
- `analyze_session` — the why for one session: `summary`, `costDrivers[]`,
  `waste[]`, `delegation` health, and `recommendations[]` (each with a
  ready-to-submit `logLearningCall`). Codex marks `repetitions`/`taskExecutions`
  `notAvailable`.
- `find_patterns` — cross-session search: `kind: 'text' | 'delegation' | 'waste'`.
- `get_evidence` — the drill-down through one `select` shape (`record`,
  `tool_call`, `tool_calls`, `first_prompt`, `task_executions` [Claude only]);
  an unsupported kind returns `notAvailable`, never an error.
- `log_learning` — upsert a learning into the repo-local ledger (the only
  writer).
- `review_learnings` — read-only listing of `open` + `applied` learnings, each
  applied one carrying a computed before/after comparison (never persisted).

**Diagnostics (registered only under `JUNREI_DIAGNOSTICS=1`, Claude Code only):**

- `inspect_wire` — `mode: 'reconstructed' | 'actual' | 'hidden'` over the
  request-reconstruction and opt-in wire-capture layers.
- `export_trace` — a normalized `junrei-evaluation-trace/v1` document for
  external eval pipelines / LLM-judges.

Parameter vocabulary is disambiguated in the tool descriptions: `repo` is a
normalized repo key (a bare name, an absolute repoRoot, or a fallback bucket
key), while `repoPath` is always an absolute repoRoot.

### Web lenses

The web UI is three top-level views — **Briefing** (`/`, the loop's Measure
face), **Sessions** (`/sessions`, the filterable session list), and
**Learnings** (`/learnings`, the Measure→Learn→Change→Verify board) — and a
per-session detail restructured into three lenses: **Story** (conclusion-first
read + embedded timeline), **Orchestration** (delegation tree/waterfall/flame),
and **Evidence** (Context, Files & skills, and Tools sub-tabs — the only place
internal ids like line numbers and `tool_use_id` are exposed). This replaces the
earlier six-lens layout (Overview / Timeline / Orchestration / Context & cost /
Files & skills / Tools).

## Learnings ledger

A `Learning` (in `@junrei/core`'s `insight/types.ts`) is stored one file per
learning under `<repoRoot>/.junrei/learnings/<id>.json`, written atomically
(tmp + rename), with an id of `L-YYYYMMDD-<slug>` (UTC date, `-2`/`-3` suffix on
a same-day slug collision):

```ts
type LearningStatus = "open" | "applied" | "verified" | "rejected";

interface Learning {
  id: string;                 // L-YYYYMMDD-<slug>
  createdAt: string;          // ISO 8601
  repo: string;               // normalized repo name
  sourceSessions: { source: "claude-code" | "codex"; sessionId: string; title?: string }[];
  finding: string;            // what was observed
  change: string;             // what to change in response
  expectedEffect?: string;
  status: LearningStatus;     // open -> applied -> (verified | rejected)
  proposedBy: "agent" | "human";
  appliedAt?: string;         // stamped on -> applied
  resolvedAt?: string;        // stamped on -> verified | rejected
  verification?: { metric: string; before: number; after: number; windowDays: number; note?: string };
}
```

The lifecycle is not enforced in code (a human can move a learning anywhere);
`log_learning` only timestamps the two structural boundaries and records a
`verification`. The ledger is committed with the repo, so the very first entry
(`.junrei/learnings/L-20260719-6-git-diff-head-path-path-repeated-acros.json`)
is a real, agent-proposed learning that Junrei found in its own sessions.

## License note

ccusage (MIT, © 2025 ryoppippi) was studied as a reference for cost calculation.
Junrei implements its own cost engine against the same public pricing sources
(LiteLLM). Any copied snippet must carry an MIT attribution notice.
