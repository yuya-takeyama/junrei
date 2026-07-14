import type { SessionJson, TimelineEntry } from "../../api.js";

type TurnUsage = SessionJson["turnUsage"][number];
type UserEntry = Extract<TimelineEntry, { kind: "user" }>;

/**
 * One user turn's worth of the Timeline lens (docs/roadmap.md, "Unified
 * Timeline") — the source-neutral shape the turn-grouped spine renders,
 * regardless of which harness produced the session. Per the repo idiom in
 * `packages/core/src/shared/session-analysis.ts`: a field promoted here is
 * one both harnesses can honestly populate; a field left optional means
 * "this harness doesn't expose the concept" rather than "unknown source".
 * No field is typed against a harness's own usage shape (`ClaudeTurnUsage`,
 * a future `CodexTurnUsage`) — that detail stays inside the adapter that
 * builds the group.
 *
 * Built by `buildClaudeTurnGroups` below for Claude Code's main transcript;
 * Phase 2 adds a `buildCodexTurnGroups` beside it producing this same shape
 * from Codex's own per-turn data.
 */
export interface TurnGroup {
  /** 1-based display number (turn order), not a source line. */
  index: number;
  /** The user entry that opened this turn — present whenever the transcript captured that prompt (see `buildClaudeTurnGroups`'s attribution comment for why it's always at `anchorLine`). */
  userEntry?: UserEntry;
  /** Every timeline entry attributed to this turn, in source order — includes compaction entries at their true position. */
  entries: TimelineEntry[];
  /** Unique models across the turn's `assistant-text` entries, first-seen order. */
  models: string[];
  startedAt?: string;
  /** Codex: native turn duration; Claude: derived from entry timestamps. */
  durationMs?: number;
  /** Fresh (uncached) input tokens. */
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** Claude only — absent means the harness has no cache-write concept (Codex). The Claude adapter always sets it. */
  cacheCreationTokens?: number;
  /** Codex only — absent for every Claude turn; set by Phase 2's `buildCodexTurnGroups`. */
  reasoningTokens?: number;
  /** Claude only (`ClaudeTurnUsage.apiMessageCount`) — absent for Codex turns, which are flat. */
  stepCount?: number;
  /** Claude only (derived from `assistant-text` entries); undefined = no concept for this harness. */
  costUsd?: number;
  /** True when an `assistant-text` entry in the turn lacks `costUsd` (unpriced model), or the session's own cost total is incomplete elsewhere. */
  costIncomplete: boolean;
  toolErrorCount: number;
  /** Stable expand/override key and compaction-sibling anchor — the user prompt line that opened this turn (or the first entry's line, for the head-of-transcript turn with no captured prompt). */
  anchorLine: number;
}

export interface BuildTurnGroupsOptions {
  /** `session.totalUsage.costIsComplete` — folded into every turn's `costIncomplete` so a turn that looks fully priced in isolation still reads as approximate when the session has unpriced usage elsewhere (e.g. a subagent). */
  costIsComplete: boolean;
}

/**
 * Same shape as `durationBetween` in `@junrei/core`'s `shared/timeline.ts`,
 * reimplemented locally rather than imported — the web package never reaches
 * into `@junrei/core` at runtime (see api.ts: everything crosses the
 * client/server boundary through Hono RPC-inferred types instead).
 */
function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const delta = Date.parse(end) - Date.parse(start);
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

/**
 * Claude Code adapter: groups a flat main-transcript timeline into per-turn
 * buckets, one per `session.turnUsage` entry, and flattens each into the
 * source-neutral `TurnGroup` shape above.
 *
 * Attribution mirrors `computeTurnUsage` in `@junrei/core`'s
 * `claude/metrics.ts` exactly: an entry belongs to the turn opened by the
 * greatest `turn.line <= entry.line` (so an entry exactly at the NEXT turn's
 * line — that turn's own user prompt — belongs to that next turn), and
 * anything before the first turn folds into it. Every timeline entry is
 * walked, including compactions, so a compaction always lands in the turn
 * whose activity precedes it (see Timeline.tsx for how that turn renders it
 * as a trailing sibling row when collapsed).
 */
