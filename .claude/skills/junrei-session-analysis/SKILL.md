---
name: junrei-session-analysis
description: Evidence-grade methodology for analyzing, auditing, or retrospecting a Claude Code or Codex agent session over Junrei's MCP tools, and for closing the self-improvement loop (record a fix, check whether it helped). Use whenever asked to analyze/review/retrospect an agent session, investigate cost/behavior/looping/delegation, propose or record a learning, or produce an evaluation grounded in Junrei data. Encodes the six-tool loop order, the provenance-citation rule, the confidence-class trust order, and truncation handling. Load it before drafting any analysis or logging any learning.
---

# Junrei Session Analysis

Junrei's MCP surface is a six-tool **self-improvement loop**, not a data dump.
Every tool returns conclusion-first, quantitative data plus an explicit `_meta`
envelope (`approxTokens`, optional `truncated`, and `nextSteps` that never
dead-end) — never a judgment. This skill is the operational playbook for
turning that data into an evidence-grade analysis and for driving the loop:
what order to call the tools in, how to cite evidence, and how to avoid the
mistakes the truncation flags, `notAvailable` markers, and diagnostic
confidence classes exist to prevent.

The loop the surface is built around:

```
briefing  ──▶  analyze_session  ──▶  log_learning  ──▶  review_learnings
(what's       (why, for one       (record the       (did the change
 wrong)        session)            fix as a          help — before/after)
                                   learning)
      find_patterns ─ generalize a single finding to a pattern
      get_evidence  ─ quote the ground-truth behind any claim
```

## When to use

