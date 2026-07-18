/**
 * Blind-spot metadata ("Goshuin" milestone, Phase B — see
 * docs/milestones/goshuin.md). `costIsComplete` (metrics.ts) tells a caller
 * whether ONE dimension (cost) is fully known; `sourceCompleteness`
 * generalizes that across every dimension a session JSONL log cannot
 * capture — system prompt, tool schemas, generation params, hidden API
 * calls, latency, etc. — so an analyzing agent can tell "not recorded" apart
 * from "recorded as zero/absent activity" and doesn't quietly conclude
 * things the data cannot support.
 *
 * The dimension tables below are pure data, not runtime-computed state —
 * frozen so they can't be mutated by a caller holding a reference.
 */

/**
 * How completely a source can represent one analytical dimension:
 *  - `partial` — recorded, but not the full picture (e.g. thinking blocks
 *    recorded per-turn but not re-sent in later requests).
 *  - `estimate` — derived (e.g. cost = token counts x a pricing table).
 *  - `authoritative` — recorded directly by the source of truth, not
 *    derived/estimated (e.g. OTel's billing-computed `cost_usd`, or wire
 *    capture's own measured latency and captured wire bytes, vs. the
 *    session log's pricing-table `estimate`).
 *  - `absent` — never recorded by this source at all.
 *  - `not-recorded` — happens outside what this source observes (e.g.
 *    auxiliary API calls the session log has no channel to log).
 *  - `unknown` — completeness for this dimension/source pair hasn't been
 *    audited yet.
 */
export type CompletenessStatus =
  | "partial"
  | "estimate"
  | "authoritative"
  | "absent"
  | "not-recorded"
  | "unknown";

/** Session-log formats, plus Claude-Code-only side channels (OTel, wire capture) `sourceCompleteness` can describe. */
export type SourceKind =
  | "claude-session-jsonl"
  | "claude-otel"
  | "claude-wire-capture"
  | "codex-session-jsonl";

export interface SourceCompletenessEntry {
  source: SourceKind;
  dimensions: Record<string, { status: CompletenessStatus; note?: string }>;
}

export interface SourceCompleteness {
  sources: SourceCompletenessEntry[];
}

/**
 * Claude Code session JSONL blind spots — verified by the measured
 * completeness study (docs/research/claude-code-session-log-completeness.md);
 * values here are taken verbatim from that study, not re-derived.
 */
const CLAUDE_DIMENSIONS: SourceCompletenessEntry["dimensions"] = Object.freeze({
  systemPrompt: { status: "absent", note: "system prompt is not recorded in session JSONL" },
  toolSchemas: { status: "absent", note: "tool definitions (action space) are not recorded" },
  generationParams: { status: "absent", note: "max_tokens/thinking/etc. are not recorded" },
  injectedContext: {
    status: "partial",
    note: "agent/skill listings recorded as attachments; CLAUDE.md/memory reminder content is not",
  },
  hiddenApiCalls: {
    status: "not-recorded",
    note: "auxiliary API calls are invisible; cost undercounts",
  },
  cost: { status: "estimate", note: "token counts x pricing table; see costIsComplete" },
  thinking: { status: "partial", note: "recorded per turn but not re-sent in later requests" },
  latency: { status: "absent", note: "per-request latency is not recorded" },
});

/**
 * Codex CLI rollout JSONL blind spots. Only `cost` has been measured so far
 * (same estimate mechanism as Claude); the rest are `unknown` pending an
 * equivalent completeness audit for Codex rollouts — NOT asserted as
 * `absent`, since that would claim more than has been verified.
 */
const CODEX_DIMENSIONS: SourceCompletenessEntry["dimensions"] = Object.freeze({
  cost: { status: "estimate", note: "token counts x pricing table; see costIsComplete" },
  systemPrompt: { status: "unknown", note: "completeness not yet audited for Codex rollouts" },
  toolSchemas: { status: "unknown", note: "completeness not yet audited for Codex rollouts" },
  hiddenApiCalls: { status: "unknown", note: "completeness not yet audited for Codex rollouts" },
  latency: { status: "unknown", note: "completeness not yet audited for Codex rollouts" },
});

