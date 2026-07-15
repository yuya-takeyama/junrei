import type { CodexSessionJson, SessionJson, SubagentNodeJson, TimelineEntry } from "../../api.js";

type TurnUsage = SessionJson["turnUsage"][number];
type CodexTurn = CodexSessionJson["codex"]["turns"][number];
type UserEntry = Extract<TimelineEntry, { kind: "user" }>;

/**
 * One user turn's worth of the Timeline lens (docs/roadmap.md, "Unified
 * Timeline") — the source-neutral shape the turn-grouped spine renders,
 * regardless of which harness produced the session. Per the repo idiom in
 * `packages/core/src/shared/session-analysis.ts`: a field promoted here is
 * one both harnesses can honestly populate; a field left optional means
 * "this harness doesn't expose the concept" rather than "unknown source".
 * No field is typed against a harness's own usage shape (`ClaudeTurnUsage`,
 * `CodexTurnUsage`) — that detail stays inside the adapter that builds the
 * group.
 *
 * Built by `buildClaudeTurnGroups` for Claude Code's main transcript, or
 * `buildCodexTurnGroups` for a Codex rollout's own per-turn data — both
 * below.
 */
export interface TurnGroup {
  /** 1-based display number (turn order), not a source line. */
  index: number;
  /** The user entry that opened this turn — present whenever the transcript captured that prompt (see `buildClaudeTurnGroups`'s attribution comment for why it's always at `anchorLine`). */
  userEntry?: UserEntry;
  /** Every timeline entry attributed to this turn, in source order — includes compaction entries at their true position. */
  entries: TimelineEntry[];
  /** Unique models across the turn's `assistant-text` entries, then any additional models named only by a tool-only step, first-seen order in each pass. */
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
  /** Codex only — absent for every Claude turn; set by `buildCodexTurnGroups`. */
  reasoningTokens?: number;
  /** Claude only (`ClaudeTurnUsage.apiMessageCount`, now `steps.length` — see below) — absent for Codex turns, which are flat. */
  stepCount?: number;
  /**
   * Claude only — one entry per API call inside the turn
   * (`ClaudeTurnUsage.steps`), trimmed to what the UI reads: `line`/
   * `timestamp` are provenance the view never needs, so the adapter drops
   * them rather than leaking the wire shape into this source-neutral type.
   * Absent for Codex (`buildCodexTurnGroups` never sets it) — `StepsRow.tsx`
   * renders purely off this field's presence, no source check.
   */
  steps?: {
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Undefined when the step's own model was missing/unpriced — see `ClaudeTurnStep.costUsd` in `@junrei/core`. */
    costUsd?: number;
  }[];
  /** Claude only — sum of every step's own `costUsd` (ALL API calls in the turn, not just ones that emitted a text block); undefined only when the turn has zero priced steps. No concept for Codex. */
  costUsd?: number;
  /** True when the turn mixes priced and unpriced steps (a partial sum), or the session's own cost total is incomplete elsewhere. */
  costIncomplete: boolean;
  /**
   * Claude only — the OTHER half of per-turn cost (`costUsd` above is the
   * turn's own main-loop spend): cost of every subagent this turn launched,
   * summed from each `subagent-launch` entry's resolved SUBTREE cost (its
   * own usage plus every nested descendant's — see
   * `buildSubagentSubtreeCosts`), not the launch entry's own `costUsd`
   * (which prices the sidecar transcript alone, excluding nested children).
   * Defined only when the turn has >= 1 subagent-launch entry; Codex adapter
   * never sets it (hidden by presence — see `turnColumns.ts`'s `deleg`
   * column).
   */
  delegatedCostUsd?: number;
  /**
   * True when `delegatedCostUsd` is a partial sum: a launch couldn't be
   * joined to the subagent forest (no `agentId`, or one missing from it —
   * falls back to the launch entry's own, nested-excluding `costUsd`), a
   * joined subtree itself had incomplete pricing, or the session's own cost
   * total is incomplete elsewhere. Undefined whenever `delegatedCostUsd` is.
   */
  delegatedCostIncomplete?: boolean;
  toolErrorCount: number;
  /** Stable expand/override key and compaction-sibling anchor — the user prompt line that opened this turn (or the first entry's line, for the head-of-transcript turn with no captured prompt). */
  anchorLine: number;
}

