---
name: junrei-browser-test
description: Launch Junrei's isolated development environment and verify its web UI (Claude Code or Codex). Use when changing React UI, CSS/layout, navigation, interactive controls, or API-backed screen behavior in this repository, and whenever a dev server or port must be chosen for browser testing.
---

# Junrei Browser Test

## Start the environment

Run `pnpm dev` from the repository root. Do not select ports manually and do
not use `pnpm start` for isolated agent testing.

Read the launcher output and use its `Web` URL. `pnpm dev` assigns free API and
Web ports independently, starting from 7868 and 5874, and configures Vite's
proxy to the assigned API port.

Use `pnpm start` only for the normal fixed-port mode: API 7867 and Web 5873 by
default, overridable with `JUNREI_PORT` and `JUNREI_WEB_PORT`.

## Test in Codex

Use the existing `browser:control-in-app-browser` skill rather than duplicating
its browser API instructions here. Bootstrap and control it only with
`mcp__node_repl__js`, then navigate to the printed Web URL. Inspect the DOM for
interaction state and take a screenshot when layout or visual hierarchy is
under test.

Run browser verification when a change affects visible UI, routes, selection,
layout, responsiveness, or client/server integration. Skip it for isolated
non-UI logic when unit tests cover the behavior.

Keep the development process running while testing and stop it once the task is
finished unless the user asks to keep it available.

## Test in Claude Code

Delegate browser verification to the existing `preview-verifier` agent at
`.claude/agents/preview-verifier.md`. It owns the Browser pane tools
(`mcp__Claude_Browser__*`) and returns a compact verdict. Pass it the Web URL
or tab id when the environment is already running; otherwise it starts one
itself.

The port contract is the same `pnpm dev` flow above; never select ports
manually:

1. Reuse first: `tabs_context` / `preview_list` to find an already-running
   Junrei web tab or server, whatever its port.
2. Otherwise run `pnpm dev` from the repository root as a background Bash
   task and read the printed `Web:` URL from its output.
3. Open that URL in the Browser pane with `preview_start {url}`.

`preview_start {name}` with `.claude/launch.json` entries fits only the
fixed-port `pnpm start` mode (`junrei-web` 5873 / `junrei-server` 7867). Do
not add per-worktree port entries to launch.json — that hardcodes what
`pnpm dev` already allocates dynamically.
