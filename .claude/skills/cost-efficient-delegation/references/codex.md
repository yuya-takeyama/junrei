# Codex delegation controls

As of 2026-07-17 the deployed Codex harness exposes **both** routing
controls on `collaboration.spawn_agent`: predefined roles (`agent_type`) and
per-call `model` / `reasoning_effort` overrides. Earlier stable releases
(≤ `rust-v0.144.5`) had roles only — the schema has changed across releases
before, so re-verify after every Codex upgrade (see the bottom section).

## The routing model: roles for standing work, overrides for one-offs

- **Routine, recurring work → spawn a role.** A role TOML applies
  `developer_instructions`, `sandbox_mode`, `model`, and
  `model_reasoning_effort` in one place, so the spawn prompt only has to
  carry the per-task specifics. The decision table in SKILL.md maps task
  types to this repo's roles.
- **One-off special routing → per-call override.** When no role fits, pass
  `model` / `reasoning_effort` directly on `spawn_agent`. An override routes
  the model only — no role instructions or sandbox come with it, so the
  spawn message must carry the full contract (scope, verification, output
  format, "do not spawn other agents").
- Do not stack both for the same purpose: prefer the role; add an override
  on top of `agent_type` only to deviate from the role's pinned tier for one
  call, and say why in the task record.

Role mechanics:

- Project roles: `.codex/agents/*.toml` (this repo defines eight — table
  below). Personal roles: `~/.codex/agents/*.toml`.
