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
