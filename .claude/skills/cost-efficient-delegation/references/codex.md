# Codex delegation controls

Facts below were source-verified against `openai/codex` at stable
`rust-v0.144.5` and the official subagents docs on 2026-07-17. Re-verify after
Codex upgrades (see "After upgrades" at the bottom).

## The routing model: predefined roles, not per-call params

On stable Codex, `spawn_agent` does **not** accept `model` or
`reasoning_effort` — the flag that exposes them
(`features.multi_agent_v2.expose_spawn_agent_model_overrides`) first shipped
in `0.145.0-alpha.7` and is not in any stable release. Model routing therefore
happens through **predefined agent roles**: TOML files that pin `model` and
`model_reasoning_effort`, selected at spawn time via `agent_type`.

- Project roles: `.codex/agents/*.toml` (this repo defines eight — table
  below). Personal roles: `~/.codex/agents/*.toml`.
- A role file requires `developer_instructions`; `name` and `description` are
  role-specific fields, and any `config.toml` key (`model`,
  `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, …) can be set as an
  overlay for that role.
- A custom role with the same name **shadows** a built-in role. Built-ins:
  `default`, `explorer`, `worker`.
- `agent_type` appears in the spawn_agent schema **automatically once at
  least one custom role exists** — no feature flag needed.

## Spawning a role — two hard rules

1. **Always pass `fork_turns: "none"` or a small number with `agent_type`.**
   Omitted `fork_turns` defaults to `"all"` (full-history fork), and a
   full-history fork **rejects** `agent_type` (and any model override) with an
   error. `"none"` + a self-contained prompt is the default choice; a numeric
   last-N-turns value only when recent context is genuinely required.
2. **Role selection needs the V2 spawn surface.** `gpt-5.6-sol` and
   `gpt-5.6-terra` force multi-agent V2 on; **`gpt-5.6-luna` forces V1**, so a
   Luna parent session cannot select roles at all. Other models use V1 unless
   `features.multi_agent_v2.enabled = true` is set.

Call shape:

```
spawn_agent {
  task_name: "verify sidebar fix",
  agent_type: "preview-verifier",
  fork_turns: "none",
  message: "<self-contained: objective, files, criteria, output contract>"
}
```

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

## Fallback when roles are not selectable

On a V1 surface (Luna parent, or `agent_type` absent for any reason), the
child inherits the parent's live-turn model and no cheaper tier can be
claimed:

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
  the hardest tasks. Remember: a Luna parent cannot spawn roles (V1).
- `[profiles.*]` in config.toml do not re-apply to children; children inherit
  the parent's live-turn model unless a role pins one.

## After upgrades

Once `0.145.0`+ reaches stable, `expose_spawn_agent_model_overrides`
(default-on when present) adds per-call `model` / `reasoning_effort` to
spawn_agent. Roles remain the durable mechanism for standing chores
(instructions + sandbox + model in one place); per-call overrides become the
escape hatch for one-off routing. The `fork_turns` restriction applies to
per-call overrides too. Re-check the spawn_agent schema after each Codex
upgrade, and keep verifying the recorded child model in Junrei (session
detail → Subagent tree) — the observed model, not the role name, is the
source of truth.
