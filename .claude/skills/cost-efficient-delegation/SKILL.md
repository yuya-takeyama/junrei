---
name: cost-efficient-delegation
description: Cost-efficient model delegation playbook. Use BEFORE spawning subagents (Agent tool) or workflows, when starting research/exploration/multi-step implementation, or when the user mentions cost, model selection, or "Fable is expensive". Guides which model + effort to pass per task so an expensive orchestrator (Fable 5) delegates execution to cheaper models.
---

# Cost-Efficient Model Delegation

The session's main model (often Claude Fable 5) is the **orchestrator**: it plans,
decomposes, judges, and verifies. Execution should be **delegated to the cheapest
model that can do the job well**. Every `Agent(...)` / `Workflow agent(...)` call
that omits `model` inherits the expensive session model — that is almost never
what you want for routine execution.

## Pricing (per MTok, cached 2026-06 — verify via claude-api skill if it matters)

| Model | Input | Output | vs Fable |
|---|---|---|---|
| Claude Fable 5 (`fable`) | $10 | $50 | 1.0× |
| Claude Opus 4.8 (`opus`) | $5 | $25 | 0.5× |
| Claude Sonnet 5 (`sonnet`) | $3 ($2 intro → 2026-08-31) | $15 ($10 intro) | 0.3× (0.2× intro) |
| Claude Haiku 4.5 (`haiku`) | $1 | $5 | 0.1× |

Subagents burn most of their tokens on cache reads and outputs while exploring —
in a real Junrei dev session, 4 research subagents left on Fable cost ~$8 of a
$40 session. The same work on Sonnet would have been ~$2.5.

## Decision table — model + effort per delegated task

Pass these via `Agent` tool `model:` param, or `agent(prompt, {model, effort})`
in Workflow scripts:

| Delegated task | model | effort |
|---|---|---|
| File/codebase exploration, "find where X is" | `haiku` | low |
| Web research, doc summarization, log analysis | `sonnet` | medium |
| Mechanical edits, codemods, test scaffolding | `sonnet` | low |
| Feature implementation with clear spec | `sonnet` | high |
| UI/preview verification of a change | `sonnet` via `preview-verifier` agent | medium |
| Hard implementation, tricky debugging | `opus` | high/xhigh |
| Adversarial verification, independent review | `opus` (fresh context matters more than tier) | high |
| Architecture decisions, ambiguous planning | keep on orchestrator (or `opus` xhigh) | — |

Rules of thumb:

- **Never omit `model` on a delegated call** unless the subtask genuinely needs
  orchestrator-tier reasoning. Omitting = inheriting the expensive model.
- **Well-specified prompts downgrade well.** A cheaper model with an explicit,
  self-contained prompt (inputs, steps, output format) beats a vague prompt on
  a stronger model. Spend orchestrator tokens on writing the spec, not on
  executing it.
- **Verify cheap, escalate on failure.** If a Sonnet/Haiku subagent returns
  something wrong or empty, re-run that one subtask on the next tier up —
  cheaper than starting everything on the top tier.
- **Keep judgment at the top.** Final review of merged results, correctness
  claims, and anything user-facing stays with the orchestrator.
- **Keep images out of the orchestrator context.** Screenshots and DOM dumps
  taken in the main loop are re-read (at top-tier cache prices) by every
  subsequent message. Delegate preview/UI verification to the
  `preview-verifier` agent (`.claude/agents/preview-verifier.md`, pinned to
  Sonnet) and consume its text verdict; in the acca8a8c session, main-loop
  preview driving contributed to a $58 orchestrator bill on a $94 session.

## Session-level setup (for the human, not the agent)

Mechanisms the user can set up outside the session — mention them when the user
asks how to make this stick:

- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet claude` — pins ALL subagents to one model.
  **Highest precedence: it overrides per-call `model` params and agent
  frontmatter.** Blunt but zero-config. Don't combine with per-call tuning —
  the env var wins and silently ignores per-call choices.
- `--append-system-prompt "Delegate execution to subagents with explicit
  instructions and appropriate cheaper models; you do oversight and planning."`
  — session-wide delegation policy without editing CLAUDE.md.
- **Advisor strategy** (cheap main + strong advisor): `claude --model sonnet
  --advisor fable` or `/advisor fable`. Note: with Fable as the MAIN model the
  only allowed advisor is Fable itself — the advisor pattern requires
  downgrading the main model.
- **opusplan**: `/model opusplan` — Opus in plan mode, Sonnet in execution.
- Custom agents: set `model: sonnet` / `model: haiku` in
  `.claude/agents/*.md` frontmatter for standing roles.
- Skills can pin `effort:` in frontmatter (not `model:`).

Precedence for subagent model: `CLAUDE_CODE_SUBAGENT_MODEL` > Agent-tool
`model` param > agent frontmatter `model:` > inherit session model.

## Measure it

This repo IS the measuring tool. After a session, check the actual spend:

- Junrei UI → session detail → "Cost by model" and "Subagent tree" (per-agent
  model + cost).
- Junrei MCP → `get_subagent_tree` / `get_session_summary` for the same data
  programmatically — use it to check whether delegation actually shifted spend
  off the top-tier model, then adjust this table from evidence.
