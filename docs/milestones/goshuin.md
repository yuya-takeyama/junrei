# Milestone proposal: Goshuin (御朱印) — evidence-grade agent analysis over Junrei MCP

**Status: PROPOSAL** (2026-07-18). This document records the insights, verified
evidence, and candidate approaches for the next major milestone. **Decisions
and implementation are explicitly deferred** to the next stage — nothing here
is committed yet.

**Codename.** A *goshuin* is the seal a pilgrim collects at each temple as
proof that the visit really happened. This milestone is about giving analyzing
agents that same kind of proof: verifiable, provenance-backed evidence of what
actually happened in a session — including the parts today's session logs
cannot show.

## Problem statement

Junrei's MCP currently serves quantitative summaries (cost, delegation,
tools, timelines) that are accurate but *lossy*, and the underlying session
JSONL is itself an incomplete record of the session (see
[the completeness study](../research/claude-code-session-log-completeness.md)).
An agent asked to evaluate another agent's behavior — "did it follow its
instructions?", "was its action space appropriate?", "where exactly did the
cost/latency go?", "why did it loop?" — hits three walls:

1. **No drill-down**: MCP offers no way to fetch the actual turn text, tool
   arguments, or tool results; the raw-record primitive exists only on the
   HTTP API (`/api/sessions/.../record/:line`), not on MCP.
2. **Missing evidence**: the system prompt, tool schemas (the action space),
   generation params, the CLAUDE.md/memory injection, hidden auxiliary API
   calls, and latency are absent from the log entirely.
3. **Silent incompleteness**: except for `costIsComplete`, responses don't
   tell the caller what the source *cannot* know, so an analyzing agent can
   confidently conclude things the data cannot support.

## Verified evidence base

All numbers below were measured on real captures (claude CLI 2.1.205,
haiku, controlled scenarios; harness in
[`experiments/claude-code-capture/`](../../experiments/claude-code-capture/)).
The completeness study covers the three-channel comparison; this section adds
the Goshuin-specific verification done on 2026-07-18.

### Current MCP surface (audit)

- 9 tools, deliberately "few, high-leverage" summaries (design.md); no
  raw-record fetch, no MCP resources, no pagination primitives on MCP.
- Good existing precedents to build on: line-number provenance on search
  results / timelines / file access; explicit truncation flags
  (`matchesTruncated`, `fileAccessTruncated`); the `costIsComplete`
  completeness flag; `search_sessions` already greps decoded transcript
  values with per-match provenance.

### Reconstruction fidelity (measured)

Reconstructing the actual per-request API payloads from the session log
(ground truth: wire capture of 5 main-loop requests, 57 blocks / ~165 KB):

- **Log + local filesystem** (`~/.claude/CLAUDE.md`, `~/.claude.json`):
  **85.2% of bytes byte-exact, 13.8% exact after 4 mechanical normalization
  rules, 0% missing** (0.9% anomaly: a ~494-byte fixed safety preamble on
  synthetic task-notification turns that the log omits).
- **Log only**: 35.5% of bytes missing — entirely the CLAUDE.md/memory
  `<system-reminder>` block.
- The 4 normalization rules (all deterministic): string↔array content forms;
  strip wire-side `cache_control` stamps; strip log-side `caller` fields on
  tool_use; drop thinking blocks from replayed history (Claude Code never
  re-sends them).
- The agent-listing and skill-listing injections rebuild **byte-exact** from
  the log's `attachment` records plus a fixed wrapper template.
- The CLAUDE.md/memory/userEmail/currentDate block rebuilds byte-exact from
  disk (`~/.claude/CLAUDE.md` + `~/.claude.json` `oauthAccount.emailAddress`
  + the request timestamp) — but only because disk hadn't drifted since the
  session. This path is inherently **disk-contingent**, not log-derived.

### Cross-run stability of the non-logged parts (measured)

