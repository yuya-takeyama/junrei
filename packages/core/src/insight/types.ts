/**
 * Domain types for the insight layer — the "conclusion-first" composition
 * tier that sits ON TOP of the raw analysis functions (`trends`, `bashStats`,
 * `delegation`, `subagents`, `search`) and reshapes their output into
 * answers an agent can act on in one read.
 *
 * The learning ledger (`Learning`) is the persistent side of this tier: a
 * repo-local, git-committable record of "what did we learn about how this
 * repo's agents behave, and did changing it help" — stored one file per
 * learning under `<repoRoot>/.junrei/learnings/` (see `learningsStore.ts`).
 */
import type { SessionSource } from "../shared/session-analysis.js";

/**
 * Lifecycle of a single learning. `open` -> `applied` -> (`verified` |
 * `rejected`) is the intended forward path, but transitions are not enforced
 * here (a human can move a learning anywhere) — `updateLearning` only
 * timestamps the two structural boundaries (`applied` sets `appliedAt`,
 * `verified`/`rejected` set `resolvedAt`).
 */
export type LearningStatus = "open" | "applied" | "verified" | "rejected";

/** One session that contributed evidence for a learning. */
export interface LearningSource {
  source: SessionSource;
  sessionId: string;
  title?: string;
}

/**
 * Optional before/after measurement attached once a learning has been applied
 * long enough to compare. `windowDays` is the comparison window on each side;
 * `metric` names what `before`/`after` measure (e.g. `"avgSessionCostUsd"`).
 */
export interface LearningVerification {
  metric: string;
  before: number;
  after: number;
  windowDays: number;
  note?: string;
}

export interface Learning {
  /** `L-YYYYMMDD-<slug>` — see `learningsStore.ts`'s id derivation. */
  id: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Normalized repo name this learning belongs to. */
  repo: string;
  sourceSessions: LearningSource[];
  /** What was observed. */
  finding: string;
  /** What to change in response. */
  change: string;
  /** What the change is expected to improve. */
  expectedEffect?: string;
  status: LearningStatus;
  proposedBy: "agent" | "human";
  /** ISO timestamp the learning moved to `applied`. */
  appliedAt?: string;
  /** ISO timestamp the learning moved to `verified` or `rejected`. */
  resolvedAt?: string;
  verification?: LearningVerification;
}

/**
 * Response-size control shared by every composition function. `concise`
 * trims lists to their headline entries (and sets `_meta.truncated` when it
 * dropped anything); `full` returns everything.
 */
export type Detail = "concise" | "full";

/**
 * One capped list's shown/total counts, so a caller can tell exactly what
 * was cut instead of just that *something* was. `path` is a dot-path from
 * the payload root to the capped array (e.g. `"waste"`, or `"learnings.recent"`
 * when the array is nested).
 */
export interface TruncatedField {
  path: string;
  shown: number;
  total: number;
}

/**
 * Envelope every insight response carries. `approxTokens` is a cheap size
 * estimate (`JSON.stringify(payload).length / 4`, see `meta.ts`) so a caller
 * can budget context before spending it; `nextSteps` is ALWAYS populated on
 * empty/error paths (and usually otherwise) so a response never dead-ends —
 * it always tells the agent what to call next.
 */
export interface InsightMeta {
  approxTokens: number;
  /** Set true when `detail: "concise"` (or a hard cap) dropped entries from any list. */
  truncated?: boolean;
  /**
   * Per-section detail on what got cut. Present only when at least one list
   * was capped — and whenever present, `truncated` is always `true` too (the
   * coarse flag and the detailed list can never disagree).
   */
  truncatedFields?: TruncatedField[];
  /** What the agent should do / call next — never omitted on empty or error results. */
  nextSteps?: string[];
}

/** A finding an agent should act on, ranked by dollar impact where known. */
export interface WasteItem {
  /**
   * Stable class of the finding — the four Bash-opportunity classes,
   * `oversized-return` (a subagent that dumped a large result back into its
   * parent's context), plus the two archetype-lever classes the briefing
   * surfaces from the cost-performance study: `marathon-context` (a
   * main-cost-dominated session that ran to a huge, never-compacted context —
   * study rule A1/R1) and `fan-out-turn-budget` (a fan-out session with a
   * subagent past the ~60-tool-call turn budget — A5/R4).
   */
  class:
    | "bash-as-read"
    | "large-result"
    | "near-duplicate"
    | "rerun-after-error"
    | "oversized-return"
    | "marathon-context"
    | "fan-out-turn-budget";
  /** Human-readable headline. */
  title: string;
  /** Copy-ready, imperative fix. */
  fix: string;
  /**
   * Estimated dollars this finding cost (and that fixing it would save).
   * `undefined` when the contributing work couldn't be priced — never `0`
   * for "unknown"; items with a known impact always rank above unknown ones.
   */
  impactUsd?: number;
  /** Where the finding was observed. */
  provenance: {
    source: SessionSource;
    sessionId: string;
    title?: string;
  };
}