/**
 * Claude Code OTel (OTLP logs/metrics) blind spots — Goshuin Phase E (see
 * docs/milestones/goshuin.md, Decision 7) and the completeness study's "What
 * OTel adds — and doesn't" section, values taken verbatim from there. OTel is
 * an opt-in side channel (`JUNREI_OTEL_DIR`) carrying no prompt/tool content
 * at all — its value is authoritative billing/permission/health data the
 * session log can only estimate or not see.
 */
const CLAUDE_OTEL_DIMENSIONS: SourceCompletenessEntry["dimensions"] = Object.freeze({
  promptContent: {
    status: "absent",
    note: "no prompt/message text exported (unless OTEL_LOG_USER_PROMPTS=1)",
  },
  toolContent: {
    status: "absent",
    note: "tool arguments/results are not exported, only byte sizes",
  },
  systemPrompt: { status: "absent", note: "system prompt is not exported over OTel" },
  toolSchemas: { status: "absent", note: "tool definitions (action space) are not exported" },
  cost: {
    status: "authoritative",
    note: "billing-computed cost_usd, not a pricing-table estimate",
  },
  latency: { status: "partial", note: "api_request duration_ms, only when Claude Code exports it" },
  hiddenApiCalls: {
    status: "not-recorded",
    note: "the background task-state classifier is invisible in OTel too",
  },
});

/**
 * Claude Code wire capture (Goshuin Phase D — the opt-in local pass-through
 * proxy, `@junrei/capture-proxy`). Unlike the session log, the capture IS the
 * actual wire bytes, so `content`/`latency` are `authoritative` — this is the
 * calibration ground truth. Its blind spot is the inverse of the log's:
 * coverage is `partial` (only requests made while the proxy was running are
 * seen), and auth headers are deliberately `absent` (redacted at write time).
 */
const CLAUDE_WIRE_CAPTURE_DIMENSIONS: SourceCompletenessEntry["dimensions"] = Object.freeze({
  content: { status: "authoritative", note: "captured wire bytes; auth headers redacted at write" },
  coverage: { status: "partial", note: "only requests made while the capture proxy was active" },
  authHeaders: { status: "absent", note: "redacted at write time" },
  hiddenApiCalls: { status: "partial", note: "visible only when routed through the proxy" },
  latency: { status: "authoritative", note: "measured at the proxy" },
});

const SOURCE_TABLES: Readonly<Record<SourceKind, SourceCompletenessEntry["dimensions"]>> =
  Object.freeze({
    "claude-session-jsonl": CLAUDE_DIMENSIONS,
    "claude-otel": CLAUDE_OTEL_DIMENSIONS,
    "codex-session-jsonl": CODEX_DIMENSIONS,
    "claude-wire-capture": CLAUDE_WIRE_CAPTURE_DIMENSIONS,
  });

/**
 * Stable declaration order regardless of input order — Claude session log,
 * then its OTel and wire-capture side channels, then Codex.
 */
const SOURCE_ORDER: readonly SourceKind[] = Object.freeze([
  "claude-session-jsonl",
  "claude-otel",
  "claude-wire-capture",
  "codex-session-jsonl",
]);

/**
 * Build the `sourceCompleteness` block for a set of source kinds — deduped
 * and returned in stable (claude-before-codex) order regardless of `kinds`'
 * input order. See `packages/server/src/mcp.ts` for the per-tool mapping of
 * which kinds each response passes (Claude-only tools → claude only;
 * session-scoped tools → whichever harness the resolved session belongs to;
 * multi-source tools → both).
 */
export function buildSourceCompleteness(kinds: SourceKind[]): SourceCompleteness {
  const requested = new Set(kinds);
  const sources = SOURCE_ORDER.filter((kind) => requested.has(kind)).map((kind) => ({
    source: kind,
    dimensions: SOURCE_TABLES[kind],
  }));
  return { sources };
}
