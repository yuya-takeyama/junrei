# Claude Code session logs: completeness study vs. API wire capture and OTel

Research note, 2026-07-18. Empirical answer to: *"Is the session JSONL under
`~/.claude/projects/` sufficient to evaluate agent behavior, and if not, what
exactly is missing and how can the gaps be filled?"*

## Method

One controlled headless session (claude CLI **2.1.205**, `claude -p`, model
`claude-haiku-4-5`, `--dangerously-skip-permissions`, a scenario exercising
Read, Bash, and one Task-tool subagent) was captured simultaneously through
four channels:

1. **API wire capture** — `ANTHROPIC_BASE_URL` pointed at a local pass-through
   proxy (`experiments/claude-code-capture/capture-proxy.mjs`) that tees every
   request/response (including SSE streams, reassembled) to JSONL, with auth
   headers redacted. This is informationally equivalent to the
   mitmproxy-over-`HTTPS_PROXY` approach, but needs no TLS interception or
   extra software. It is **not** interchangeable with a LiteLLM/Bifrost-style
   gateway in every auth mode — see "Auth modes, gateways, and terms of
   service" below.
2. **OpenTelemetry** — Claude Code's built-in OTLP export
   (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, logs + metrics, `http/json`) sent to a
   local collector (`experiments/claude-code-capture/otel-collector.mjs`).
3. **The native session log** — the `~/.claude/projects/<proj>/<session>.jsonl`
   file plus its `subagents/agent-*.jsonl` + `.meta.json` sidecar.
4. **CLI result JSON** — `--output-format json` stdout (an accidental but
   informative fourth channel).

Reproduction: `experiments/claude-code-capture/README.md`. Findings were
verified against the raw captures (byte-level diffs, exhaustive request-id
joins) and cross-checked against real *interactive* session logs from versions
2.1.205 and 2.1.209 to rule out headless-mode artifacts.

**Key enabling fact:** `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` works
unmodified with existing subscription (OAuth) auth — the CLI sends its normal
`authorization` bearer header to the substitute base URL. No API key, no MITM
certificate, no keychain work is needed for wire capture. This matches
Anthropic's own [LLM gateway docs](https://code.claude.com/docs/en/llm-gateway):
overriding only the base URL (with no gateway credential) does not replace the
subscription login, provided the forwarder preserves the `anthropic-beta`
header that carries the OAuth capability — which a byte-for-byte pass-through
does by construction.

## Summary matrix

FULL = complete and faithful; PART = partially derivable; — = absent.

| Information | Session log | Wire capture | OTel | CLI result |
|---|---|---|---|---|
| System prompt (3 blocks, ~28.6 KB) | — | FULL | — | — |
| Tool catalog: 31 names + `input_schema`s | PART (names via `attachment`) | FULL | — | — |
| Generation params (`max_tokens`, `thinking`, `context_management`, beta headers) | — | FULL | — | — |
| Injected `<system-reminder>` blocks (see below) | PART | FULL | — | — |
| User prompt text | FULL (byte-exact) | FULL | opt-in flag | — |
| Assistant text + thinking + signatures | FULL (byte-exact) | FULL | text only | — |
| `tool_use` arguments (files read, commands run) | FULL | FULL | sizes only | — |
| Tool results (stdout etc.) | FULL (byte-exact) | FULL | sizes only | — |
| Subagent tree | FULL (explicit) | FULL (explicit flag) | FULL | PART |
| Token usage / cache stats / model / stop_reason | FULL | FULL | PART | PART |
| Cost (USD) | derived (junrei) | derived | FULL | FULL |
| Latency / TTFB | — (timestamps only) | PART (total ms) | PART (`duration_ms`) | FULL (`ttft_ms` …) |
| Permission decisions / hooks I/O | FULL (`hook_success` attachments) | — | PART (counts, accept/reject) | denials list |
| Hidden auxiliary LLM calls | — | FULL | — | — |
| `cwd` / `gitBranch` / version / record tree (`uuid`/`parentUuid`) | FULL | — | — | — |