- A role file requires `developer_instructions`; `name` and `description` are
  role-specific fields, and any `config.toml` key (`model`,
  `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, …) can be set as an
  overlay for that role.
- A custom role with the same name **shadows** a built-in role. Built-ins:
  `default`, `explorer`, `worker`.

## Spawning — two hard rules

1. **Always pass `fork_turns: "none"` or a small number.** Omitted
   `fork_turns` defaults to `"all"` (full-history fork), and a full-history
   fork **rejects** `agent_type` and the model overrides with an error.
   `"none"` + a self-contained prompt is the default choice; a numeric
   last-N-turns value only when recent context is genuinely required.
2. **Routing needs the V2 spawn surface.** `gpt-5.6-sol` and
   `gpt-5.6-terra` force multi-agent V2 on; **`gpt-5.6-luna` forces V1**, so
   a Luna parent session can select neither roles nor overrides. Other
   models use V1 unless `features.multi_agent_v2.enabled = true` is set.

Call shapes:

```
# Standing chore → role
spawn_agent {
  task_name: "verify sidebar fix",
  agent_type: "preview-verifier",
  fork_turns: "none",
  message: "<self-contained: objective, files, criteria, output contract>"
}

# One-off routing → per-call override
spawn_agent {
  task_name: "classify flaky-test log",
  model: "gpt-5.6-luna",
  reasoning_effort: "low",
  fork_turns: "none",
  message: "<self-contained: full contract — no role instructions apply>"
}
```

Whichever control you used, verify the **recorded** model of each child in
Junrei afterwards (session detail → Subagent tree, or `get_subagent_tree`) —
the observed model, not the role name or the override you passed, is the
source of truth.

## Writing the spawn message — GPT-5.6 prompting essentials

Distilled from OpenAI's GPT-5.6 model guidance
(developers.openai.com → API docs → guides → latest-model, read 2026-07-17):

- **Outcome, not steps.** GPT-5.6 infers the intended level of work from
  context — give goal, domain context, hard constraints, success criteria,
  and output format; do not script every step. Say explicitly what the
  worker should do when it hits ambiguity (decide and note it, or stop and
  report).
- **Lean beats long, state each instruction once.** OpenAI's own
  coding-agent evals scored ~10–15% better with leaner prompts at 33–67%
  lower cost. For roles this means: the standing contract lives in
  `developer_instructions`; the spawn message carries only per-task
  specifics — never repeat the role's rules in the message.
- **One autonomy policy, stated once.** Name the pre-approved safe actions
  (read files, edit in-scope code, run tests/gates) and the few things that
  need escalation (destructive ops, scope expansion, external writes).
  Anti-pattern called out by the guide: scattering "ask first" / "do not
  mutate" reminders causes needless pauses on safe, expected actions.
- **Buy depth with effort, not prompt scaffolding.** Do not write "think
  harder", "try several candidates", or self-reflection rituals — raising
  `reasoning_effort` (tiers: none/low/medium/high/xhigh/max) or pro mode
  does that internally. Pick the tier via the role/decision table; when
  migrating a working prompt, the guide suggests trying one effort level
  lower and comparing — which is this skill's "verify cheap, then escalate".
- **Shape the return explicitly.** Say what to keep (conclusion first,
  evidence, material caveats, next action) and what to trim (repetition,
  intros, generic reassurance). This is how "return conclusions, not raw
  context" is enforced on the worker side.
- **Tool-heavy bounded stages: spell out the routing.** If the worker should
  batch tool work (e.g. GPT-5.6's programmatic tool calling), state which
  stage, which tools, the output schema, and stop/retry limits — generic
  "use tools efficiently" lines do nothing. Keep direct calls wherever each
  result changes the next decision.

## This repo's roles

| Role | Model | Effort | Use for |
|---|---|---|---|
| `scout` | luna | low | Read-only exploration, find-where-X, summaries, status (read-only sandbox) |
| `mechanic` | luna | low | Mechanical edits, formatting, lint fixes from an exact spec |
| `researcher` | terra | medium | Web research, docs synthesis, log analysis |
| `implementer` | terra | high | Feature implementation with a clear spec; test scaffolding/repair |
| `preview-verifier` | terra | medium | UI verification in the dev preview; verdict only, never edits |
| `pr-shepherd` | luna | low | Commit → rebase → push → draft PR → CI watch (→ authorized merge) |
| `expert` | sol | xhigh | Escalation: hard implementation, tricky debugging |
| `reviewer` | sol | high | Adversarial review from fresh context (read-only sandbox) |

Escalate by re-spawning the failed bounded subtask as `expert` — do not move
the whole workflow to Sol, and do not retry the same prompt on the same role
expecting a different outcome.

## Fallback when neither roles nor overrides are selectable

On a V1 surface (Luna parent, or `agent_type` / the override params absent
for any reason), the child inherits the parent's live-turn model and no
cheaper tier can be claimed:

1. **Do not spawn merely to obtain a cheaper tier** — spawn only for real
   parallelism or context isolation.
2. Keep the task bounded: one objective, relevant paths, constraints,
   verification, text-only result contract.
3. Prefer a cheaper parent for routine standalone work: when the user
   authorizes a separate task/session, start it as `gpt-5.6-luna` or
   `gpt-5.6-terra` instead of spawning under Sol.
4. Report the actual recorded child model (from Junrei) when cost is material
   — never claim a tier the call could not control.

## Adding or changing roles

Minimal role file (`.codex/agents/<name>.toml`):

```toml
name = "scout"
description = "Read-only scout for exploration and status lookups."
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
sandbox_mode = "read-only"   # optional overlay; omit to inherit

developer_instructions = """
Bounded role instructions + report contract. Forbid nested spawning.
"""
```

Pick the tier from the decision table in SKILL.md. Keep
`developer_instructions` about the role contract (scope, verification, output
format, "do not spawn other agents") — per-task specifics belong in the spawn
message.

## Session-level setup for humans

- Start routine worker sessions with `codex --model gpt-5.6-terra` or
  `codex --model gpt-5.6-luna`; reserve `gpt-5.6-sol` for orchestration and
  the hardest tasks. Remember: a Luna parent can select neither roles nor
  overrides (V1).
- `[profiles.*]` in config.toml do not re-apply to children; children inherit
  the parent's live-turn model unless a role pins one.

## After upgrades

The spawn_agent schema has changed across releases: per-call overrides were
absent on stable ≤ `rust-v0.144.5` and arrived later via
`features.multi_agent_v2.expose_spawn_agent_model_overrides` (default-on
where present). After each Codex upgrade, re-check the live spawn_agent
schema before assuming either control exists, and keep verifying the
recorded child model in Junrei rather than trusting the schema, the role
name, or the override you passed.
