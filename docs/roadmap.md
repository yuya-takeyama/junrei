# Junrei — Roadmap

Status legend: ✅ done / 🚧 in progress / ⬜ planned

Completed work lives in [roadmap-archive.md](./roadmap-archive.md) — this
file tracks only what is in progress or ahead.

## In progress

- 🚧 Cross-session aggregates & trends — repo-level overview shipped
  (#42, #43); cross-repo/global trends still open

### S3 as an additional Claude session source (2026-07-17)

🚧 A remote environment (Claude Agent SDK on AWS AgentCore Runtime) can upload
session transcripts to S3 mirroring the local `~/.claude/projects/` layout;
setting `JUNREI_S3_SOURCE_URI` (`s3://bucket/prefix/`) makes Junrei list and
read those sessions directly from the bucket as an additional source, merged
into the same session list — no local sync/mirror, and byte-for-byte
unchanged behavior when the env var is unset.

Introduced a minimal `ClaudeSessionStore` interface in `@junrei/core`
(`claude/store.ts`: `listSessionFiles`/`findSessionFileById`/`openLines`/
`readFile`/`listSidecarFiles`) and threaded it through `parser.ts`,
`subagents.ts`, `workflows.ts`, `analyze.ts`, and `timeline.ts` — every fs
touch in the Claude module now goes through a store, defaulting to a
`localClaudeSessionStore` that's a pure refactor of the old direct-`node:fs`
code (existing tests pass unmodified). `ClaudeSessionFileRef.filePath` is now
documented as a store-scoped URI (local absolute path, or `s3://bucket/key`)
and carries a new `changeToken` field (local: `String(mtimeMs)`, unchanged
behavior) generalizing the server's mtime-keyed parse caches to an opaque
string. A `joinPath` helper (`paths.ts`) replaces `node:path`'s `join` for any
store-scoped path, since `path.join` collapses the `://` in an S3 URI.

The S3 implementation itself (`@junrei/server`'s `sources/s3-store.ts`, the
only file importing `@aws-sdk/client-s3` — never `@junrei/core`, which
`@junrei/web` bundles via vite) does one paginated `ListObjectsV2` sweep
under `<prefix>projects/` per TTL window (`JUNREI_S3_LIST_TTL_MS`, default
10s) to answer every discovery query, derives session/sidecar structure from
key shape, uses `ETag` as the change token (falling back to
`LastModified`+`Size`), warns on a shrunk object size (possible remote
rollback) or an unparseable/path-traversal key, and reads file contents via
`GetObject`. `sources/claude.ts` builds one adapter bundle per store (local +
optional S3) with independent caches; single-session lookups
(`getSession`/`getTimeline`/etc.) try local first, then S3 — an accepted
"local wins" precedence when the same session id exists in both. `search.ts`
routes transcript scanning through the right store per file so S3 sessions
are searchable too.

Tests: server-side unit tests mock the S3 client at the `send` level
(pagination, key parsing, TTL caching with fake timers, ETag invalidation,
size-decrease/invalid-key warnings). One integration test spawns
[kumo](https://github.com/sivchari/kumo) (a single-binary S3-compatible
emulator, added to `aqua.yaml` via a local registry —
`aqua/kumo-registry.yaml` + `aqua-policy.yaml`, since it isn't in the standard
aqua registry), uploads the existing core fixtures, and exercises the store
end to end; it skips gracefully when `kumo` isn't on `PATH`.

## Current milestone — Goshuin (decided 2026-07-18)

Evidence-grade agent analysis over Junrei MCP: give analyzing agents
verifiable, provenance-backed access to what actually happened in a session —
including what the session JSONL alone cannot show (system prompt, tool
schemas/action space, generation params, injected context, hidden API calls,
latency). Grounded in the
[session-log completeness study](./research/claude-code-session-log-completeness.md)
and new measured verification (API-payload reconstruction from log+disk:
85–100% byte-exact; per-CLI-version stability of system prompt/tools/params).
Full insight dump, candidate approaches (A–F), adopted phasing, and the
decision record: [milestones/goshuin.md](./milestones/goshuin.md).

- ✅ Insight/idea capture: evidence base, six candidate approaches
  (drill-down tools, blind-spot metadata, reconstruction "virtual wire",
  wire-capture ingestion, OTel ingestion, eval-trace export), open decisions
- ✅ Decision stage (2026-07-18): all nine open decisions settled — C-first
  (reconstruction first-class, capture as opt-in calibrator); labeled
  confidence classes (`exact`/`template`/`disk-contingent`/`unknown`)
  admitted; drift = `disk-contingent` label + mtime hint, no watcher;
  user-local template library (`~/.junrei/templates/`, never in-repo);
  drill-down tools added to MCP (9 → 11); capture-proxy constraints fixed
  (local-only, opt-in, redact-at-write, ToS warning), UX deferred to D;
  OTel receiver on the same Hono server with per-session JSONL;
  per-response `sourceCompleteness` block (+ `costIsComplete` kept);
  recon scripts promoted to `experiments/` in phase C. Full record with
  rationale:
  [goshuin.md — Decisions](./milestones/goshuin.md#decisions-2026-07-18)
- 🚧 Implementation (phase order B → A → C → D/E → F):
  - ✅ B: blind-spot metadata — `sourceCompleteness` on every MCP response
    (fixed status vocabulary + frozen per-source dimension tables in
    `@junrei/core`; all 9 tool descriptions document the semantics;
    `list_sessions` payload became `{ sessions, sourceCompleteness }`)
  - ⬜ A: MCP drill-down tools (`get_records`, `get_tool_call`)
  - ⬜ C: reconstruction layer ("virtual wire",
    `get_reconstructed_request`) + promote recon scripts into
    `experiments/` with fixture-based tests
  - ⬜ D: wire-capture ingestion (opt-in, local-only)
  - ⬜ E: OTel ingestion (OTLP endpoint on the junrei server)
  - ⬜ F: evaluation-trace export + analysis playbooks

## Open items

- ⬜ Docs refreshed; README quick start (v1 M4)
- ⬜ Transcript API (ordered event stream per session / per subagent)
- ⬜ New derived signals: concurrency profile, sibling overlap, instruction
  footprint (instruction sizes partially visible via injected-file tracking,
  #40)
- ⬜ Codex fork lineage (`forked_from_id`) — parsed, no fork-tree UI yet
- ⬜ Codex legacy-format rollout support (pre-2026-02-25 transcripts)

## Later (post-v1)

- ⬜ Export/copy portable summaries (paste into ChatGPT, issues, docs)
- ⬜ Review Skill for agent-driven retrospectives
- ⬜ Desktop packaging (Tauri/Electron)
- ⬜ Live tail / watch mode
