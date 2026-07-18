# Milestone proposal: Goshuin (御朱印) — evidence-grade agent analysis over Junrei MCP

**Status: SHIPPED** (2026-07-18). All six phases (B → A → C → D/E → F) are
merged — PR 124 through PR 127, PR 129, PR 130, and PR 133, and PR 135 for
phase F (evaluation-trace export + the `junrei-session-analysis` playbook
skill). The centerpiece reconstruction layer (phase C) is calibrated at
92.95% exact+template coverage of wire bytes on capture run A (acceptance
bar ≥ 85% — see "Production calibration" below), and the milestone's
acceptance test — an evidence-grade session analysis produced by a
fresh-context, MCP-only agent — passed. This document records the insights,
verified evidence, and candidate approaches for the milestone. All nine open
decisions were settled with Yuya on 2026-07-18 — see
[Decisions](#decisions-2026-07-18). Implementation proceeded in the adopted
phase order (B → A → C → D/E → F) and is tracked in
[the roadmap](../roadmap.md) (now archived to
[roadmap-archive.md](../roadmap-archive.md)).

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
- **Production calibration (2026-07-18, phase C ship)**: the shipped
  `@junrei/core` reconstruction, driven by
  `experiments/claude-code-capture/recon/compare.mjs` against capture run A
  with a template extracted from the same run — exact-class bytes 98.55%
  matched (sole mismatch: the documented task-notification safety-preamble
  anomaly, declared per-block), template 100%, disk-contingent 100% (a real
  post-session `~/.claude.json` change correctly flagged `driftDetected`),
  unknown 0% (billing headers, declared unrecoverable). Headline
  exact+template coverage: **92.95% of wire bytes** (acceptance bar ≥ 85%).

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
asserted. Decision #2 below accepts this reasoning: labeled
non-log-derived values are admitted.

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

## Adopted phasing (decision #1)

1. **B → A**: days-scale, zero philosophical friction, benefits every
   existing session immediately.
2. **C**: the centerpiece — measured feasible, retroactive, ToS-free.
3. **D / E**: opt-in enrichment; D doubles as C's calibration rig.
4. **F**: once the layers below exist.

The central architectural choice was **C-first (reconstruction as a first-
class citizen, capture as its calibrator) vs D-first (capture as the
foundation, reconstruction as a fallback)**. Decided: C-first — it works
retroactively on every existing session and carries no ToS risk.

## Decisions (2026-07-18)

All nine open decisions were settled with Yuya on 2026-07-18. Numbering
matches the open-decision list this section replaces (the questions are
restated inline).

1. **C-first vs D-first → C-first.** Reconstruction is the first-class
   citizen; wire capture (D) is its opt-in calibrator, added later.
   Rationale: C works retroactively on every existing session and carries
   zero ToS exposure, while D only covers future sessions with capture
   enabled; the measured reconstruction fidelity (85.2% byte-exact, 99.0%
   after the four mechanical normalization rules, 0% missing with disk
   access) makes C viable without ground-truth capture.

2. **Labeled non-log-derived values → admitted.** Every reconstructed block
   must carry a confidence class (`exact` / `template` / `disk-contingent` /
   `unknown`); under that labeling, `template` and `disk-contingent` values
   may appear in MCP output. Rationale: the quantitative-data principle's
   core — deterministic rules, no LLM judgment — is fully preserved; what
   changes is that provenance becomes explicit per block instead of the
   implicit "everything is log-derived". Silent assertion stays forbidden;
   labeled derivation is not judgment.

3. **CLAUDE.md/memory drift → `disk-contingent` label + mtime hint, no
   watcher.** Disk-rebuilt blocks carry the confidence label plus a
   machine-readable `driftDetected` flag derived from comparing the file's
   mtime against the session's timestamps (a file modified after the
   session started may differ from what the session actually saw).
   Rationale: near-zero implementation cost and no standing watcher
   process; a snapshot watcher would be a new moving part that still misses
   every session run while junrei is down.