## What the session log is missing

### 1. The system prompt — entirely

No record type carries it. The wire shows 3 `system` blocks (a
billing-header line, a short identity block, and a ~28 KB main prompt) with
`cache_control` markers. Reconstructing "what the model was told" from the
session log alone is impossible, and the prompt varies per agent type (the
subagent got a different, ~4 KB system prompt with only 16 of the 31 tools).

### 2. One of the three injected `<system-reminder>` blocks — the important one

Every user turn on the wire opens with three injected blocks:

| Injected block | Wire size | In session log? |
|---|---|---|
| Agent-type listing | 3,670 c | Yes — `attachment.type="agent_listing_delta"` (body verbatim) |
| Skill listing | 8,066 c | Yes — `attachment.type="skill_listing"` (body verbatim, minus wrapper) |
| **CLAUDE.md + memory index + userEmail + currentDate** | 10,792 c | **No — zero trace, no attachment type exists for it** |

So CLAUDE.md-injection *content* is unrecoverable from current logs (the
legacy-log-only note in `docs/design.md` is confirmed at the wire level).
`grep` for the CLAUDE.md content, `"system-reminder"`, or `userEmail` across
the run's session log: 0 hits.

### 3. Tool definitions and generation parameters

`input_schema`, `max_tokens`, `temperature`, `thinking` budgets, the
`context_management` edits config, and the `anthropic-beta` feature-flag set
appear only on the wire. Real interactive logs (2.1.205/2.1.209) were checked
too: never present.

### 4. Hidden auxiliary LLM traffic

10 `POST /v1/messages` were captured; the session log and OTel each account
for only **8**. The other 2 are a background "walked-away task-state
classifier" (non-streaming, `tools:[]`, `max_tokens:1024`, system prompt
*"A user kicked off a Claude Code agent … decide which of four states it's
in"*) powering status/notification UI. Their `request-id`s appear nowhere in
the session log, OTel, or the CLI result. Only wire capture sees the complete
billed API surface.

### 5. Latency and wire-level annotations

Session records have timestamps but no durations. TTFB/time-to-request live
only in the CLI result JSON (`ttft_ms`, `ttft_stream_ms`, `duration_api_ms`).
Wire-only details also include `cache_control:{"ttl":"1h"}` annotations that
the CLI adds to every tool_result it sends back, retry counters
(`x-stainless-retry-count`), and a W3C `traceresponse` header.

## What the session log has that the wire lacks

The wire capture is *not* a superset. Log-only information:

- The record tree: `uuid`/`parentUuid`, `isSidechain`, per-record timestamps.
- Environment context: `cwd`, `gitBranch`, CLI `version`, `permissionMode`.
- Hook execution I/O (`attachment.type="hook_success"`: command, stdout,
  stderr, exit code, duration) — the proxy never sees the hook layer.
- Subagent bookkeeping: `.meta.json` (`toolUseId`, `spawnDepth`), the
  `agentId` linkage, `queue-operation` / `last-prompt` records.
- Structured `toolUseResult` metadata beyond the raw text sent to the model.

Fidelity where the two overlap is excellent: user prompt, tool_result
content, and a 1,304-char thinking `signature` were each byte-identical
between the session log and the wire. The session log is a faithful — but
strict — subset of the conversation payload.

## Joining wire capture to session logs is automatic

No heuristics needed, three exact keys (all verified on every request):

1. **Session-level**: request header `x-claude-code-session-id: <session
   uuid>` (also in body `metadata.user_id` JSON, alongside `account_uuid` and
   `device_id`) — identical across main, subagent, and classifier calls.
2. **Turn-level**: response header `request-id` == the session log's
   `requestId` field, byte-identical (verified 8/8; the 2 misses are exactly
   the classifier calls).