export function buildClaudeTurnGroups(
  entries: readonly TimelineEntry[],
  turnUsage: readonly TurnUsage[],
  opts: BuildTurnGroupsOptions,
): TurnGroup[] {
  if (turnUsage.length === 0) return [];

  const buckets: TimelineEntry[][] = turnUsage.map(() => []);
  let turnIndex = 0;
  for (const entry of entries) {
    while (
      turnIndex + 1 < turnUsage.length &&
      (turnUsage[turnIndex + 1] as TurnUsage).line <= entry.line
    ) {
      turnIndex += 1;
    }
    (buckets[turnIndex] as TimelineEntry[]).push(entry);
  }

  return turnUsage.map((usage, i) => {
    const bucket = buckets[i] as TimelineEntry[];
    const userEntry = bucket.find(
      (e): e is UserEntry => e.kind === "user" && e.line === usage.line,
    );

    const models: string[] = [];
    let costUsd: number | undefined;
    let costMissing = false;
    let toolErrorCount = 0;
    for (const entry of bucket) {
      if (entry.kind === "assistant-text") {
        if (entry.model !== undefined && !models.includes(entry.model)) models.push(entry.model);
        if (entry.costUsd !== undefined) costUsd = (costUsd ?? 0) + entry.costUsd;
        else costMissing = true;
      } else if (entry.kind === "tool-call" && entry.status === "error") {
        toolErrorCount += 1;
      }
    }

    const startedAt = usage.timestamp ?? userEntry?.timestamp;
    const lastEntry = bucket[bucket.length - 1];
    const durationMs = durationBetween(startedAt, lastEntry?.timestamp);

    return {
      index: i + 1,
      ...(userEntry !== undefined && { userEntry }),
      entries: bucket,
      models,
      ...(startedAt !== undefined && { startedAt }),
      ...(durationMs !== undefined && { durationMs }),
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      stepCount: usage.apiMessageCount,
      ...(costUsd !== undefined && { costUsd }),
      costIncomplete: costMissing || !opts.costIsComplete,
      toolErrorCount,
      anchorLine: usage.line,
    };
  });
}

const OUTLIER_SHARE = 0.25;
const OUTLIER_MIN_USD = 0.1;

/**
 * A turn "pops" (the mock's amber `.tint` row) when it eats an outsized
 * share of the session's per-turn cost. Two conditions, both required: a
 * relative share alone would flag ordinary turns in a cheap session, so it's
 * paired with an absolute floor — together they spot the expensive turn at a
 * glance without hand-picking a fixed dollar threshold per session.
 */
export function isOutlierTurn(turnCostUsd: number | undefined, totalCostUsd: number): boolean {
  if (turnCostUsd === undefined || totalCostUsd <= 0) return false;
  return turnCostUsd / totalCostUsd > OUTLIER_SHARE && turnCostUsd >= OUTLIER_MIN_USD;
}

/** Sum of every turn's own `costUsd` (turns with no cost data contribute 0) — the denominator `isOutlierTurn` compares each turn's share against. */
export function sumTurnCosts(groups: readonly Pick<TurnGroup, "costUsd">[]): number {
  return groups.reduce((sum, g) => sum + (g.costUsd ?? 0), 0);
}

/**
 * How many leading (whole) turns fit an entry-count budget — the turn-
 * grouped spine's analog of the flat Timeline's 500-entry chunking, but
 * landing the "show more" boundary between turns rather than mid-turn.
 * Keeps adding whole turns while the running total is still under budget, so
 * the turn that finally crosses the threshold is included in full (a single
 * huge turn is never split, matching the flat path always rendering at
 * least one item).
 */
export function turnsUpToBudget(
  groups: readonly Pick<TurnGroup, "entries">[],
  budget: number,
): number {
  let cumulative = 0;
  for (let i = 0; i < groups.length; i++) {
    if (cumulative >= budget) return i;
    cumulative += (groups[i] as Pick<TurnGroup, "entries">).entries.length;
  }
  return groups.length;
}