Comparing two runs (same CLI version/config, different prompts, ~80 min
apart):

- `tools` array (31 definitions incl. `input_schema`): **byte-identical**,
  same order.
- Generation params (`max_tokens`, `thinking`, `stream`,
  `context_management`, `anthropic-beta`): **byte-identical**.
- System prompt: identity block byte-identical; the 28.4 KB instruction
  block **98.7% line-identical** — the only differing lines are derived from
  `cwd`/`sessionId`, both of which the session log records. I.e. a
  per-CLI-version **template with substitution** reproduces it.
- The 81-byte billing-header system block varies per launch (random build
  suffix) and is not derivable — a known, negligible, unrecoverable
  fragment.

**Implication:** "capture once per CLI version × config, reuse as a
template" is viable for the action space (tools + params) and the system
prompt.

### Wire/OTel facts carried over from the completeness study

- Wire capture joins to session logs with zero heuristics:
  `x-claude-code-session-id` header (session), response `request-id` ==
  log `requestId` (turn), `cc_is_subagent=true` (subagent).
- 2 of 10 API calls in the reference run (a background "task-state
  classifier") are invisible in the session log AND OTel — session-log cost
  accounting structurally undercounts.
- OTel is the sanctioned observability channel in every auth mode; it
  carries authoritative `cost_usd`, `tool_decision`, MCP/hook health — but
  no prompt/tool content.
- A LiteLLM/Bifrost-class gateway cannot carry subscription (OAuth)
  sessions in default configurations; a transparent local pass-through
  can, but sits in a documented ToS gray zone (local-only, opt-in,
  never hosted).

## Candidate approaches

Composable; letters are referenced by the open decisions below.

### A. MCP drill-down primitives (evidence access layer)

Expose the existing record-level capability over MCP: e.g.
`get_records(sessionId, lines|uuids, fields?, maxChars?)` and
`get_tool_call(sessionId, toolUseId)` returning the call, its result, and
associated hook attachments as one unit, with explicit truncation flags and
provenance. Turns "trust my summary" into "here is the line-level evidence."
Smallest effort; pure exposure of data Junrei already has; consistent with
the no-judgment philosophy.

### B. Blind-spot metadata (epistemic honesty layer)

Generalize `costIsComplete` into a `sourceCompleteness` block on MCP
responses: system prompt = absent, tool schemas = absent, hidden API calls =
not-recorded, cost = pricing-table estimate, etc. — so an analyzing agent
knows what it *cannot* conclude. Cheapest of all; can also ship immediately
as an analysis-methodology skill (documentation, zero server change).
Precision improves because false confidence drops.

### C. Reconstruction layer — "virtual wire"

A core module that reconstructs per-request payloads from the log +
attachments + per-version templates, exposed as
`get_reconstructed_request(sessionId, requestId|line)`. Every block carries a
confidence class:

| Class | Meaning | Measured coverage |
|---|---|---|
| `exact` | derived from session data alone (messages, attachment-rebuilt injections) | most bytes |
| `template` | per-CLI-version captured template + log-recorded substitutions (system prompt, tools, params) | 98.7–100% |
| `disk-contingent` | rebuilt from current disk state (CLAUDE.md, memory); may have drifted | flagged |
| `unknown` | not recoverable (billing header, hidden calls) | negligible |

This delivers prompt-level analysis for **all sessions, past and future,
with zero ToS exposure**. It deliberately revisits the earlier
"CLAUDE.md disk-based inference: rejected" decision (2026-07-17, see
[roadmap-archive](../roadmap-archive.md)): the objection was that disk state
isn't reproducible from session data alone.
The confidence classes answer it — `exact`/`template` blocks *are*
reproducible (template inputs are pinned, versioned captures), and
`disk-contingent` blocks are explicitly labeled rather than silently
asserted. Whether that satisfies the quantitative-data principle is an open
decision, not a foregone conclusion.

### D. Wire-capture ingestion (ground truth, opt-in)

Productize the experiment harness: a junrei-owned local pass-through proxy
writing to `~/.junrei/captures/`, joined by session-id/request-id. MCP gains
`get_actual_request`, `get_hidden_calls`, per-request latency. Also serves as
the **continuous calibration rig for C** (whenever a capture exists,
reconstruction accuracy is measured, not assumed). Constraints: local-only,
opt-in, auth-redaction at write time, subscription ToS gray zone documented;
fully legitimate for API-key users.

### E. OTel ingestion (sanctioned side channel)

An OTLP http/json endpoint on the junrei server (a ~60-line receiver was
already validated), stored per `session.id`. Adds authoritative cost
(cross-checked against the pricing-table estimate via an explicit
`costBasis`), permission `tool_decision` events, MCP/hook health, subagent
summaries. No content; pairs with A/C. Works identically in every auth mode.

### F. Evaluation-trace export + analysis playbooks

`export_evaluation_trace(sessionId)`: a normalized merged trace
(log + reconstruction/wire + OTel, OTel GenAI-semconv-flavored) for external
eval pipelines and LLM-judges. Plus junrei-shipped analysis skills encoding
methodology over the MCP tools (the cost-efficient-delegation skill's
"Measure it" section is the prototype). Precision comes from method as much
as data.

## Recommended phasing (recommendation, not a decision)

1. **B → A**: days-scale, zero philosophical friction, benefits every
   existing session immediately.
2. **C**: the centerpiece — measured feasible, retroactive, ToS-free.
3. **D / E**: opt-in enrichment; D doubles as C's calibration rig.
4. **F**: once the layers below exist.

The central architectural choice is **C-first (reconstruction as a first-
class citizen, capture as its calibrator) vs D-first (capture as the
foundation, reconstruction as a fallback)**. The recommendation is C-first:
it works retroactively on every existing session and carries no ToS risk.

## Open decisions (for the next stage)

1. C-first vs D-first (above).
2. Does the quantitative-data principle admit labeled `disk-contingent` /
   `template` values, or must MCP output stay strictly log-derived (in which
   case C's scope shrinks to attachment-rebuildable blocks)?
3. CLAUDE.md/memory drift: accept disk-contingent labels, or have junrei
   snapshot those files at observation time (a watcher — new moving part)?
4. Template library logistics: per-CLI-version system-prompt/tool captures
   are Anthropic-authored text — **they can be captured and stored locally by
   the user but must not be redistributed in the junrei repo**. Templates
   would be user-local artifacts (e.g. `~/.junrei/templates/<version>/`),
   possibly auto-captured via D. Confirm this framing.
5. MCP surface growth vs the "few, high-leverage tools" philosophy: add
   drill-down tools (A), or keep raw access HTTP-only and teach agents the
   HTTP route?
6. Capture-proxy (D) product stance: opt-in UX, warning copy for
   subscription users, storage/retention, redaction guarantees.
7. OTel endpoint (E) placement (same Hono server vs sidecar), storage
   format, retention.
8. `sourceCompleteness` schema (B): per-response vs per-field, and how it
   composes with `costIsComplete`.
9. Promote the reconstruction/stability scripts (currently session-scratchpad
   one-offs) into `experiments/` with fixture-based tests, so C's rules are
   executable documentation rather than prose.

## Evidence assets

- In-repo: [`experiments/claude-code-capture/`](../../experiments/claude-code-capture/)
  (capture proxy, OTLP collector, scenario runner, digest),
  [completeness study](../research/claude-code-session-log-completeness.md).
- Session-scratchpad (ephemeral, numbers preserved above): reconstruction
  comparer + stability comparer scripts, two capture runs
  (`2026-07-18T07-07-11.500Z`, `2026-07-18T08-24-15.027Z`), evidence and
  digest reports. Open decision #9 covers promoting these into the repo.