3. **Main-vs-subagent**: the first `system` block is a billing header;
   subagent requests carry a literal `cc_is_subagent=true`. (Which *specific*
   subagent still requires the session-log `agentId` cross-reference when
   several run concurrently.)

Bonus wire observation: main-loop and subagent requests overlap in time
(66 ms apart, overlapping durations) — real concurrency, visible only here.

## What OTel adds — and doesn't

Logs-stream events observed: `user_prompt`, `tool_decision`, `tool_result`,
`api_request`, `assistant_response`, `subagent_completed`,
`hook_execution_start/complete`, `hook_registered`, `plugin_loaded`,
`mcp_server_connection` (one `status:"failed"` captured). Metrics:
`session.count`, `cost.usage`, `token.usage`, `active_time.total`.

- Strengths: authoritative **cost_usd** per request, identity attributes
  (user/org/account), permission `tool_decision` accept/reject with source,
  subagent summary (`total_tokens`, `total_tool_uses`, `duration_ms`), MCP
  and hook health — mostly things the session log lacks or junrei must derive.
- Weaknesses: no prompts (unless `OTEL_LOG_USER_PROMPTS=1`, which then exports
  **full untruncated prompt text** — a privacy-relevant toggle), no tool
  arguments/results (only byte sizes), no system prompt or schemas, no
  `stop_reason`; the classifier calls are invisible; and the logs vs. metrics
  streams use different vocabularies for the same main/subagent concept
  (`query_source: "sdk" / "agent:builtin:general-purpose"` vs.
  `"main" / "subagent"` + `agent.name`).

OTel is an *ops* channel, not an evaluation channel. A custom ~60-line OTLP
JSON collector was sufficient; an off-the-shelf OTel Collector adds nothing
for this purpose except operational hardening.

## Answer to "what would a complete evaluation dataset need?"

The original wishlist (system + user prompts, tool calls/results, files read,
commands run, subagent tree) is necessary but not sufficient. Add:

