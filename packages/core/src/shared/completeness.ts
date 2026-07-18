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
 *  - `absent` — never recorded by this source at all.
 *  - `not-recorded` — happens outside what this source observes (e.g.
 *    auxiliary API calls the session log has no channel to log).
 *  - `unknown` — completeness for this dimension/source pair hasn't been
 *    audited yet.
 */
export type CompletenessStatus = "partial" | "estimate" | "absent" | "not-recorded" | "unknown";

/** Session-log formats `sourceCompleteness` can describe. */
export type SourceKind = "claude-session-jsonl" | "codex-session-jsonl";

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

const SOURCE_TABLES: Readonly<Record<SourceKind, SourceCompletenessEntry["dimensions"]>> =
  Object.freeze({
    "claude-session-jsonl": CLAUDE_DIMENSIONS,
    "codex-session-jsonl": CODEX_DIMENSIONS,
  });

/** Stable declaration order regardless of input order — claude entry before codex. */
const SOURCE_ORDER: readonly SourceKind[] = Object.freeze([
  "claude-session-jsonl",
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