4. **Template library → user-local artifacts, confirmed.** Per-CLI-version
   system-prompt/tool-schema captures are Anthropic-authored text: users
   capture and store them locally under `~/.junrei/templates/<cli-version>/`
   (later auto-captured via D), and they are **never redistributed in the
   junrei repo**. The repo commits only extraction/verification logic and
   anonymized synthetic fixtures. When no template exists for a session's
   CLI version, the affected blocks degrade to `unknown` with the absence
   declared.

5. **MCP surface → add drill-down tools.** `get_records` and
   `get_tool_call` join the MCP surface (9 → 11 tools) rather than keeping
   raw access HTTP-only. Rationale: evidence access is itself high-leverage,
   so this extends rather than violates the "few, high-leverage tools"
   philosophy; MCP-only environments (e.g. remote agents) would otherwise
   have no path to evidence, and the milestone's acceptance test — an
   analysis report produced over MCP alone — requires it.

6. **Capture proxy (D) → constraints decided now, UX at build time.**
   Committed constraints: local-only (never hosted), explicit opt-in (env
   var + launch flag), auth headers redacted at write time, mandatory ToS
   warning copy for subscription users, storage under `~/.junrei/captures/`,
   retention user-managed. Detailed UX (warning copy, command surface,
   rotation) is designed when D starts.

7. **OTel endpoint (E) → same Hono server, JSONL storage.** The OTLP
   http/json receiver (validated at ~60 lines in the experiment) lands in
   the existing junrei server process; events are stored as per-`session.id`
   JSONL under `~/.junrei/otel/`, retention user-managed. Single-process
   fits a local tool; a sidecar adds a moving part with no clear payoff.
   Details re-confirmed when E starts.

8. **`sourceCompleteness` schema (B) → per-response block + exceptional
   per-field flags.** Every MCP response carries a fixed-vocabulary
   per-response block:

   ```jsonc
   sourceCompleteness: {
     source: "claude-session-jsonl",
     dimensions: {
       systemPrompt:   { status: "absent",       note: "not in session log" },
       toolSchemas:    { status: "absent",       note: "action space not recorded" },
       hiddenApiCalls: { status: "not-recorded", note: "aux calls invisible; cost undercounts" },
       cost:           { status: "estimate",     note: "pricing-table; see costIsComplete" },
       thinking:       { status: "partial",      note: "not re-sent in later turns" },
       latency:        { status: "absent" }
     }
   }
   ```

   Existing `costIsComplete` stays as-is for backward compatibility (the
   `cost` dimension references it), and the `costIsComplete` pattern — a
   per-field flag right next to the value — remains the escape hatch for
   values whose completeness varies per response. Full per-field annotation
   everywhere was rejected as response bloat.

9. **Reconstruction/stability scripts → promoted into `experiments/`.**
   The session-scratchpad survived (capture runs A/B plus all scripts); as
   part of phase C, `reconstruct-compare.mjs` / `stability-compare.mjs`
   move into `experiments/claude-code-capture/` with anonymized synthetic
   fixtures that test the reconstruction rules (the four normalization
   rules, attachment rebuilds, template substitution), so C's rules are
   executable documentation rather than prose. Raw captures contain
   personal context: they stay local as the calibration oracle and are
   never committed.

## Evidence assets

- In-repo: [`experiments/claude-code-capture/`](../../experiments/claude-code-capture/)
  (capture proxy, OTLP collector, scenario runner, digest),
  [completeness study](../research/claude-code-session-log-completeness.md).
- Session-scratchpad (ephemeral, numbers preserved above): reconstruction
  comparer + stability comparer scripts, two capture runs
  (`2026-07-18T07-07-11.500Z`, `2026-07-18T08-24-15.027Z`), evidence and
  digest reports. Open decision #9 covers promoting these into the repo.
