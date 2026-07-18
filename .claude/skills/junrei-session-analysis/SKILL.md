---
name: junrei-session-analysis
description: Evidence-grade methodology for analyzing, auditing, or retrospecting a Claude Code or Codex agent session over Junrei's MCP tools. Use whenever asked to analyze/review/retrospect an agent session, investigate cost/behavior/looping/delegation, or produce an evaluation report grounded in Junrei data. Encodes the tool order, provenance-citation rule, confidence-class trust order, and truncation handling proven by the Goshuin milestone's fresh-context MCP-only acceptance test — load it before drafting any report.
---

# Junrei Session Analysis

Junrei's MCP tools return quantitative data and explicit completeness
declarations — never judgments. This skill is the operational playbook for
turning that data into an evidence-grade analysis: what order to call tools
in, how to cite evidence, and how to avoid the specific mistakes the Goshuin
milestone's blind-spot metadata (`sourceCompleteness`) and confidence classes
(`get_reconstructed_request`) exist to prevent.

## When to use

Any time you are asked to analyze, audit, review, retrospect, or "grade" an
agent session (yours or another agent's) using Junrei — cost breakdowns,
"did it follow instructions", "why did it loop", "where did the budget go",
delegation quality, or a structured report for a human or another system.
Not needed for a single quick lookup (e.g. "what's this session's cost")
that doesn't produce a written analysis.

## Tool order

Work top-down; stop as soon as you have enough evidence for the question
asked. Each step's output tells you whether the next step is worth calling.

1. **`get_session_summary`** — cost/tokens per model, delegation split, tool
   error categories, exploration profile. The overview everything else
   refines.
2. **`get_first_prompt`** — the original task. Read this before judging
   whether anything the session did was "correct" — quantitative data has no
   opinion on intent.
3. **`get_subagent_tree`** — delegation structure, per-agent cost/tokens,
   `workflowRuns`. Skip if `subagentCount` is 0.
4. **`get_context_timeline`** / **`find_repetitions`** / **`get_task_executions`**
   — pick based on the question: context growth and compactions; loop/
   duplicate-call detection; the Background-tasks-panel view of every Bash
   and Agent run. These are observations, not verdicts — a repetition may be
   intentional (e.g. polling); say so rather than asserting "wasteful".
5. **Drill down** with **`get_records`** (bulk, by line number — up to 50 at
   once) or **`get_tool_call`** (one `toolUseId`, call + result as a unit,
   with full tool-result text recovery past the log's own capture cap) —
   this is where a claim earns its provenance citation (see below). Never
   assert what a tool call did or returned without having actually fetched
   it through one of these two.
6. **`get_reconstructed_request`** — the action space (system prompt, tool
   schemas, generation params) for one main-loop request, when the question
   is about what the model could see/do, not just what it did. Read the
   confidence-class rules below before trusting any field here.
7. **`get_session_observability`** / **`get_actual_request`** /
   **`get_hidden_calls`** — the opt-in OTel and wire-capture channels.
   ALWAYS check the tool's own declared availability first
   (`otelAvailable`/`captureAvailable`) — a `false` here is a normal,
   expected outcome for most sessions (both channels are off by default),
   not a fetch failure. Don't ask "why is this false" — just fall back to
   the pricing-table estimate / log-only evidence and say so.
8. **`export_evaluation_trace`** — once findings are settled and the target
   is an external eval pipeline or LLM-judge rather than a chat response:
   the merged, provenance-carrying event stream (`gen_ai.*`/`junrei.*`),
   with `enrichment.otel`/`enrichment.captures` declaring what did and
   didn't contribute. Prefer the narrower tools above for an interactive
   analysis — this is the "hand the whole thing to another system" step.

## Hard rules

### Every claim cites provenance

Every factual sentence in an analysis report is traceable to a specific
`sessionId` plus a source anchor: a line number in `[Lnnn]` format (e.g.
"the Bash call at `[L23]` failed with exit code 1") or, for a main-loop
request, its `requestId` (e.g. "request `req_4`'s reconstructed system
prompt..."). If you cannot point at the line/request that backs a claim, the
claim doesn't go in the report — go fetch it with `get_records`/
`get_tool_call` first.

### Absence is not evidence of absence

`sourceCompleteness` marks a dimension `absent` (never recorded by this
source) or `not-recorded` (happens outside what this source observes) —
both mean "this data cannot tell you," never "this didn't happen." The
canonical example: `hiddenApiCalls` is `not-recorded` on the session log
(and STILL `not-recorded` on OTel — the background task-state classifier is
invisible there too, per its own dimension table). A session showing no
hidden calls in the data available to you is not proof none occurred; say
"not observable from this source" instead of "did not happen."

### Maintain a "what this data cannot tell us" section

Every report ends with an explicit list of blind spots, named by their
`sourceCompleteness` dimension — not vague hedging like "data may be
incomplete." Pull the dimension names and their `note` straight from the
tool responses you actually called: e.g. "systemPrompt: absent (not in
session log) — see get_reconstructed_request for a template-confidence
reconstruction, if a template exists for this CLI version" or "latency:
absent (session log) / partial (OTel — only when Claude Code exports
duration_ms) / authoritative (wire capture — measured at the proxy, but
only opt-in)." Every response you touch carries this block; read it, don't
skip past it to the payload.

### Confidence-class trust order (get_reconstructed_request)

Every block/section from `get_reconstructed_request` carries a `confidence`
field. Trust order: **`exact`** (from the session log/attachments alone) >
**`template`** or **`disk-contingent`** (derived, may be stale — for
`disk-contingent`, check the block's `provenance.driftDetected` flag before
using it) > **`unknown`** (never invented; `value`/`text` is absent). Never
present a `template`-confidence value as if it were a verified actual.

**Worked example — model id.** `params.entries.model` is special: when the
log records the target assistant record's own `model` field, that value
overlays the template's captured default with confidence `exact` — so a
session that ran on a different model than the template capture still
reports its REAL model, never a stale default. But every OTHER params key
(`max_tokens`, `thinking`, `stream`, ...) stays `template`-confidence, and
`params.confidence` (section-level) is `unknown` when no template exists at
all for the session's CLI version. Concretely: if you're asked "what model
ran this request", read `params.entries.model.confidence` — if `exact`, cite
it as fact; if `unknown` (no log value and no template default), say so
explicitly rather than guessing from context. Never read a `template`
default as the actual for a field where an `exact` overlay could exist —
`model` is the one field that always tries the log first.

### Cost: prefer OTel-authoritative, always caveat the lower bound

Cost has (up to) two bases, never conflated: `pricing-table-estimate`
(token counts × Junrei's pricing snapshot — what `get_session_summary`/
`get_subagent_tree`/`get_repo_overview` always report) and `otel`
(Claude Code's own billing-computed `cost_usd`, from
`get_session_observability`, authoritative — not derived from token
counts). When `get_session_observability` reports `cost.otel` (i.e.
`otelAvailable: true` and an OTel cost figure exists), prefer it over the
pricing-table estimate and note the `cost.deltaUsd` between them — a
persistently large delta usually signals hidden/background API calls the
session log structurally undercounts. Regardless of which basis you cite,
**always call the total a lower bound** when `hiddenApiCalls` is
`not-recorded` for every source you checked (true by default — it's
`not-recorded` on both the session log and OTel; only wire capture can
improve it, and even then only to `partial`, "visible only when routed
through the proxy" — never a hard guarantee of completeness for the whole
session). Phrase it as: "total cost across observed calls: $X (pricing-table
estimate | OTel-authoritative) — a LOWER BOUND; hidden auxiliary calls are
not recorded by this session's available sources."

### Explicit-truncation awareness

Every capped field in Junrei's MCP responses says so explicitly — a
`*Truncated: true` flag alongside a `*FullCharCount` (or equivalent). Never
quote a truncated string as if it were the complete value, and never
silently drop the fact that it was cut. If the truncated text matters to
your analysis, re-call the same tool with a larger `maxChars`/
`maxCharsPerRecord`/`maxCharsPerField`/`maxCharsPerBlock` parameter instead
of working around the cap (e.g. by inferring the rest) — every drill-down
tool in this playbook accepts one. A `resultText`/`returnedText` that is
STILL short of `resultTextFullCharCount`/`returnedTextFullCharCount` even
after raising the cap means the underlying recovery itself couldn't
complete (rare — e.g. the source line became unreadable); say so rather
than treating the shorter text as complete.

## Report shape

A finished analysis should let a skeptical reader verify every claim without
re-running your tool calls: state the finding, cite `[Lnnn]`/`requestId`
evidence inline, and close with the blind-spots section. When the audience
is another system rather than a person, export via
`export_evaluation_trace` instead of writing prose — its `provenance` field
on every event carries the same citation discipline this playbook requires
of a written report.
