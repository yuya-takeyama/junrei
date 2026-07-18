/**
 * Cross-harness usage/file-access vocabulary — the subset of `metrics.ts`
 * both Claude Code and Codex populate with the exact same shapes, split out
 * so `codex/*.ts` no longer needs to reach into Claude-specific modules for
 * plain data types and merge helpers. Harness-specific computation (e.g.
 * Claude's `computeUsage`/`computeFileAccess`, which read Claude's own
 * `SessionData`) stays in `claude/metrics.ts`.
 */

import type { SubagentNode } from "./subagent-node.js";

// ---------------------------------------------------------------------------
// Tokens & cost
// ---------------------------------------------------------------------------

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelUsageSummary extends TokenTotals {
  model: string;
  messageCount: number;
  /** undefined when the model has no known pricing. */
  costUsd?: number;
  /** The cache-creation ("cache write") slice of costUsd; undefined under the same conditions as costUsd. */
  cacheWriteCostUsd?: number;
}

export interface UsageSummary {
  byModel: ModelUsageSummary[];
  total: TokenTotals & { costUsd: number; costIsComplete: boolean; cacheWriteCostUsd?: number };
}

/** Token totals sufficient to compute a cache-hit rate — see `cacheHitRate`. */
export interface CacheableTokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Fraction of "effective input" tokens (input + cache-read + cache-creation)
 * actually served from cache. Moved here (Phase 1 of the trends feature,
 * `./trends.ts`) from the web package's `format.ts`, which had the only
 * existing copy of this formula (session-level stat strip and agent detail
 * shell) — promoted so the server-side trends aggregate can share the exact
 * same definition instead of inventing a second one. `format.ts` keeps its
 * own copy for now (not yet migrated to import from here); keep the two in
 * lockstep until web is updated to import this one.
 *
 * Returns 0 (not a sentinel) when there's no effective-input volume at all —
 * a caller that needs to distinguish "0% real hit rate" from "no tokens to
 * rate" (e.g. `trends.ts`'s per-bucket `cacheHitRate: number | null`) checks
 * the denominator itself before calling this.
 */
export function cacheHitRate(totals: CacheableTokenTotals): number {
  const denominator = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return denominator > 0 ? totals.cacheReadTokens / denominator : 0;
}

/**
 * Merge per-model usage summaries from a main transcript's own usage and
 * every node of a subagent forest (recursively), keyed by model id — mirrors
 * how `totalUsage` merges the flat token/cost totals, but preserves the
 * per-model breakdown so the Overview lens's "cost by model" chart reflects
 * delegated spend too. Shared (not Claude-only) because Codex's server-side
 * parent aggregation (`packages/server/src/sources/codex.ts`) needs the exact
 * same merge over its own `SubagentNode` forest — see `codex/orchestration.ts`.
 */
export function mergeUsageByModel(
  main: readonly ModelUsageSummary[],
  subagents: readonly SubagentNode[],
): ModelUsageSummary[] {
  const totals = new Map<string, ModelUsageSummary>();
  const add = (entries: readonly ModelUsageSummary[]) => {
    for (const entry of entries) {
      const existing = totals.get(entry.model);
      if (existing === undefined) {
        totals.set(entry.model, { ...entry });
        continue;
      }
      existing.messageCount += entry.messageCount;
      existing.inputTokens += entry.inputTokens;
      existing.outputTokens += entry.outputTokens;
      existing.cacheReadTokens += entry.cacheReadTokens;
      existing.cacheCreationTokens += entry.cacheCreationTokens;
      if (entry.costUsd !== undefined) {
        existing.costUsd = (existing.costUsd ?? 0) + entry.costUsd;
      }
      if (entry.cacheWriteCostUsd !== undefined) {
        existing.cacheWriteCostUsd = (existing.cacheWriteCostUsd ?? 0) + entry.cacheWriteCostUsd;
      }
    }
  };
  add(main);
  const visit = (nodes: readonly SubagentNode[]) => {
    for (const node of nodes) {
      add(node.usage.byModel);
      visit(node.children);
    }
  };
  visit(subagents);
  return [...totals.values()];
}

/**
 * The model responsible for the most INPUT tokens among `byModel` entries —
 * used as a single transcript's "dominant model" label when its own API
 * messages span more than one model (a mid-session model switch), e.g. a
 * thread's model tag for `shared/bash-stats.ts`'s $ weighting. Ties keep
 * whichever entry appeared first in `byModel`. `undefined` for an empty list.
 */
export function dominantModelByInputTokens(
  byModel: readonly ModelUsageSummary[],
): string | undefined {
  let best: ModelUsageSummary | undefined;
  for (const entry of byModel) {
    if (best === undefined || entry.inputTokens > best.inputTokens) best = entry;
  }
  return best?.model;
}

// ---------------------------------------------------------------------------
// Context timeline
// ---------------------------------------------------------------------------