Any time you are asked to analyze, audit, review, retrospect, or "grade" an
agent session (yours or another agent's) using Junrei — cost breakdowns, "did
it follow instructions", "why did it loop", "where did the budget go",
delegation quality — OR to propose/record a fix and later check whether it
worked. Not needed for a single quick lookup (e.g. "what's this session's
cost") that produces no written analysis and no learning.

## Tool order

Work top-down; stop as soon as you have enough evidence for the question
asked. Each tool's `_meta.nextSteps` tells you what to call next, and each
tool's payload tells you whether the next step is worth it.

1. **`briefing`** — START HERE. The morning paper for a repo (or all repos):
   a conclusion-first roll-up of the last `days` days (default 7). Returns a
   period `summary` (`costUsd`, `sessionCount`, `wasteUsd`, `wasteCount`,
   `wasteShareOfCost`, `cacheHitRate`, `delegationShare`, each with a
   previous-window `delta`), a dollar-ranked `waste[]` (each item has a
   `class`, `title`, copy-ready `fix`, optional `impactUsd`, and
   `provenance.sessionId`), `wins[]` (delegation patterns that are working),
   the learning-ledger standing (`learnings.open/applied/verified/rejected`
   plus `recent[]`), a `dailyCosts[]` series, and `topSessions` by cost.
   Params: `repo?` (a bare repo name like `junrei`, an absolute repoRoot, or a
   fallback bucket key — omit for all repos; a bare name matching several repos
   comes back as an error listing the candidates), `days?`, `detail?`
   (`concise` default | `full`).
2. **`analyze_session`** — the why, for ONE session. Params: `source`
   (`claude-code` | `codex`), `sessionId`, `detail?` (`concise` | `full`).
   Returns a `summary` (`headline`, `costUsd`, `costIsComplete`, `models`,
   `delegationShare`), `costDrivers[]` (per-thread `{thread, model?, estUsd?,
   resultChars, charsSharePct}`, priced-desc), the same `waste[]` shape briefing
   uses, a `delegation` health read (`mainCostShare`, `subagentCostShare`,
   `subagentCount`, `models`, `oversizedReturnCount`), and
   `recommendations[]` — each carrying a ready-to-submit `logLearningCall`
   object (`finding`, `change`, `expectedEffect?`, `sourceSessions[]`) so
   acting on it is passing that object VERBATIM as a single `log_learning`
   call's arguments — `log_learning` preserves `sourceSessions` exactly as
   given, it does not need (or want) to be trimmed to `finding`/`change`.
   Read `briefing`'s top waste
   session's `firstPrompt` context in mind: quantitative data has no opinion on
   intent, so know the task before judging any behavior "wrong".
3. **`get_evidence`** — the drill-down, ONLY for a claim that needs
   ground-truth. Params: `source`, `sessionId`, a single `select` shape, an
   optional `agentId` (Claude only — scope into one subagent's own transcript,
   from a `tool_calls` `thread`), and `detail?` (`full` raises the per-field
   truncation cap). `select.type` is one of:
   - `record` — one 1-based JSONL `line`'s full detail.
   - `tool_call` — one call+result by `toolUseId` (call and result as a unit,
     with full tool-result text recovery past the log's own capture cap).
   - `tool_calls` — a filterable listing (`toolName?`, `limit?`) to DISCOVER a
     `toolUseId`; each row carries `toolUseId`, `line`, `thread`, `status`,
     `inputChars`, `resultChars`, `inputSummary` (and `family`/`subcommand`
     for Bash).
   - `first_prompt` — the original task (`firstUserPrompt`, `title`,
     `userTurnCount`).
   - `task_executions` — every Bash/Agent run (**Claude only**).
   The result wraps the underlying getter's own payload under `data`; a kind a
   harness can't provide comes back with `notAvailable: true` (never an error).
4. **`log_learning`** — record (or update) a learning in the repo-local ledger
   under `<repoRoot>/.junrei/learnings/<id>.json`. This is the ONLY tool that
   WRITES a learning, and it is an **upsert**:
   - **Create** — omit `id`, pass `finding` + `change`. An `analyze_session`
     recommendation's `logLearningCall` object is accepted **VERBATIM**: pass
     it as the call's arguments as-is (`finding`, `change`, `expectedEffect?`,
     `sourceSessions[]` — all of them, not just `finding`/`change`) and every
     contributing session's provenance is preserved exactly, unchanged. The
     repoRoot is `repoPath` if given, else derived from the FIRST
     `sourceSessions` entry's session cwd, else the top-level `source` +
     `sessionId` session's cwd. Passing top-level `source` + `sessionId`
     alone (no `sourceSessions`) still attaches single-session provenance as
     before; if you pass both, `sourceSessions` wins and the top-level pair is
     merged in only if it isn't already one of the array's entries.
     `proposedBy` defaults to `agent`.
   - **Update** — pass the `id` plus a `status` transition
     (`open` → `applied` → `verified`/`rejected`; `applied` stamps `appliedAt`,
     `verified`/`rejected` stamps `resolvedAt`) and/or a `verification`
     measurement (`{metric, before, after, windowDays, note?}`).
   Returns the saved `learning`, its `path`, `created`, and `nextSteps` for
   closing the loop.
5. **`review_learnings`** — the did-it-help step. Read-only: it NEVER writes a
   status. Params: `repoPath?` (absolute repoRoot; omit to scan every known
   repo's ledger), `repo?`, `status?`, `windowDays?` (default 14). Returns the
   repo's `open` + `applied` learnings, and for each APPLIED learning a
   COMPUTED `comparison` (`before`/`after` window metrics — `costPerDayUsd`,
   `delegationShare`, `cacheHitRate`, `bashEstUsd` — over the `windowDays`
   window on each side of its `appliedAt`, from the repo's cost trend) plus a
   `suggestedVerification` candidate. You judge that candidate and record the
   outcome by calling `log_learning` (status: `verified`/`rejected`).

`find_patterns` is the cross-session generalizer, called from step 2 when a
single-session finding looks like a repo-wide pattern before you log it:
`kind: 'text'` (full-text search — pass `query`, returns `textHits[]`),
`kind: 'delegation'` (group sessions by delegation SHAPE — subagent-count
bucket × model mix — with each shape's avg cost / return size in
`delegationPatterns[]`), `kind: 'waste'` (roll up waste findings by `class`
across sessions in `wastePatterns[]`). Params also take `repo?`, `days?`
(default 14), `detail?`.

## Diagnosis protocol

Before choosing which levers to recommend for an expensive session, **classify
its archetype** from `analyze_session`'s `delegation` cost shares
(`mainCostShare` / `subagentCostShare`). The archetype decides the lever set —
prescribing before classifying is how analyses reach for the wrong fix. Full
provenance and per-rule verify-signals: `docs/cost-playbook.md`.

- **MARATHON** — `mainCostShare` ≥ 85%. Orchestrator-context-dominated: the
  cost is turns × a never-compacted context (seen climbing to 400–650K), not
  delegation. Levers: cap context lifetime (compact / split), one PR per
  session.
- **FAN-OUT** — `mainCostShare` ≤ 55% (`subagentCostShare` dominant).
  Subagent-tier / turn-length-dominated. Levers: drop the subagent tier (opus
  is ~5× sonnet per message — reserve it for adversarial review), bound the
  subagent turn budget (~60 tool calls; >150 is a design failure).
- **MIXED** — in between (the main thread AND the subagents are each large
  lines). Apply both lever sets.

Context lifetime is the cross-cutting check for all three: `compactions` was
empty in every studied session and context ran to 270–503K even in fan-out
sessions, so a high `contextTokens` peak is a finding regardless of archetype.

### Refuted hypotheses — do not re-litigate these

These were tested against Junrei data and rejected; do not spend an analysis
re-deriving them (evidence in `docs/cost-playbook.md` §0):

- **Bash dollar waste is not a cost lever.** Direct bash spend is ≈$1 even in
  expensive sessions. Duplicate reruns are a *signal* of re-exploration
  (context inflation), never the recoverable spend themselves — report them as
  a signal, not a dollar opportunity.
- **Subagent return size is rarely the driver.** Main-thread `tool_result`
  totals measured ≈48K tokens; keep the return contract, but don't attribute a
  session's cost to return payloads.
- **Fan-out width per se is not the driver.** Per-subagent economics match
  between expensive and cheap twins; the tier and turn budget drive cost, not
  the worker count.
- **Error/harness friction is <1%.** `apiErrors` ≈ 0 and tool-error rates are
  low everywhere; the cost gap is structural (method), not error churn.

## Hard rules

### Every claim cites provenance

Every factual sentence in an analysis is traceable to a specific `sessionId`
plus a source anchor. A waste finding or a recommendation cites its
`provenance.sessionId` (and `title` when present). A claim about what a
specific call did or returned cites the JSONL line in `[Lnnn]` format (e.g.
"the Bash call at `[L23]` failed") — and you only earn that citation by
actually fetching it: `get_evidence` with `select.type: 'tool_calls'` to find
the `toolUseId`/`line`, then `select.type: 'tool_call'` or `'record'` to read
it. If you cannot point at the finding's `provenance` or the line that backs a
claim, the claim doesn't go in the analysis — go fetch it first. Never assert
what a call did without having fetched it through `get_evidence`.

### Recommendations are template synthesis, not judgment

`analyze_session`'s `recommendations[]` and briefing's `waste[]` are
deterministic, provenance-carrying observations with **templated** fix text —
they are NOT LLM evaluations of the session. Present them as "the data ranks
this as the costliest recoverable item, and here is the mechanical fix for its
class", never as "Junrei judged this session inefficient". Junrei never scores
or grades; interpretation is yours to add on top, clearly labeled as your own.

### A repetition or a waste item is not automatically "wasteful"

`waste[]` items (`near-duplicate`, `rerun-after-error`, `bash-as-read`,
`large-result`, `oversized-return`) are observations, not verdicts. A
near-duplicate may be intentional (polling, a retry after a real state change);
an oversized return may be the point of the delegation. Read the session's
intent (`get_evidence` → `first_prompt`) before asserting a finding was
avoidable, and say so when it might not be.

### `notAvailable` / absence is not evidence of absence

Codex sessions mark `repetitions` and `taskExecutions` as `notAvailable`
(surfaced in `analyze_session`'s / briefing's `notAvailable[]`, and as
`notAvailable: true` on a `get_evidence` result). A kind coming back
`notAvailable` means "this harness cannot tell you," never "this didn't
happen." Say "not observable for `codex` sessions", never "did not occur".
Likewise a `wasteUsd`/`impactUsd` of `null`/`undefined` means "could not be
priced," never `0` — unpriced items still rank above nothing and must be shown
as `unpriced`, not dropped or treated as free.

### Cost is a lower bound

Junrei's `costUsd`/`estUsd` figures are pricing-table estimates (token counts ×
a bundled pricing snapshot), and the session log structurally undercounts
hidden/background API calls. When `analyze_session` reports
`summary.costIsComplete: false`, say so. Phrase totals as "≈$X (pricing-table
estimate) — a lower bound; hidden auxiliary calls are not counted by the
session log." (The opt-in wire-capture diagnostic below can tighten this, but
only when it's been enabled.)

### Explicit-truncation awareness

Every capped field in Junrei's responses says so: a `*Truncated: true` flag
alongside a `*FullCharCount` (e.g. `resultText` → `textTruncated` +
`textFullCharCount`; a record's `contentTruncated` + `originalCharCount`), and
`_meta.truncated: true` when `detail: 'concise'` (or a hard cap) dropped list
entries. Never quote a truncated string as if it were complete, and never
silently drop the fact it was cut. On `briefing` / `analyze_session` /
`find_patterns`, `_meta.truncatedFields` lists exactly which arrays were cut,
as `{path, shown, total}` per array — read it to decide whether `detail:
'full'` will recover the rest (its `total` is within the full-detail cap for
that field) or the query must be narrowed/paged instead of blindly retrying
with `detail: 'full'`. `_meta.truncated: true` remains the coarse flag and is
always set whenever `truncatedFields` is present. If the cut text matters,
re-call with `detail: 'full'` (raises `get_evidence`'s per-field cap) rather
than inferring the rest. A field still short of its `*FullCharCount` even
after `detail: 'full'` means the underlying recovery itself couldn't complete
(rare) — say so rather than treating the shorter text as whole.

### Closing the loop honestly

When you `log_learning`, record what you actually observed and what you
actually changed — not an aspiration. When you `review_learnings`, the
`comparison`/`suggestedVerification` is a CANDIDATE computed from the repo's
cost trend around `appliedAt`; a cost delta over that window is correlational,
not proof the learning caused it. Judge it as such before recording
`verified`/`rejected`, and put your caveat in the `verification.note`.

## Diagnostics (normally unused)

Two extra tools — `inspect_wire` (modes `reconstructed` / `actual` / `hidden`)
and `export_trace` — are registered ONLY when the server runs with
`JUNREI_DIAGNOSTICS=1`, and only for Claude Code sessions. They expose the
request-reconstruction and opt-in wire-capture layers (real `/v1/messages`
payloads, measured latency, structurally-undercounted hidden calls) and a
normalized `junrei-evaluation-trace/v1` export for external eval pipelines /
LLM-judges. Most loops never need them; reach for them only when the question
is specifically "what did the model actually see on the wire" or "hand this
whole session to another eval system", and when they've been enabled.

## Report shape

A finished analysis lets a skeptical reader verify every claim without
re-running your tool calls: state the finding, cite its `provenance.sessionId`
(and `[Lnnn]` for a specific call), label estimates as lower bounds and
unpriced items as unpriced, and name what the data cannot tell you
(`notAvailable` dimensions, truncated fields you couldn't fully recover). When
the analysis ends in an action, `log_learning` it so the finding becomes a
tracked change the next `review_learnings` can measure — that persistence, not
the prose, is what makes the loop improve over time.