export interface BuildTurnGroupsOptions {
  /** `session.totalUsage.costIsComplete` — folded into every turn's `costIncomplete` so a turn that looks fully priced in isolation still reads as approximate when the session has unpriced usage elsewhere (e.g. a subagent). */
  costIsComplete: boolean;
  /**
   * `session.subagents` — the session's own subagent forest, used to
   * attribute delegated cost to the turn whose `subagent-launch` entry
   * spawned each agent (see `buildSubagentSubtreeCosts`). Optional: a
   * session with no subagents (or the caller not passing any) just means no
   * group ever gets a `delegatedCostUsd`.
   */
  subagents?: readonly SubagentNodeJson[];
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

interface SubtreeCost {
  costUsd: number;
  costIsComplete: boolean;
}

/**
 * Top-level subagent `agentId` -> subtree cost — that node's own usage cost
 * plus every nested descendant's, recursively, with `costIsComplete` AND'd
 * across the whole subtree. Keyed by TOP-LEVEL agentId only: a
 * `subagent-launch` timeline entry only ever appears in the MAIN
 * transcript's timeline (a nested subagent's own launch happens inside its
 * PARENT's sidecar transcript, which this turn-grouped spine never walks),
 * so a launch entry's `agentId` can only ever name a root of the forest.
 *
 * This map exists because a `subagent-launch` entry's OWN `costUsd` comes
 * from core's `resolveSubagentUsage`, which prices that sidecar transcript
 * ALONE — nested children are excluded (see docs/roadmap.md's cost-fix
 * follow-up). Summing launch entries' `costUsd` directly would silently
 * undercount any subagent that itself delegated further.
 */
export function buildSubagentSubtreeCosts(
  roots: readonly SubagentNodeJson[],
): Map<string, SubtreeCost> {
  const subtreeOf = (node: SubagentNodeJson): SubtreeCost =>
    node.children.reduce<SubtreeCost>(
      (acc, child) => {
        const childCost = subtreeOf(child);
        return {
          costUsd: acc.costUsd + childCost.costUsd,
          costIsComplete: acc.costIsComplete && childCost.costIsComplete,
        };
      },
      { costUsd: node.usage.total.costUsd, costIsComplete: node.usage.total.costIsComplete },
    );

  const map = new Map<string, SubtreeCost>();
  for (const root of roots) {
    map.set(root.agentId, subtreeOf(root));
  }
  return map;
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

  const subtreeCosts = buildSubagentSubtreeCosts(opts.subagents ?? []);

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
    let toolErrorCount = 0;
    // Delegated cost: joined by agentId against `subtreeCosts` (nested
    // descendants included) below — a launch with no agentId, or one
    // missing from the forest, falls back to the launch entry's own
    // (nested-excluding) costUsd and flags the sum as an undercount.
    let delegatedCostUsd: number | undefined;
    let delegatedCostIncomplete = false;
    for (const entry of bucket) {
      if (entry.kind === "assistant-text") {
        if (entry.model !== undefined && !models.includes(entry.model)) models.push(entry.model);
      } else if (entry.kind === "tool-call" && entry.status === "error") {
        toolErrorCount += 1;
      } else if (entry.kind === "subagent-launch") {
        delegatedCostUsd ??= 0;
        const subtree = entry.agentId !== undefined ? subtreeCosts.get(entry.agentId) : undefined;
        if (subtree !== undefined) {
          delegatedCostUsd += subtree.costUsd;
          if (!subtree.costIsComplete) delegatedCostIncomplete = true;
        } else {
          if (entry.costUsd !== undefined) delegatedCostUsd += entry.costUsd;
          delegatedCostIncomplete = true;
        }
      }
    }
    if (delegatedCostUsd !== undefined && !opts.costIsComplete) delegatedCostIncomplete = true;

    // Cost (and the rest of the model list) comes from `usage.steps` — EVERY
    // priced API call in the turn, not just the ones with an assistant-text
    // entry above. A tool-use-only call still costs money; summing only
    // text-bearing entries silently dropped it (the bug this fixes — see
    // docs/roadmap.md). `costMissing` only flags a MIX of priced/unpriced
    // steps (a genuinely partial sum); a turn with zero priced steps has no
    // sum to be partial about, so it just renders as no-cost-data (undefined
    // costUsd) via the `present` check in turnColumns.ts.
    let costUsd: number | undefined;
    let hasPricedStep = false;
    let hasUnpricedStep = false;
    for (const step of usage.steps) {
      if (step.model !== undefined && !models.includes(step.model)) models.push(step.model);
      if (step.costUsd !== undefined) {
        costUsd = (costUsd ?? 0) + step.costUsd;
        hasPricedStep = true;
      } else {
        hasUnpricedStep = true;
      }
    }
    const costMissing = hasPricedStep && hasUnpricedStep;

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
      // Single source for the Steps column and the StepsRow breakdown below
      // it — both read `steps.length` rather than the separate
      // `apiMessageCount` field (the two are always equal; see
      // `computeTurnUsage`'s doc comment in `@junrei/core`).
      stepCount: usage.steps.length,
      steps: usage.steps.map((step) => ({
        ...(step.model !== undefined && { model: step.model }),
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        cacheReadTokens: step.cacheReadTokens,
        cacheCreationTokens: step.cacheCreationTokens,
        ...(step.costUsd !== undefined && { costUsd: step.costUsd }),
      })),
      ...(costUsd !== undefined && { costUsd }),
      costIncomplete: costMissing || !opts.costIsComplete,
      ...(delegatedCostUsd !== undefined && { delegatedCostUsd, delegatedCostIncomplete }),
      toolErrorCount,
      anchorLine: usage.line,
    };
  });
}

