---
name: cost-efficient-delegation
description: Cost-efficient model delegation playbook for Claude Code and Codex. Use BEFORE spawning agents or workflows, when starting research/exploration/multi-step implementation, or when discussing cost or model selection. Routes Claude Fable/Opus/Sonnet/Haiku and Codex GPT-5.6 Sol/Terra/Luna without inventing unsupported tool parameters.
---

# Cost-Efficient Model Delegation

The strongest session model is the **orchestrator**: it plans, decomposes,
judges, and verifies. Delegate execution to the cheapest model that can do the
job well, but only through controls the current harness actually exposes.

## Detect the harness before delegating

- **Claude Code** uses `Agent(...)` / `Workflow agent(...)`. Pass an explicit
  `model` and `effort` on every delegated call unless the task genuinely needs
  the orchestrator tier.
- **Codex** uses `spawn_agent` (multi-agent v2). The routing fields exist
  upstream but are schema-gated by feature flags: `agent_type`/`service_tier`
  appear only with `features.multi_agent_v2.hide_spawn_agent_metadata = false`
  (this repo sets it in `.codex/config.toml`), and `model`/`reasoning_effort`
  appear only on builds with `expose_spawn_agent_model_overrides` (default-on
  since rust-v0.145.0-alpha.7, 2026-07-13). Read the schema exposed in the
  current session and use only what is actually there — never pass
  unsupported arguments or claim a cheaper child model without evidence.
- A model selector on the parent session (`codex --model ...`, a Codex app
  model picker, or project config) does not prove that a particular child used
  that model. Verify the recorded model in Junrei after delegation.

## Pricing

Per-MTok rates below are cached guidance. Verify the current source when exact
cost matters. Rates come from Junrei's pricing snapshot at
`packages/core/src/shared/pricing/prices.json`; Claude rates were cross-checked
against measured session costs on 2026-07-13.

### Claude family

| Model | Input | Output | vs Fable |
|---|---:|---:|---:|
| Claude Fable 5 (`fable`) | $10 | $50 | 1.0x |
| Claude Opus 4.8 (`opus`) | $5 | $25 | 0.5x |
| Claude Sonnet 5 (`sonnet`) | $2 | $10 | 0.2x |
| Claude Haiku 4.5 (`haiku`) | $1 | $5 | 0.1x |

Cache economics (all Claude tiers): cache read = 0.1x input; cache write =
1.25x input at 5-minute TTL, 2x input at 1-hour TTL — the Claude Code main
loop uses 1-hour writes ($20/MTok on Fable). On a fat main context, cache
writes can be the single largest line item (see Measure it).

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

On Codex, pass the Codex column through spawn_agent's `model` /
`reasoning_effort` params when the live schema exposes them (default from
rust-v0.145.0-alpha.7), always with a partial fork (`fork_turns: "none"` or a
numeric value). Built-in roles reachable via `agent_type` pin no model on
their own (see Codex controls below).

| Delegated task | Claude | Codex | effort |
|---|---|---|---|
| File/codebase exploration, find where X is | `haiku` | `gpt-5.6-luna` | low |
| Simple summarization, classification, status lookup | `haiku` | `gpt-5.6-luna` | low |
| Mechanical edits, formatting, lint fixes | `sonnet` | `gpt-5.6-luna` | low |
| Web research, docs synthesis, log analysis | `sonnet` | `gpt-5.6-terra` | medium |
| Test scaffolding and routine test repair | `sonnet` | `gpt-5.6-terra` | medium |
| Feature implementation with a clear spec | `sonnet` | `gpt-5.6-terra` | high |
| UI/preview verification | `sonnet` | `gpt-5.6-terra` | medium |
| Commit/push/PR/CI-watch chores | `sonnet` | `gpt-5.6-luna` | low |
| Hard implementation or tricky debugging | `opus` | `gpt-5.6-sol` | high/xhigh |
| Adversarial review from fresh context | `opus` | `gpt-5.6-sol` | high |
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
- **Return conclusions, not raw context.** Screenshots, DOM dumps, full logs,
  and large search results stay in the worker context.
- **Once the spec is clear, the orchestrator stops touching files.** Hand the
  whole implementation to a worker on the implementation tier the decision
  table picks for the current harness — never the orchestrator model — with a
  self-contained prompt (objective, file list, constraints, which gates to
  run); the orchestrator plans before and reviews the diff after. Every
  main-loop tool call re-reads the entire context at orchestrator prices, and
  each later user turn re-writes the cache tail after prior-turn thinking
  blocks are stripped — a fat main context is a recurring per-turn cost, not
  a one-time one.
- **Never explore in parallel with your own scout.** After launching an
  Explore agent, wait for its report, then read only the files you will
  actually edit. Reading the same files in both threads pays twice and
  permanently fattens the main context.

## Claude Code controls

Pass the model through the `Agent` tool's `model` parameter or
`agent(prompt, {model, effort})` in Workflow scripts. For standing roles, keep
the model in agent frontmatter:

