# Claude Code capture experiment

## Purpose

Junrei analyzes the native session JSONL that Claude Code writes under
`~/.claude/projects/`, but that log is a lossy view of what actually happened:
it omits the full system prompt, tool `input_schema`s, generation parameters,
and some background/telemetry traffic. This experiment captures the same
headless session from three angles at once — raw API traffic, OpenTelemetry
export, and the native session JSONL — so we can diff them and know exactly
what the session log is missing.

## How to run

```
cd experiments/claude-code-capture
node run-scenario.mjs             # runs proxy + otel collector + one scripted `claude -p` session
node summarize-run.mjs <runDir>   # prints + writes digest.md for that run
```

`run-scenario.mjs` prints the run directory it created. Ports default to 8399
(capture proxy) and 8398 (OTel collector); override with `--proxy-port` /
`--otel-port` if those are taken. Run dirs land under
`--runs-base` (defaults to a fixed scratchpad path baked into the script —
override it when running outside that environment). Each run directory is
self-contained and safe to inspect/delete independently.

`capture-proxy.mjs` and `otel-collector.mjs` can also be run standalone
(`node capture-proxy.mjs --port 8399 --out capture.jsonl`,
`node otel-collector.mjs --port 8398 --out-dir .`) for manual poking with curl
or a real `claude` session.

## File layout (per run directory)

- `capture.jsonl` — one line per proxied HTTP exchange: method/path/status,
  redacted headers, parsed request body, and either a parsed response body or,
  for SSE, the raw event list plus an `assembledMessage` reconstructed from the
  stream deltas.
- `otel-logs.jsonl` / `otel-metrics.jsonl` / `otel-traces.jsonl` — one line per
  OTLP/HTTP JSON POST Claude Code sent to the collector.
- `project/` — the scratch project directory the scenario ran in
  (`notes.txt`, `data.json`).
- `session-log/` — a full copy of the matching `~/.claude/projects/<...>/`
  directory: the main session `.jsonl`, and a `subagents/` (or sidechain)
  subdirectory holding the Task-tool subagent's own transcript.
- `claude-stdout.json` / `claude-stderr.log` — raw CLI output.
- `manifest.json` — ports, session id, exit code, timings, file inventory.
- `digest.md` — output of `summarize-run.mjs`.

## Reconstruction calibration (`recon/`)