export interface ContextPoint {
  messageId: string;
  timestamp?: string;
  line: number;
  /** input + cache_read + cache_creation — the effective request context. */
  contextTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// File access (Files & skills lens, row 1)
// ---------------------------------------------------------------------------

/** One transcript's own read/edit/injection tally for a single file path. */
export interface FileAccessAgg {
  path: string;
  reads: number;
  edits: number;
  /**
   * Count of times this path's content was pushed into context WITHOUT a
   * Read/Edit tool call — CLAUDE.md/MEMORY.md "Contents of ...:" system-reminder
   * headers and Skill `SKILL.md` loads (Claude only — see
   * `claude/metrics.ts#computeFileAccess`). A path can be injected-only
   * (reads/edits both 0) — it was loaded into context, just never opened by
   * the agent itself.
   */
  injectedCount?: number;
  /** Cumulative injected character count, paired with `injectedCount`. */
  injectedChars?: number;
  /**
   * Codex AGENTS.md merges only (see `codex/files-skills.ts`): chars of the
   * user-level (`~/.codex/AGENTS.md`) half of the injected doc. Present only
   * when the `--- project-doc ---` separator proved both halves exist — a
   * separator-less injection can't be attributed to either level honestly.
   * The two halves don't sum to `injectedChars` (the separator itself is
   * counted only there).
   */
  injectedUserDocChars?: number;
  /** Paired with `injectedUserDocChars` — chars of the project-level AGENTS.md half. */
  injectedProjectDocChars?: number;
  /** Earliest timestamp among this transcript's touches of the path. */
  firstTimestamp?: string;
  /** Earliest line among this transcript's touches of the path. */
  firstLine?: number;
}

export type FileAccessThread = "main" | "subagent" | "both";

export interface FileAccessEntry {
  /** Path as given in the tool input (absolute). */
  path: string;
  /** Read + NotebookRead calls, main + every subagent, merged. */
  reads: number;
  /** Edit + Write + MultiEdit + NotebookEdit calls, main + every subagent, merged. */
  edits: number;
  /** Context injections of this path, main + every subagent, merged — see `FileAccessAgg.injectedCount`. */
  injectedCount?: number;
  /** Cumulative injected character count, paired with `injectedCount`. */
  injectedChars?: number;
  /** User-level AGENTS.md chars, main + every subagent, merged — see `FileAccessAgg.injectedUserDocChars`. */
  injectedUserDocChars?: number;
  /** Paired with `injectedUserDocChars` — chars of the project-level AGENTS.md half. */
  injectedProjectDocChars?: number;
  /** Earliest timestamp across every transcript that touched this path. */
  firstTouchTimestamp?: string;
  /** Line of the first MAIN-transcript touch, if any — omitted when only subagents touched the path. */
  firstTouchLine?: number;
  threads: FileAccessThread;
}

export interface FileAccessResult {
  fileAccess: FileAccessEntry[];
  /** True when the merged path count exceeded the cap and entries were dropped. */
  fileAccessTruncated: boolean;
  /** Number of distinct paths dropped by the cap — present only when truncated. */
  fileAccessOmittedCount?: number;
}

const FILE_ACCESS_CAP = 500;

/**
 * Merge one main transcript's file-access map with the (already-summed)
 * combined map from every subagent transcript, then cap the result — see
 * `FileAccessEntry`'s field docs for the exact semantics of each derived
 * field (`firstTouchLine` only ever comes from the main transcript;
 * `firstTouchTimestamp` is the earliest across all transcripts).
 *
 * Cap: when the merged path count exceeds `FILE_ACCESS_CAP`, keep the 500
 * paths with the highest `reads + edits`, breaking ties by path (stable)
 * so the kept set is deterministic — then re-sort the kept entries back to
 * path order for display.
 */
export function mergeFileAccess(
  main: ReadonlyMap<string, FileAccessAgg>,
  subagents: ReadonlyMap<string, FileAccessAgg>,
): FileAccessResult {
  const paths = new Set([...main.keys(), ...subagents.keys()]);
  const entries: FileAccessEntry[] = [];
  for (const path of paths) {
    const m = main.get(path);
    const s = subagents.get(path);
    const reads = (m?.reads ?? 0) + (s?.reads ?? 0);
    const edits = (m?.edits ?? 0) + (s?.edits ?? 0);
    const injectedCount = (m?.injectedCount ?? 0) + (s?.injectedCount ?? 0);
    const injectedChars = (m?.injectedChars ?? 0) + (s?.injectedChars ?? 0);
    const injectedUserDocChars = (m?.injectedUserDocChars ?? 0) + (s?.injectedUserDocChars ?? 0);
    const injectedProjectDocChars =
      (m?.injectedProjectDocChars ?? 0) + (s?.injectedProjectDocChars ?? 0);
    const threads: FileAccessThread =
      m !== undefined && s !== undefined ? "both" : m !== undefined ? "main" : "subagent";
    let firstTouchTimestamp: string | undefined;
    if (m?.firstTimestamp !== undefined && s?.firstTimestamp !== undefined) {
      firstTouchTimestamp =
        m.firstTimestamp < s.firstTimestamp ? m.firstTimestamp : s.firstTimestamp;
    } else {
      firstTouchTimestamp = m?.firstTimestamp ?? s?.firstTimestamp;
    }
    entries.push({
      path,
      reads,
      edits,
      ...(injectedCount > 0 && { injectedCount }),
      ...(injectedChars > 0 && { injectedChars }),
      ...(injectedUserDocChars > 0 && { injectedUserDocChars }),
      ...(injectedProjectDocChars > 0 && { injectedProjectDocChars }),
      ...(firstTouchTimestamp !== undefined && { firstTouchTimestamp }),
      ...(m?.firstLine !== undefined && { firstTouchLine: m.firstLine }),
      threads,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length <= FILE_ACCESS_CAP) {
    return { fileAccess: entries, fileAccessTruncated: false };
  }

  const omittedCount = entries.length - FILE_ACCESS_CAP;
  // Injections count toward the keep-score too — an injected-only file (e.g.
  // CLAUDE.md) would otherwise always score 0 and be the first dropped.
  const score = (e: FileAccessEntry) => e.reads + e.edits + (e.injectedCount ?? 0);
  const kept = [...entries]
    .sort((a, b) => {
      const scoreDiff = score(b) - score(a);
      return scoreDiff !== 0 ? scoreDiff : a.path.localeCompare(b.path);
    })
    .slice(0, FILE_ACCESS_CAP)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { fileAccess: kept, fileAccessTruncated: true, fileAccessOmittedCount: omittedCount };
}

/** Fold `source` into `target` in place — sums reads/edits/injections, keeps the earliest timestamp/line. */
export function foldFileAccess(
  target: Map<string, FileAccessAgg>,
  source: ReadonlyMap<string, FileAccessAgg>,
): void {
  for (const [path, entry] of source) {
    const existing = target.get(path);
    if (existing === undefined) {
      target.set(path, { ...entry });
      continue;
    }
    existing.reads += entry.reads;
    existing.edits += entry.edits;
    if (entry.injectedCount !== undefined) {
      existing.injectedCount = (existing.injectedCount ?? 0) + entry.injectedCount;
    }
    if (entry.injectedChars !== undefined) {
      existing.injectedChars = (existing.injectedChars ?? 0) + entry.injectedChars;
    }
    if (entry.injectedUserDocChars !== undefined) {
      existing.injectedUserDocChars =
        (existing.injectedUserDocChars ?? 0) + entry.injectedUserDocChars;
    }
    if (entry.injectedProjectDocChars !== undefined) {
      existing.injectedProjectDocChars =
        (existing.injectedProjectDocChars ?? 0) + entry.injectedProjectDocChars;
    }
    if (
      entry.firstTimestamp !== undefined &&
      (existing.firstTimestamp === undefined || entry.firstTimestamp < existing.firstTimestamp)
    ) {
      existing.firstTimestamp = entry.firstTimestamp;
    }
    if (
      entry.firstLine !== undefined &&
      (existing.firstLine === undefined || entry.firstLine < existing.firstLine)
    ) {
      existing.firstLine = entry.firstLine;
    }
  }
}

// ---------------------------------------------------------------------------
// Skill invocations (Files & skills lens, row 1 right column)
// ---------------------------------------------------------------------------

export interface SkillInvocation {
  /** Skill tool call vs a `<command-name>` slash-command user record. */
  kind: "skill" | "command";
  /** `input.skill` for a Skill call, or the command name (incl. leading "/") for a slash command. */
  name: string;
  /** `input.args` / `<command-args>` content, capped at `DETAIL_LIMIT` chars. */
  argsPreview?: string;
  line: number;
  timestamp?: string;
  /** 1-based user-turn index — same greatest-prompt-line-<= attribution as `computeTurnUsage`. */
  userTurn?: number;
  /**
   * Skill tool only: full (untruncated) length of the tool_result text, when
   * known. For a `Skill` call this is just the ~44-char "Launching skill: …"
   * acknowledgment — see `injectedChars` for the actual context payload.
   */
  resultChars?: number;
  /**
   * Skill tool only: full length of the harness-injected SKILL.md body (the
   * `isMeta` user record matched via `findInjection`), when found. This — not
   * `resultChars` — is the number that matters for context/cost analysis.
   * Undefined when no matching injection record exists: older transcript
   * formats, or skills whose frontmatter renders a templated prompt instead
   * of injecting the file verbatim (observed for `commit-commands:*`, whose
   * injected text starts with "## Context", never "Base directory for this
   * skill:") — never guessed.
   */
  injectedChars?: number;
  /** Source line of the matched injection record (provenance), paired with `injectedChars`. */
  injectionLine?: number;
}