1. Tool **catalog** per request (names + schemas — the model's action space).
2. Generation params and beta flags (decoding budget changes behavior).
3. Injected context provenance (CLAUDE.md, memory, skill/agent listings).
4. Thinking blocks **with signatures** (replayability).
5. Context-management/compaction config and events.
6. Permission decisions and hook I/O.
7. Errors, retries, rate-limit responses.
8. Timing: per-request latency, TTFB, concurrency overlap.
9. Token/cache/cost accounting (incl. `cache_control` placement).
10. Hidden auxiliary LLM calls (state classifiers etc.).
11. Correlation IDs to join all of the above.

Coverage today: **session log + wire capture together = 1–11 except hook
internals timing (log has it) — i.e. the union is effectively complete.**
Each alone is not.

## Auth modes, gateways, and terms of service

Claude Code authenticates in one of two ways — an **Anthropic API key**
(Console/platform billing) or a **claude.ai subscription login** (Pro/Max
OAuth bearer token) — and the capture routes are *not* equally available in
both modes. Sources checked 2026-07-18:

| Capture route | API key | Subscription (OAuth) |
|---|---|---|
| OTel export (official) | works | works |
| Local pass-through proxy (`ANTHROPIC_BASE_URL` only, credentials untouched) | works | works — verified in this study, and consistent with Anthropic's gateway docs (below) |
| mitmproxy via `HTTPS_PROXY` | works | works — same mechanics; TLS-inspection proxies are covered by the corporate-proxy docs |
| LiteLLM gateway | works — the documented gateway pattern (LiteLLM holds the Anthropic API key; the client authenticates to LiteLLM) | **not by default** — a gateway credential replaces the subscription. An opt-in OAuth passthrough (`forward_client_headers_to_llm_api: true`) is documented for Max subscriptions but is recent, non-default, and has open header-handling bugs (litellm #19618, #29190) |
| Bifrost gateway | works (virtual keys) | **no** — credential substitution only; OAuth passthrough is an open feature request (bifrost #1390) |

The mechanics are documented by Anthropic itself
([llm-gateway](https://code.claude.com/docs/en/llm-gateway),
[llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol)):
while a gateway credential (`ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, …) is
active, the claude.ai subscription is not used — the credential replaces it
for that session. Overriding only the base URL does not replace the
subscription, and a forwarder must pass the `anthropic-beta` header through
unmodified (stripping the OAuth capability yields 401s). Anthropic also notes
it does not endorse or audit third-party gateway products.

So the earlier equivalence framing needs a correction: **for API-key
connections**, a LiteLLM/Bifrost-style gateway sees the same request content
as our pass-through proxy; **for subscription connections**, mainstream
gateways in their default configuration cannot carry the session at all —
a transparent pass-through (this harness, or mitmproxy) is the only
base-URL-family option that works as-is.

### Terms-of-service position (subscription mode)

- Anthropic's [legal-and-compliance page](https://code.claude.com/docs/en/legal-and-compliance)
  restricts OAuth authentication to subscription holders' ordinary use of
  Claude Code and native Anthropic applications, and explicitly disallows
  third-party developers routing requests through Free/Pro/Max credentials on
  behalf of *their* users. The consumer terms additionally prohibit credential
  sharing and non-API-key automated access.
- The 2026 enforcement wave (silent block in January, broad enforcement in
  April, per press coverage) targeted **alternate harnesses** (OpenClaw,
  OpenCode, NanoClaw, …) driving the API with subscription OAuth tokens from
  clients that are not Claude Code; Anthropic's stated rationale was abnormal
  traffic patterns from non-Claude-Code clients.
- **No explicit Anthropic statement addresses a local, single-user,
  byte-for-byte observer proxy in front of the genuine Claude Code client.**
  Mechanically it is the exact configuration the gateway docs describe as
  keeping the subscription active (client unchanged, credentials unaltered,
  traffic shape unchanged), and it is materially different from the
  enforced-against pattern — but it is not explicitly blessed either. Treat
  it as a gray zone: keep it local and personal, never operate it as a
  shared or hosted service for subscription users, and prefer the official
  channels when they suffice.

## Implications for junrei

- The session log remains the right **backbone**: it alone has the record
  tree, environment context, hooks, and subagent bookkeeping, and its
  overlapping content is byte-faithful.
- **OTel ingestion is the safe, auth-mode-independent complement** — the only
  officially sanctioned channel beyond the logs themselves. Its unique value
  is authoritative cost, permission decisions, and MCP/hook health. Treat
  `OTEL_LOG_USER_PROMPTS` as privacy-sensitive.
- A **capture-proxy ingestion mode** is technically feasible and cheap: point
  `ANTHROPIC_BASE_URL` at a junrei-owned local proxy, join to session logs via
  `x-claude-code-session-id` + `request-id`, and junrei gains system prompts,
  tool schemas, generation params, injected-context diffs, hidden calls, and
  latency — with zero heuristics. Auth redaction is mandatory (the bearer
  token transits the proxy). Given the ToS gray zone above, this must ship as
  a **local-only, opt-in** feature framed as personal debugging of one's own
  official client — never as a hosted/shared capture service; for API-key
  users the same design doubles as a fully supported gateway deployment.
- Cost accounting from session logs slightly undercounts reality (classifier
  calls are unlogged; each is small, but they scale with sessions).

## Caveats

Single scenario, one CLI version (2.1.205; log-side findings cross-checked on
2.1.209 interactive logs), no error/retry or context-compaction events were
exercised, MCP tools and images untested, and the desktop-harness Workflow
tool was out of scope (plain CLI has no Workflow). The classifier prompt and
billing-header format are undocumented internals and may change without
notice. The gateway/ToS findings are a point-in-time snapshot (2026-07-18):
LiteLLM's OAuth passthrough, Bifrost's feature set, and Anthropic's terms and
enforcement posture are all actively moving.
