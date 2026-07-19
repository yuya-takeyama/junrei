# CLAUDE.md

## Model cost policy

The main session often runs on an expensive orchestrator model. **Before
spawning any subagent or workflow, load the `cost-efficient-delegation`
skill** and follow its routing and skill contract. Harness-specific
mechanics live in the skill's `references/`.

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
- Running sessions cost-efficiently: see `docs/cost-playbook.md`.