The Goshuin milestone's Phase C "virtual wire" reconstruction layer
(`@junrei/core`'s `claude/reconstruction/`, exposed over MCP as
`get_reconstructed_request`) rebuilds the actual `/v1/messages` request that
produced a Claude Code main-loop turn from the session log alone, plus two
non-log inputs: a per-CLI-version **template** (captured once, reused across
sessions) and **current disk state** (CLAUDE.md/memory/account email). The
scripts in `recon/` are how that reconstruction gets calibrated and kept
honest against real wire captures — they turn a capture run (see "How to
run" above) into a template, then measure how many wire BYTES the production
reconstruction actually reproduces, bucketed by the confidence class
(`exact` / `template` / `disk-contingent` / `unknown`) it assigned each
block. See `docs/milestones/goshuin.md` ("Reconstruction fidelity
(measured)") for the methodology and the calibration numbers this workflow
originally produced.

### Workflow: extract a template, then compare

`compare.mjs` imports `@junrei/core` (and `@junrei/server`'s filesystem
providers) directly — that package has no build step (its `package.json`
`"build"` script is a no-op; `"exports"` points straight at
`./src/index.ts`), so every consumer in this workspace, `@junrei/server`
included, runs the TypeScript source directly through a TS-aware runtime.
Run the recon scripts the same way, via `tsx` (already a devDependency of
`@junrei/server` — no separate install needed):

```
cd experiments/claude-code-capture

# 1. Extract a template from a capture run (writes to a USER-LOCAL dir,
#    never the repo — default ~/.junrei/templates, override with --out).
../../packages/server/node_modules/.bin/tsx recon/extract-template.mjs <runDir> [--out <dir>]

# 2. Compare that run's reconstruction against its own wire capture.
../../packages/server/node_modules/.bin/tsx recon/compare.mjs <runDir> --template <templatesDir> [--no-disk] [--details]

# 3. (Optional) Compare the non-log-derived parts (system/tools/params) of
#    TWO capture runs against each other, to check how stable they are
#    across runs (no @junrei/core import needed — plain `node` is fine).
node recon/stability-compare.mjs <runDirA> <runDirB>
```

`extract-template.mjs` reads a run's `manifest.json` + `session-log/*.jsonl`
for the CLI version/cwd/sessionId, and the run's `capture.jsonl` for the
first main-loop request's `system` blocks, `tools` array, and generation
params (`model`/`max_tokens`/`temperature`/`thinking`/`stream`/
`context_management`) — plus any run-specific literal embedded in the system
prompt beyond `cwd`/`sessionId` (currently detected: the "Scratchpad
Directory" backtick-quoted path some harness configurations inject). It
writes `<out>/<cliVersion>/template.json` in the exact shape
`parseReconstructionTemplate` validates (and validates it itself before
writing — a template this script produces but core would reject is a bug in
the script). It refuses to write anywhere inside the repo checkout.

`compare.mjs` replays the run's session log through the SAME
`reconstructRequest` the MCP tool calls, with a `createFilesystemTemplateProvider`
pointed at `--template` and (unless `--no-disk`) a `createFilesystemDiskContextProvider`
reading the CURRENT machine's CLAUDE.md/memory/account email — the real,
live disk state, not a frozen copy, so drift since the capture shows up
exactly as `get_reconstructed_request` callers would see it. For every wire
`/v1/messages` request it can join to a reconstruction (via the `request-id`
response header == the log's own `requestId`), it compares each system
block (order-independent — the wire always puts the billing-header block
first, the reconstruction always puts its declared-unknown placeholder for
it last, having no idea what the wire's real position was), each message
block (positional — replay preserves wire order), and the whole `tools`/
`params` values, and buckets **wire bytes** as matched/total per confidence
class. The JSON report's `headlinePct` is `exact + template` matched bytes
over total wire bytes — the milestone's core acceptance number. `--details`
adds a `mismatches` array (section/index/confidence/reason per non-matching
block) for investigating a regression.

### Interpreting the confidence classes in a report

- **`exact`** — replayed straight from the session log (or byte-rebuilt from
  an `attachment` record). A mismatch here is either the known ~494-byte
  fixed safety preamble on synthetic task-notification turns (declared in
  the reconstruction's own `note`/`limitations`, not a bug), or a real
  regression in the replay/normalization rules (`replay.ts`/`rules.ts`).
- **`template`** — from the template's captured system/tools/params plus
  substitution. Self-calibrating a run against its OWN extracted template
  should match at ~100%; a mismatch means either the substitution scope is
  wrong (`template.ts`) or the template extraction itself captured the
  wrong fields.
- **`disk-contingent`** — the CLAUDE.md/memory/email reminder block, rebuilt
  from CURRENT disk state. A mismatch alongside `driftDetected: true` in the
  report's `diskContingent` field is legitimate drift (a contributing file
  changed since the capture), not a bug — re-run closer to capture time, or
  accept the drift as expected.
- **`unknown`** — the per-launch billing-header block (never recoverable) or
  a missing template. Bytes here are never counted as "matched"; they're the
  honest floor of what this layer cannot reconstruct.

### NEVER commit capture runs or extracted templates

Capture run directories (`capture.jsonl`, `session-log/`, `manifest.json`,
...) contain personal context: real prompts, file contents, and account
identifiers. Extracted `template.json` files contain Anthropic-authored
system-prompt/tool-schema text (Goshuin Decision 4 — templates are
USER-LOCAL artifacts, `~/.junrei/templates/<cliVersion>/template.json` by
convention, never redistributed). Neither belongs in this repo, checked in
or otherwise — only the scripts, and (in `packages/core`'s test fixtures)
synthetic, hand-written data that exercises the same rules without being a
real capture.

## Caveats

`ANTHROPIC_BASE_URL` pointed at a plain-HTTP local proxy worked fine with the
CLI's existing (OAuth/subscription) auth — no MITM or credential handling was
needed, and no `HTTPS_PROXY` tricks were used. The capture proxy buffers each
request body fully before forwarding (simple and reliable for JSON POSTs) but
streams the response through byte-for-byte so SSE is not buffered client-side.
Subagent-request identification in `summarize-run.mjs` is a heuristic (system
prompt hash differs from the first request's) — verify against `session-log`'s
sidechain/subagent files rather than trusting it blindly. OTel traces were not
captured because the scenario only sets `OTEL_METRICS_EXPORTER` /
`OTEL_LOGS_EXPORTER`, per the experiment spec; `otel-traces.jsonl` will not
exist unless you also export `OTEL_TRACES_EXPORTER=otlp`. Captured run data
(under the scratchpad, not this directory) may contain personal context
(prompts, file contents, account identifiers via OTel attributes) and must
never be committed.
