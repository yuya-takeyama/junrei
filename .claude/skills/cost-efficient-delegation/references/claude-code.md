# Claude Code delegation controls

Claude Code routes the model **per delegated call**: the `Agent` tool takes a
`model` parameter, and Workflow scripts take `agent(prompt, {model, effort})`.

## Per-call routing

- Pass an explicit `model` (and `effort` in Workflow scripts) on every
  delegated call unless the task genuinely needs orchestrator-tier reasoning.
  Omitting `model` inherits the expensive session model.
- Precedence for a subagent's model:
  `CLAUDE_CODE_SUBAGENT_MODEL` > Agent-tool `model` > agent frontmatter
  `model` > inherit session model.
- **SendMessage loses the model override**: continuing a
  spawned agent via `SendMessage` re-runs it on the session model, not the
  `model` passed at spawn. Prefer re-spawning with `model` set over long
  continuation chains; verify the recorded model in Junrei when a
  continuation was unavoidable.

## Standing roles (agent frontmatter)

For recurring chores, keep the model pinned in the agent definition's
frontmatter instead of repeating it per call:

- UI/preview verification: `sonnet` via `.claude/agents/preview-verifier.md`.
- Commit, rebase, push, PR, and CI watch: `sonnet` via
  `.claude/agents/pr-shepherd.md`.

These mirror the Codex roles in `.codex/agents/` (see `codex.md`) so the same
delegation habits work in both harnesses.

## Session-level setup for humans

- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet claude` pins all subagents. It overrides
  per-call and frontmatter choices, so do not combine it with per-call tuning.
- Use `--append-system-prompt` for a session-wide delegation policy.
- An advisor or `opusplan` setup can keep planning strong while execution uses
  a cheaper tier.

## Measured example

Claude Code session `621c4c87` (shipped PR #78): chore delegation
was exemplary — Haiku Explore, Sonnet preview-verifier, and Sonnet pr-shepherd
moved 39% of tokens for 4.9% of cost — yet the session still cost $23.5
because implementation stayed in the Fable main loop (95% of spend; half of
that was cache writes on a ~220k context, and the main loop duplicated its own
Explore agent's reads). The shared rules "orchestrator stops touching files"
and "never explore in parallel with your own scout" come from that session.
