---
name: cost-efficient-delegation
description: Cost-efficient model delegation playbook for Claude Code and Codex. Use BEFORE spawning subagents or workflows, when starting research/exploration/multi-step implementation, or when discussing cost or model selection. Routes Claude Fable/Opus/Sonnet/Haiku per call, and Codex GPT-5.6 Sol/Terra/Luna via predefined .codex/agents roles plus per-call overrides. Loading it for delegation work commits the main loop to plan/integrate/review only.
---

# Cost-Efficient Model Delegation

The strongest session model is the **orchestrator**: it plans, decomposes,
judges, and verifies. Delegate execution to the cheapest model that can do the
job well, but only through controls the current harness actually exposes.

**Diagnose before you prescribe.** When a session (yours or another's) is
already expensive, classify it by main-loop cost share FIRST, then pick levers
— see `docs/cost-playbook.md` (MARATHON main ≥85% → cap context lifetime,
one PR per session; FAN-OUT main ≤55% → drop the subagent tier and bound
turns). The measured evidence behind every rule below lives in that playbook
and its linked study.

## Route by harness

The two harnesses route models in opposite ways — read the matching reference
before the first delegation of a session:

- **Claude Code** (`Agent` tool / Workflow `agent(...)`): routing is
  **per call** — pass an explicit `model` (+ `effort`) on every delegated
  call. Mechanics, precedence, and gotchas: `references/claude-code.md`.
- **Codex** (`collaboration.spawn_agent`): two controls. For standing chores,
  spawn a **predefined role** from `.codex/agents/*.toml` via `agent_type` —
  a role applies instructions, sandbox, model, and reasoning effort in one
  place. For one-off routing that no role covers, pass the per-call `model` /
  `reasoning_effort` **overrides** on `spawn_agent`. Either way, always pass
  `fork_turns: "none"` (or a small number) with a self-contained prompt — the
  default `"all"` rejects both `agent_type` and overrides. This repo's roles,
  spawn mechanics, and fallbacks: `references/codex.md`.
- A model selector on the parent session (`codex --model ...`, an app model
  picker, project config) does not prove what a child ran. Verify the
  recorded model in Junrei after delegation (see Measure it).

## Skill contract

When this skill is loaded for delegation work — about to spawn workers, or
asked to delegate — that load **is** the delegation decision, and the
orchestrator commits to the terms below. Loading it merely to answer a cost
or routing question commits to nothing.

- **Main loop = planning, integration, review.** Beyond the trivia
  carve-out below, the orchestrator does not edit files, run gates, or
  drive browsers itself.
- **One PR per session for an orchestrator.** A multi-PR marathon on one
  session never compacts and the context climbs to 400–650K, which becomes the
  single biggest cost line. Split each PR into its own session (or compact once
  per PR); alarm above 200K context.
- **State a turn budget in every spawn prompt** — a target of ~60 tool calls.
  cacheRead scales with a subagent's turn count, not its token price: a
  252-tool-call implementer accumulated 88.4M cacheRead. Treat any worker over
  150 tool calls as a design failure to revisit, not a normal run.
- **One implementer per work item.** Clear implementation goes to a single
  implementation-tier worker with a self-contained prompt; split across
  workers only when the pieces are truly independent.
- **UI verification goes to `preview-verifier`; commit/push/PR/CI chores go
  to `pr-shepherd`.** Both harnesses define these as standing roles. Point
  pr-shepherd-style chores at `scripts/ship-pr.mjs` (branch→commit→rebase→push→
  draft PR→CI-watch, no merge) and run quality gates once via `pnpm gate`
  (`scripts/gate.mjs`) rather than re-deriving either procedure per session.
- **Do not delegate trivia.** A task the orchestrator finishes in about five
  tool calls (a one-line fix, a quick status check, reading one file) costs
  less inline than the spawn overhead plus handoff.
- **At most 2 concurrent workers by default**; go wider only on explicit
  user intent (a user-invoked fan-out skill or workflow counts). Nested
  spawning is forbidden — the standing role definitions already say so;
  repeat it only in prompts for role-less workers (generic agents, per-call
  overrides).
- **Workers return conclusions, not context**: verdicts, summaries, and
  file:line pointers — never raw logs, DOM dumps, screenshots, or full
  search output.
- **Workers read files with the dedicated tools.** Every spawn prompt for a
  role-less worker must state: use Read/Grep/Glob for file access, never
  `cat`, `sed -n`, or `grep` through Bash. Bash file dumps arrive uncapped
  (a single `cat` of a fixture can cost tens of thousands of chars inside a
  review agent), while the dedicated tools bound output and let the harness
  track what was already read. Junrei flags violations: check
  `get_bash_stats` -> `waste.bashAsRead` after delegation-heavy sessions.

## Pricing

Per-MTok rates below are cached guidance — when exact cost matters, verify
against Junrei's pricing snapshot at
`packages/core/src/shared/pricing/prices.json`.

### Claude family

| Model | Input | Output | vs Fable |
|---|---:|---:|---:|
| Claude Fable 5 (`fable`) | $10 | $50 | 1.0x |
| Claude Opus 4.8 (`opus`) | $5 | $25 | 0.5x |
| Claude Sonnet 5 (`sonnet`) | $2 | $10 | 0.2x |
| Claude Haiku 4.5 (`haiku`) | $1 | $5 | 0.1x |

On a fat main context, cache writes can be the single largest line item —
multipliers and a measured example are in `references/claude-code.md`.

**Tier the subagent by task risk, not by default to the top.** Measured per
subagent: opus ≈ $0.13/msg vs sonnet ≈ $0.027/msg (5×) — in one fan-out session
the opus workers alone were $99 (48% of a $208 session). So: **opus for
adversarial review and genuinely hard debugging only** (the two rows the
decision table still routes to opus); routine implementation, verification, and
inventory go to sonnet (14-day baseline 98.7% success / $1.85); exploration and
scouting go to haiku ($0.23). Whether opus→sonnet review loses catch-rate is not yet verified,
so keep adversarial review on opus until it is.

### Codex GPT-5.6 family

| Model | Input | Output | vs Sol | Role |
|---|---:|---:|---:|---|
| GPT-5.6 Sol (`gpt-5.6-sol`) | $5 | $30 | 1.0x | Orchestrator and hardest reasoning |
| GPT-5.6 Terra (`gpt-5.6-terra`) | $2.50 | $15 | 0.5x | Default implementation/research worker |
| GPT-5.6 Luna (`gpt-5.6-luna`) | $1 | $6 | 0.2x | Fast scout and mechanical worker |

Subagents spend many tokens reading context and returning results. Four broad
workers on the orchestrator model can erase the benefit of parallelism even
when their individual tasks are easy.

## Decision table

The Claude column is the `model` to pass per call; the Codex column is the
role (from `.codex/agents/`) to spawn — each role pins its own model and
effort (see `references/codex.md`). The effort column is the Claude-side
value.

| Delegated task | Claude | Codex role | effort |
|---|---|---|---|
| File/codebase exploration, find where X is | `haiku` | `scout` | low |
| Simple summarization, classification, status lookup | `haiku` | `scout` | low |
| Mechanical edits, formatting, lint fixes | `sonnet` | `mechanic` | low |
| Web research, docs synthesis, log analysis | `sonnet` | `researcher` | medium |
| Test scaffolding and routine test repair | `sonnet` | `implementer` | medium |
| Feature implementation with a clear spec | `sonnet` | `implementer` | high |
| UI/preview verification | `sonnet` (preview-verifier) | `preview-verifier` | medium |
| Commit/push/PR/CI-watch chores | `sonnet` (pr-shepherd) | `pr-shepherd` | low |
| Hard implementation or tricky debugging | `opus` | `expert` | xhigh |
| Adversarial review from fresh context | `opus` | `reviewer` | high |
| Architecture or ambiguous planning | keep on orchestrator | keep on orchestrator | xhigh |

Rules of thumb:

- **Well-specified prompts downgrade well.** Give a bounded objective, exact
  inputs, constraints, verification steps, and a compact output format.
- **Verify cheap, then escalate.** Retry only the failed subtask on the next
  tier instead of starting every worker on the strongest model.
- **Keep judgment at the top.** Final review, correctness claims, integration
  decisions, and user-facing conclusions stay with the orchestrator.
- **Delegate breadth, not dependency chains.** Parallel agents help when tasks
  are independent. Sequential handoffs add context and coordination cost.
- **A fat main context is a recurring per-turn cost, not a one-time one.**
  Every main-loop tool call re-reads the entire context at orchestrator
  prices, and each later user turn re-writes the cache tail after prior-turn
  thinking blocks are stripped. This is why the skill contract hands
  implementation to a worker with a self-contained prompt (objective, file
  list, constraints, which gates to run) and keeps the orchestrator to
  plan-before / review-after.
- **Never explore in parallel with your own scout.** After launching an
  Explore agent, wait for its report, then read only the files you will
  actually edit. Reading the same files in both threads pays twice and
  permanently fattens the main context.
- **Warm the cache before a fan-out.** A cache entry only becomes usable after
  the first response begins, so N workers spawned simultaneously onto a cold
  shared prefix each pay full cache-write price (1.25–2× base) instead of the
  0.1× read price. Launch one worker first to warm the shared prefix, then fan
  out the rest — the write pays for itself after 1–2 re-reads, but only within
  the cache TTL.

## Measure it

This repo is the measuring tool. After significant delegation, check:

- Junrei UI -> session detail -> **Cost by model** and **Subagent tree**.
- Junrei MCP -> `get_subagent_tree` / `get_session_summary`.
- Junrei MCP -> `get_trends` for delegation share, cache hit rate, and
  subagent-return-size trends across multiple days.
- For Codex, compare the intended role's pinned model with the model recorded
  on each child; the observed model, not the prompt wording or the role name,
  is the source of truth.

Use the measured model mix, cost, return size, and duplicated exploration to
adjust future routing. A cheaper model with a precise prompt is the target;
more agents are not automatically more efficient. A measured Claude Code
example is in `references/claude-code.md`.
