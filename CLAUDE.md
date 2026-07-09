# CLAUDE.md

## Model cost policy

The main session often runs on an expensive orchestrator model (Claude Fable 5).
**Before spawning any subagent or workflow, load the `cost-efficient-delegation`
skill** and pass an explicit `model` (+ `effort`) per delegated call — exploration
→ `haiku`, research/implementation → `sonnet`, hard debugging/verification →
`opus`. Omitting `model` inherits the expensive session model; only do that when
the subtask genuinely needs orchestrator-tier reasoning. Keep planning and
judging in the main loop, but delegate routine preview/UI verification to the
`preview-verifier` agent (`.claude/agents/preview-verifier.md`) — screenshots
and DOM dumps must not accumulate in the orchestrator context; judge its text
verdict instead. Likewise, delegate commit → rebase → push → PR → CI-watch
chores to the `pr-shepherd` agent (`.claude/agents/pr-shepherd.md`): prepare
the tree and the messages in the main loop, then hand off execution.

After significant multi-agent work, check the real spend with Junrei itself
(session detail → Cost by model / Subagent tree, or the `get_subagent_tree` MCP
tool) and adjust delegation choices from evidence.

## Development

- Tooling via aqua (`aqua i -l`), packages managed with pnpm workspaces.
- `pnpm dev` starts the API server (7867) and web UI (5873). See README.md.
- Quality gates: `pnpm typecheck && pnpm lint && pnpm test` — CI runs the same.
- Docs live in `docs/` (design.md, roadmap.md) — keep roadmap.md updated as
  features land.
