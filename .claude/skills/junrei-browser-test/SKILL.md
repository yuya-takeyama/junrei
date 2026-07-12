---
name: junrei-browser-test
description: Launch Junrei's isolated development environment and verify its web UI in a browser. Use when changing React UI, CSS/layout, navigation, interactive controls, or API-backed screen behavior in this repository, and whenever a dev server or port must be chosen for browser testing — with whatever browser tooling the current agent environment provides.
---

# Junrei Browser Test

## Start the environment

Run `pnpm dev` from the repository root. Do not select ports manually and do
not use `pnpm start` for isolated agent testing.

Read the launcher output and use its `Web` URL. `pnpm dev` assigns free API and
Web ports independently, starting from 7868 and 5874, and configures Vite's
proxy to the assigned API port.

Use `pnpm start` only for the normal fixed-port mode: API 7867 and Web 5873 by
default, overridable with `JUNREI_PORT` and `JUNREI_WEB_PORT`. Do not hardcode
ports anywhere else (including `.claude/launch.json`, whose entries fit only
this fixed-port mode) — `pnpm dev` allocates isolated ports dynamically.

## When to test

Run browser verification when a change affects visible UI, routes, selection,
layout, responsiveness, or client/server integration. Skip it for isolated
non-UI logic when unit tests cover the behavior.

## Run the test

The workflow is the same whatever agent harness is running. Never skip
verification because a familiar tool surface is missing — use whatever browser
control the environment provides:

- If a dedicated verifier agent is available (`preview-verifier` at
  `.claude/agents/preview-verifier.md`), delegate to it: it owns browser-tool
  usage, follows the port contract above, and returns a compact verdict. Pass
  it the Web URL or tab id when the environment is already running.
- Otherwise drive the browser tools directly: reuse a running Junrei tab or
  server whatever its port, else start one per the contract above, and
  navigate to the printed Web URL. In-app browser surfaces bootstrapped
  through a REPL (e.g. `browser:control-in-app-browser` via
  `mcp__node_repl__js`) document their own API — follow that skill rather
  than duplicating it here.

Inspect the DOM for content and interaction state; take a screenshot only when
layout or visual hierarchy is under test.

Keep the development process running while testing and stop it once the task
is finished unless the user asks to keep it available. Never stop servers you
did not start.