/**
 * Codex adapter: groups a flat rollout timeline into per-turn buckets, one
 * per `session.codex.turns` entry, and flattens each into the source-neutral
 * `TurnGroup` shape above.
 *
 * Codex turns carry no source line (unlike Claude's `turnUsage`, which is
 * line-anchored), so attribution mirrors `buildClaudeTurnGroups`'s line rule
 * with `startedAt` standing in for `line`: an entry belongs to the last turn
 * whose `startedAt <= entry.timestamp`, walking entries in source order.
 * Turns aren't trusted to already be sorted (nothing about the type
 * guarantees it), so they're sorted by `startedAt` first — a turn missing
 * `startedAt` has no timestamp to compare, so it reads as tied with its
 * neighbors and keeps its original position (`Array.sort` is stable). An
 * entry with no timestamp of its own, or one preceding the first turn's
 * `startedAt`, folds into whichever bucket is current rather than advancing
 * or being dropped.
 */
export function buildCodexTurnGroups(
  entries: readonly TimelineEntry[],
  turns: readonly CodexTurn[],
): TurnGroup[] {
  if (turns.length === 0) return [];

  const sortedTurns = turns.slice().sort((a, b) => {
    if (a.startedAt === undefined || b.startedAt === undefined) return 0;
    return Date.parse(a.startedAt) - Date.parse(b.startedAt);
  });

  const buckets: TimelineEntry[][] = sortedTurns.map(() => []);
  let turnIndex = 0;
  for (const entry of entries) {
    while (
      turnIndex + 1 < sortedTurns.length &&
      entry.timestamp !== undefined &&
      (sortedTurns[turnIndex + 1] as CodexTurn).startedAt !== undefined &&
      ((sortedTurns[turnIndex + 1] as CodexTurn).startedAt as string) <= entry.timestamp
    ) {
      turnIndex += 1;
    }
    (buckets[turnIndex] as TimelineEntry[]).push(entry);
  }

  return sortedTurns.map((turn, i) => {
    const bucket = buckets[i] as TimelineEntry[];
    // Unlike Claude's userEntry (matched by exact line), a Codex turn has no
    // owning line to match against — the first user-kind entry in its bucket
    // is the best available signal. Agent-initiated turns (e.g. a follow-up
    // the model kicks off on its own) legitimately have none.
    const userEntry = bucket.find((e): e is UserEntry => e.kind === "user");

    const models: string[] = [];
    if (turn.model !== undefined) models.push(turn.model);
    let toolErrorCount = 0;
    for (const entry of bucket) {
      if (entry.kind === "assistant-text") {
        if (entry.model !== undefined && !models.includes(entry.model)) models.push(entry.model);
      } else if (entry.kind === "tool-call" && entry.status === "error") {
        toolErrorCount += 1;
      }
    }

    const index = i + 1;
    // An empty bucket (an agent-initiated turn folded no entries, or a
    // degenerate zero-event turn) has no real line to anchor on. The
    // negative, index-derived fallback is unique per turn and never
    // collides with a real (always >= 1) source line, so expand-override
    // keys and React `key`s stay collision-free.
    const anchorLine = bucket[0]?.line ?? -(index + 1);

    return {
      index,
      ...(userEntry !== undefined && { userEntry }),
      entries: bucket,
      models,
      ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
      ...(turn.durationMs !== undefined && { durationMs: turn.durationMs }),
      inputTokens: turn.inputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      outputTokens: turn.outputTokens,
      reasoningTokens: turn.reasoningOutputTokens,
      costIncomplete: false,
      toolErrorCount,
      anchorLine,
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
