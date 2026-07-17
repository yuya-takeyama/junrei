---
name: cost-efficient-delegation
description: Cost-efficient model delegation playbook for Claude Code and Codex. Use BEFORE spawning agents or workflows, when starting research/exploration/multi-step implementation, or when discussing cost or model selection. Routes Claude Fable/Opus/Sonnet/Haiku per call and Codex GPT-5.6 Sol/Terra/Luna via predefined .codex/agents roles.
---

# Cost-Efficient Model Delegation

The strongest session model is the **orchestrator**: it plans, decomposes,
judges, and verifies. Delegate execution to the cheapest model that can do the
job well, but only through controls the current harness actually exposes.

## Route by harness

The two harnesses route models in opposite ways — read the matching reference
before the first delegation of a session:

- **Claude Code** (`Agent` tool / Workflow `agent(...)`): routing is
  **per call** — pass an explicit `model` (+ `effort`) on every delegated
  call. Mechanics, precedence, and gotchas: `references/claude-code.md`.
- **Codex** (`collaboration.spawn_agent`): the spawn call does **not** take a
  model — routing happens through **predefined roles** in
  `.codex/agents/*.toml`, each pinning `model` and reasoning effort, selected
  at spawn time. This repo's roles, spawn mechanics, and the no-roles
  fallback: `references/codex.md`.
- A model selector on the parent session (`codex --model ...`, an app model
  picker, project config) does not prove what a child ran. Verify the
  recorded model in Junrei after delegation (see Measure it).

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

The Claude column is the `model` to pass per call; the Codex column is the
role (from `.codex/agents/`) to spawn — each role pins its own model and
effort, shown for reference. The effort column is the Claude-side value.

| Delegated task | Claude | Codex role | effort |
|---|---|---|---|
| File/codebase exploration, find where X is | `haiku` | `scout` (luna) | low |
| Simple summarization, classification, status lookup | `haiku` | `scout` (luna) | low |
| Mechanical edits, formatting, lint fixes | `sonnet` | `mechanic` (luna) | low |
| Web research, docs synthesis, log analysis | `sonnet` | `researcher` (terra) | medium |
| Test scaffolding and routine test repair | `sonnet` | `implementer` (terra) | medium |
| Feature implementation with a clear spec | `sonnet` | `implementer` (terra) | high |
| UI/preview verification | `sonnet` (preview-verifier) | `preview-verifier` (terra) | medium |
| Commit/push/PR/CI-watch chores | `sonnet` (pr-shepherd) | `pr-shepherd` (luna) | low |
| Hard implementation or tricky debugging | `opus` | `expert` (sol) | high/xhigh |
| Adversarial review from fresh context | `opus` | `reviewer` (sol) | high |
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

## Measure it

This repo is the measuring tool. After significant delegation, check:

- Junrei UI -> session detail -> **Cost by model** and **Subagent tree**.
- Junrei MCP -> `get_subagent_tree` / `get_session_summary`.
- For Codex, compare the intended role's pinned model with the model recorded
  on each child; the observed model, not the prompt wording or the role name,
  is the source of truth.

Use the measured model mix, cost, return size, and duplicated exploration to
adjust future routing. A cheaper model with a precise prompt is the target;
more agents are not automatically more efficient. A measured Claude Code
example is in `references/claude-code.md`.
