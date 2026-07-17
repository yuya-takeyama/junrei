# CLAUDE.md

## Model cost policy

The main session often runs on an expensive orchestrator model (Claude Fable 5
or Codex GPT-5.6 Sol). **Before spawning any subagent or workflow, load the
`cost-efficient-delegation` skill** and follow its harness-specific routing
and skill contract (main loop plans/integrates/reviews; execution is
delegated). For Claude Code, pass an explicit `model` (+ `effort`) per
delegated call. For Codex, spawn a predefined role from `.codex/agents/`
(instructions + sandbox + model + effort in one place) via `agent_type` for
standing work, or pass the per-call `model` / `reasoning_effort` override for
one-off routing — always with `fork_turns: "none"` or a small number (the
default `"all"` rejects both). Use a self-contained prompt, then verify the
recorded model in Junrei. Keep planning and judgment in the main loop.

On Claude Code, delegate routine preview/UI verification to the
`preview-verifier` agent (`.claude/agents/preview-verifier.md`) — screenshots
and DOM dumps must not accumulate in the orchestrator context; judge its text
verdict instead. Likewise, delegate commit → rebase → push → PR → CI-watch
chores to the `pr-shepherd` agent (`.claude/agents/pr-shepherd.md`): prepare
the tree and the messages in the main loop, then hand off execution. On Codex,
the same chores route to the `preview-verifier` and `pr-shepherd` roles in
`.codex/agents/`; roles and per-call overrides are unavailable only from a
Luna parent (V1 surface) — in that case spawn only for parallelism or context
isolation and do not claim a cheaper tier.

After significant multi-agent work, check the real spend with Junrei itself
(session detail → Cost by model / Subagent tree, or the `get_subagent_tree` MCP
tool) and adjust delegation choices from evidence.

## CI fallback policy

CI runs the same quality gates as local (`pnpm typecheck && pnpm lint && pnpm test`).
When GitHub Actions is unstable — an incident on
https://www.githubstatus.com, or checks that never start/finish despite no
merge conflict — a PR may be merged **without waiting for CI**, provided the
full local quality gates passed on the exact commit being merged (i.e. after
the final rebase onto latest `origin/main`). Leave a PR comment noting the
bypass and the local gate results so the audit trail shows why checks were
skipped. When Actions is healthy, the normal CI-watch flow applies.

## Development

- Tooling via aqua (`aqua i -l`), packages managed with pnpm workspaces.
- `pnpm dev` starts the API server and web UI on free ports printed at startup
  (from 7868/5874); `pnpm start` uses the fixed ports 7867/5873. See README.md.
- Quality gates: `pnpm typecheck && pnpm lint && pnpm test` — CI runs the same.
- Docs live in `docs/` (design.md, roadmap.md) — keep roadmap.md updated as
  features land.