- UI verification: `sonnet` via `.claude/agents/preview-verifier.md`.
- Commit, rebase, push, PR, and CI watch: `sonnet` via
  `.claude/agents/pr-shepherd.md`.

Never omit `model` unless the delegated task needs orchestrator-tier reasoning.
Omitting it inherits the expensive session model.

Precedence for a Claude Code subagent model:
`CLAUDE_CODE_SUBAGENT_MODEL` > Agent-tool `model` > agent frontmatter `model` >
inherit session model.

## Codex controls and fallback

Model routing on Codex, in order of preference:

1. **Direct overrides** (default-exposed from rust-v0.145.0-alpha.7): when
   the live schema shows `model`/`reasoning_effort`, pass the GPT-5.6 choice
   from the decision table. Slugs are validated against the live models list
   at spawn time.
2. **Roles via `agent_type`** (visible because `.codex/config.toml` sets
   `hide_spawn_agent_metadata = false`): the built-in `explorer` is a
   read-only scout and `worker` an execution role, but built-ins pin no
   model — combine them with the direct overrides above. If spawn-time
   params prove insufficient (e.g. a build without them), custom role TOMLs
   under `.codex/agents/*.toml` (`name`, `description`,
   `developer_instructions`, plus `model` / `model_reasoning_effort` /
   `sandbox_mode`) can pin a tier per role and override same-name built-ins;
   this repo deliberately starts without committed role files.
3. **No overrides exposed** (older builds): the child inherits the parent's
   live-turn model. Do not spawn merely to obtain a cheaper tier — spawn
   only for real parallelism or context isolation, and do not claim
   model-tier savings.

Constraints that apply to 1 and 2 — a violation makes Codex reject the spawn
or silently keep the parent model:

- **A full-history fork rejects overrides.** `fork_turns: "all"` (the
  default) forces the parent's model; always pass `fork_turns: "none"` for a
  self-contained prompt or a small numeric value for recent context when
  using `agent_type`/`model`/`reasoning_effort`.
- **Keep the task bounded.** One objective, relevant paths, constraints,
  verification, and a text-only result contract. Ask for summaries instead
  of raw tool output.
- **Escalate by restarting the bounded task on Sol**, not by moving the whole
  workflow to Sol, when Luna/Terra fails for a reasoning-related cause.
- **Prefer a cheaper parent for routine standalone work.** When the user
  explicitly authorizes a separate task/session, select `gpt-5.6-luna` or
  `gpt-5.6-terra` at task creation instead of spawning from an expensive
  parent.

Whatever the route, verify the recorded child model in Junrei afterwards and
report it when cost is material — the rollout, not the prompt wording, is the
source of truth.

## Session-level setup for humans

### Claude Code

- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet claude` pins all subagents. It overrides
  per-call and frontmatter choices, so do not combine it with per-call tuning.
- Use `--append-system-prompt` for a session-wide delegation policy.
- An advisor or `opusplan` setup can keep planning strong while execution uses
  a cheaper tier.

### Codex

- Start a routine worker session with `codex --model gpt-5.6-terra` or
  `codex --model gpt-5.6-luna`; reserve `gpt-5.6-sol` for orchestration and the
  hardest tasks.
- This repo's `.codex/config.toml` sets
  `[features.multi_agent_v2] hide_spawn_agent_metadata = false` to expose the
  `agent_type` selector; mirror it into `~/.codex/config.toml` for other
  repos. Custom role TOMLs (`.codex/agents/` or `~/.codex/agents/`) that pin
  `model`/`model_reasoning_effort` remain available if spawn-time params are
  not enough.
- Re-check the spawn_agent schema after Codex upgrades: `model` /
  `reasoning_effort` become directly available with
  `expose_spawn_agent_model_overrides` (default-on from
  rust-v0.145.0-alpha.7).

## Measure it

This repo is the measuring tool. After significant delegation, check:

- Junrei UI -> session detail -> **Cost by model** and **Subagent tree**.
- Junrei MCP -> `get_subagent_tree` / `get_session_summary`.
- For Codex, compare the intended tier with the model recorded on each child;
  the observed model — not the prompt wording or the role file — is the
  source of truth.

Use the measured model mix, cost, return size, and duplicated exploration to
adjust future routing. A cheaper model with a precise prompt is the target;
more agents are not automatically more efficient.

Measured example (Claude Code session `621c4c87`, 2026-07-13, shipped PR #78):
chore delegation was exemplary — Haiku Explore, Sonnet preview-verifier, and
Sonnet pr-shepherd moved 39% of tokens for 4.9% of cost — yet the session
still cost $23.5 because implementation stayed in the Fable main loop (95% of
spend; half of that was cache writes on a ~220k context, and the main loop
duplicated its own Explore agent's reads). The two rules above ("orchestrator
stops touching files", "never explore in parallel with your own scout") come
from that session.
