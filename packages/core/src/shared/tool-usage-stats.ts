/**
 * Harness-neutral cross-tool usage analytics engine — the "Tools (All)" lens's
 * data layer, modeled directly on `./bash-stats.ts` (which drills into ONE
 * tool, Bash) but generalized to EVERY tool a session called. Operates only on
 * the neutral `NeutralToolCall`/`NeutralToolThread` shapes below; each
 * harness's own adapter (`claude/tool-usage-stats.ts`, `codex/tool-usage-stats.ts`)
 * maps its records into this shape and calls `computeToolUsageStats`.
 *
 * Relationship to `bash-stats.ts`: this engine is a SIBLING, not a replacement.
 * `bash-stats.ts` ranks Bash *commands* (family/subcommand, waste detection,
 * background tasks — all Bash-specific); this engine ranks *tools* (Read, Edit,
 * Bash, WebFetch, …) by their context-cost contribution. A Bash row appears
 * here too, as the aggregate of every Bash call — `get_bash_stats` / the Bash
 * sub-tab is the per-command drill-down beneath it.
 *
 * Joint pass, same rationale as `bash-stats.ts`: `heavyHitters` (top 10 across
 * every tool AND thread) and `byTool[].sharePct` are global rankings that
 * can't be reconstructed from independently-computed per-thread top-N lists, so
 * everything is computed in ONE pass over the combined call list. Per-thread
 * attribution is preserved on every entry that names a specific call (`thread`
 * = `"main"` or a subagent's id).
 *
 * Estimation & $ weighting are IDENTICAL to `bash-stats.ts` — `estimatedTokens`
 * is `Math.ceil(resultChars / 4)` (imported `estimateTokens`, no real
 * tokenizer), and every `estUsd?` is `estUsdForChars(resultChars, thread model)`
 * priced at the OWNING thread's model input rate (imported from
 * `bash-stats.ts` so both engines price identically), NEVER a chars-only
 * stand-in. `undefined` (never `0`) means "couldn't price", so callers tell
 * genuinely-free apart from unknown-model. Unlike `bash-stats.ts`, there is NO
 * `inputChars` in `totals`/`byTool`: a tool's input is its structured
 * parameters, not context chars the way a Bash command line is, so it isn't
 * summed — `estimatedTokens` here is result-chars only. `byThread` DOES carry
 * an `inputChars` field (always `0`) purely to keep its shape byte-for-byte
 * identical to `bash-stats.ts`'s `BashThreadGroup`, so the web "Who paid" panel
 * renders against either engine's `byThread` unchanged.
 */

import type { BashThreadGroup } from "./bash-stats.js";
import { estimateTokens, estUsdForChars } from "./bash-stats.js";
import type { ToolErrorCategory } from "./tool-error.js";

export interface ToolUsageTotals {
  calls: number;
  errors: number;
  /** Sum of each call's result char count (0 for calls with no recorded result). */
  resultChars: number;
  /** `Math.ceil(resultChars / 4)` — result chars only (no inputChars concept for tools); see the module doc comment. */
  estimatedTokens: number;
  /**
   * Partial sum of every non-placeholder call's `estUsdForChars(resultChars,
   * thread's model)` that resolved to a real price — silently skips any call
   * whose thread has no priced model (or whose result is a placeholder), so
   * this is "known-priced tool $ spend", not "total". `undefined` only when
   * NOT ONE call anywhere resolved a price — never `0` for "nothing priced".
   * Same rule as `BashTotals.estUsd`.
   */
  estUsd?: number;
}

/** One tool's cross-thread rollup — the "Tools (All)" ranking's row. Sorted by `estUsd` desc (see `computeByTool`). */
export interface ToolGroup {
  /** Tool name — `"Bash"`, `"Read"`, `"Edit"`, `"WebFetch"`, a Codex `"shell"`/`"apply_patch"`/`"exec"`, … (raw wire name, per adapter). */
  name: string;
  calls: number;
  errors: number;
  /**
   * Per-category tally of this tool's errored calls — every errored call
   * contributes exactly one increment (`errorCategory ?? "other"`), so the
   * values sum to `errors`. Claude classifies via `classifyToolError` over the
   * tool_result text; Codex has no result text to classify, so its errored
   * calls all fall under `"other"` (see `codex/tool-usage-stats.ts`). Renders
   * the design's errors-by-tool × category matrix.
   */
  errorCategories: Partial<Record<ToolErrorCategory, number>>;
  resultChars: number;
  /** `Math.ceil(resultChars / 4)`. */
  estimatedTokens: number;
  /** Same partial-sum/never-0-for-unknown rule as `ToolUsageTotals.estUsd`, scoped to this tool's own calls. */
  estUsd?: number;
  /** This tool's share of `ToolUsageStats.totals.resultChars`, 0-100 rounded to 1 decimal. `0` when totals.resultChars is 0. */
  sharePct: number;
  /**
   * Share (0-100, 1 decimal) of this tool's OWN `resultChars` that sat in the
   * `"main"` (orchestrator) thread vs. a subagent's — same semantics as
   * `BashCommandGroup.orchestratorSharePct`. Always computable from thread
   * names alone (no pricing dependency); `0` when `resultChars` is 0 or no
   * call came from `"main"`.
   */
  orchestratorSharePct?: number;
}

/**
 * Top call across all tools by `resultChars` — same provenance a Bash heavy
 * hitter carries (`thread`, source `line`, stable `id`, priced `estUsd`),
 * adapted: the `tool` name replaces Bash's `command`/`family`, and the owning
 * thread's `model` is carried explicitly (a Bash heavy hitter leaves model
 * implicit in its single-tool context; here, across every tool AND thread, the
 * model is worth surfacing directly).
 */
export interface ToolHeavyHitter {
  tool: string;
  thread: string;
  /** The owning thread's model, when the adapter supplied one. */
  model?: string;
  resultChars: number;
  /** `Math.ceil(resultChars / 4)`. */
  estimatedTokens: number;
  /** Same rule as `BashHeavyHitter.estUsd` — priced from this call's own `resultChars` at its thread's model; `undefined` when unknown or a placeholder result. */
  estUsd?: number;
  /** 1-based source line of the call — provenance anchor. */
  line: number;
  /** Stable per-call id — Claude's `toolUseId`, Codex's `call_id` (or synthesized fallback). */
  id: string;
  /** `true` only when `resultChars` is a synthesized placeholder (never priced) — omitted otherwise. */
  resultIsPlaceholder?: boolean;
}

export interface ToolUsageStats {
  totals: ToolUsageTotals;
  /** One row per tool, sorted by `estUsd` desc (unknown-price rows last), then resultChars desc, then name. */
  byTool: ToolGroup[];
  /**
   * Per-thread rollup — the SAME shape as `bash-stats.ts`'s `BashThreadGroup`
   * (reused as the element type) so the web "Who paid" panel renders against
   * either engine's `byThread` unchanged. `inputChars` is always `0` here (see
   * the module doc comment). Sorted by `resultChars` desc.
   */
  byThread: BashThreadGroup[];
  /** Top 10 calls by `resultChars`, across every tool and thread. */
  heavyHitters: ToolHeavyHitter[];
}

/** One harness-neutral tool call — reduced to just what the cross-tool rollup needs. Mirrors `NeutralBashCall`, minus the Bash-only `command` (a tool's input is params, not a command line). */
export interface NeutralToolCall {
  /** Stable per-call id — Claude's `toolUseId`, Codex's `call_id`. Surfaces on `ToolHeavyHitter.id`. */
  id: string;
  /** 1-based source line of the call — provenance anchor for `heavyHitters`. */
  line: number;
  /** Tool name (raw wire name). */
  tool: string;
  /** Result char count — 0 when no result/output text is recorded. */
  resultChars: number;
  /** Defaults to `false` when omitted. */
  isError?: boolean;
  /** Pre-classified error category, when the adapter could derive one (Claude does; Codex can't — see `ToolGroup.errorCategories`). An errored call with no category tallies under `"other"`. */
  errorCategory?: ToolErrorCategory;
  /** `true` when `resultChars` is a synthesized placeholder rather than real captured output — excluded from every `estUsd` sum. Defaults to `false`. Same meaning as `NeutralBashCall.resultIsPlaceholder`. */
  resultIsPlaceholder?: boolean;
}

/** One thread's neutral tool-call list, tagged with attribution (`"main"` or a subagent id) and its own dominant model for $ weighting. Mirrors `NeutralBashThread`. */
export interface NeutralToolThread {
  thread: string;
  /** This thread's own dominant model, when the adapter can supply one — `undefined` when unknown (never guessed); every `estUsd` from this thread's calls stays `undefined` too. */
  model?: string;
  calls: NeutralToolCall[];
}

const HEAVY_HITTER_LIMIT = 10;

/**
 * The harness-wide convention for "the top-level transcript, not a subagent" —
 * the `ToolGroup.orchestratorSharePct` reference thread, same constant value
 * `bash-stats.ts` uses.
 */
const ORCHESTRATOR_THREAD = "main";

interface ToolEntry {
  thread: string;
  model: string | undefined;
  id: string;
  line: number;
  tool: string;
  resultChars: number;
  isError: boolean;
  errorCategory: ToolErrorCategory | undefined;
  resultIsPlaceholder: boolean;
}

/** This entry's own `estUsdForChars`, or `undefined` for a placeholder result (never priced) or an unknown/unpriced model. */
function entryEstUsd(entry: ToolEntry): number | undefined {
  if (entry.resultIsPlaceholder) return undefined;
  return estUsdForChars(entry.resultChars, entry.model);
}

function collectEntries(threads: readonly NeutralToolThread[]): ToolEntry[] {
  const entries: ToolEntry[] = [];
  for (const { thread, model, calls } of threads) {
    for (const call of calls) {
      entries.push({
        thread,
        model,
        id: call.id,
        line: call.line,
        tool: call.tool,
        resultChars: call.resultChars,
        isError: call.isError === true,
        errorCategory: call.errorCategory,
        resultIsPlaceholder: call.resultIsPlaceholder === true,
      });
    }
  }
  return entries;
}

function computeTotals(entries: readonly ToolEntry[]): ToolUsageTotals {
  let errors = 0;
  let resultChars = 0;
  let estUsd = 0;
  let estUsdKnown = false;
  for (const entry of entries) {
    if (entry.isError) errors += 1;
    resultChars += entry.resultChars;
    const usd = entryEstUsd(entry);
    if (usd !== undefined) {
      estUsd += usd;
      estUsdKnown = true;
    }
  }
  return {
    calls: entries.length,
    errors,
    resultChars,
    estimatedTokens: estimateTokens(resultChars),
    ...(estUsdKnown && { estUsd }),
  };
}

interface ToolAccumulator {
  name: string;
  calls: number;
  errors: number;
  errorCategories: Partial<Record<ToolErrorCategory, number>>;
  resultChars: number;
  /** This tool's `resultChars` restricted to `ORCHESTRATOR_THREAD` — `orchestratorSharePct`'s numerator. */
  orchestratorResultChars: number;
  estUsd: number;
  estUsdKnown: boolean;
}

function computeByTool(entries: readonly ToolEntry[], totals: ToolUsageTotals): ToolGroup[] {
  const groups = new Map<string, ToolAccumulator>();
  for (const entry of entries) {
    let group = groups.get(entry.tool);
    if (group === undefined) {
      group = {
        name: entry.tool,
        calls: 0,
        errors: 0,
        errorCategories: {},
        resultChars: 0,
        orchestratorResultChars: 0,
        estUsd: 0,
        estUsdKnown: false,
      };
      groups.set(entry.tool, group);
    }
    group.calls += 1;
    if (entry.isError) {
      group.errors += 1;
      const category = entry.errorCategory ?? "other";
      group.errorCategories[category] = (group.errorCategories[category] ?? 0) + 1;
    }
    group.resultChars += entry.resultChars;
    if (entry.thread === ORCHESTRATOR_THREAD) group.orchestratorResultChars += entry.resultChars;
    const usd = entryEstUsd(entry);
    if (usd !== undefined) {
      group.estUsd += usd;
      group.estUsdKnown = true;
    }
  }

  const result: ToolGroup[] = [...groups.values()].map((group) => ({
    name: group.name,
    calls: group.calls,
    errors: group.errors,
    errorCategories: group.errorCategories,
    resultChars: group.resultChars,
    estimatedTokens: estimateTokens(group.resultChars),
    ...(group.estUsdKnown && { estUsd: group.estUsd }),
    sharePct:
      totals.resultChars > 0 ? Math.round((group.resultChars / totals.resultChars) * 1000) / 10 : 0,
    orchestratorSharePct:
      group.resultChars > 0
        ? Math.round((group.orchestratorResultChars / group.resultChars) * 1000) / 10
        : 0,
  }));

  // Sorted by $ desc (the lens ranks tools by context-cost contribution) —
  // unknown-price rows sink to the bottom, then resultChars desc, then name.
  result.sort((a, b) => {
    const usdA = a.estUsd ?? -1;
    const usdB = b.estUsd ?? -1;
    if (usdB !== usdA) return usdB - usdA;
    if (b.resultChars !== a.resultChars) return b.resultChars - a.resultChars;
    return a.name.localeCompare(b.name);
  });
  return result;
}

interface ThreadAccumulator {
  thread: string;
  model: string | undefined;
  calls: number;
  errors: number;
  resultChars: number;
  estUsd: number;
  estUsdKnown: boolean;
}

/** Per-thread rollup as `BashThreadGroup` (identical shape to `bash-stats.ts`, `inputChars` always 0) — see `ToolUsageStats.byThread`. */
function computeByThread(
  entries: readonly ToolEntry[],
  totals: ToolUsageTotals,
): BashThreadGroup[] {
  const groups = new Map<string, ThreadAccumulator>();
  for (const entry of entries) {
    let group = groups.get(entry.thread);
    if (group === undefined) {
      group = {
        thread: entry.thread,
        model: entry.model,
        calls: 0,
        errors: 0,
        resultChars: 0,
        estUsd: 0,
        estUsdKnown: false,
      };
      groups.set(entry.thread, group);
    }
    group.calls += 1;
    if (entry.isError) group.errors += 1;
    group.resultChars += entry.resultChars;
    const usd = entryEstUsd(entry);
    if (usd !== undefined) {
      group.estUsd += usd;
      group.estUsdKnown = true;
    }
  }

  const result: BashThreadGroup[] = [...groups.values()].map((group) => ({
    thread: group.thread,
    ...(group.model !== undefined && { model: group.model }),
    calls: group.calls,
    errors: group.errors,
    // Always 0 — a tool's input is structured params, not context chars (see
    // the module doc comment); the field exists only to match BashThreadGroup.
    inputChars: 0,
    resultChars: group.resultChars,
    estimatedTokens: estimateTokens(group.resultChars),
    ...(group.estUsdKnown && { estUsd: group.estUsd }),
    charsSharePct:
      totals.resultChars > 0 ? Math.round((group.resultChars / totals.resultChars) * 1000) / 10 : 0,
    ...(group.estUsdKnown &&
      totals.estUsd !== undefined &&
      totals.estUsd > 0 && {
        usdSharePct: Math.round((group.estUsd / totals.estUsd) * 1000) / 10,
      }),
  }));

  result.sort((a, b) => b.resultChars - a.resultChars || a.thread.localeCompare(b.thread));
  return result;
}

function computeHeavyHitters(entries: readonly ToolEntry[]): ToolHeavyHitter[] {
  return [...entries]
    .sort((a, b) => {
      if (b.resultChars !== a.resultChars) return b.resultChars - a.resultChars;
      if (a.thread !== b.thread) return a.thread.localeCompare(b.thread);
      return a.line - b.line;
    })
    .slice(0, HEAVY_HITTER_LIMIT)
    .map((entry) => {
      const estUsd = entryEstUsd(entry);
      return {
        tool: entry.tool,
        thread: entry.thread,
        ...(entry.model !== undefined && { model: entry.model }),
        resultChars: entry.resultChars,
        estimatedTokens: estimateTokens(entry.resultChars),
        ...(estUsd !== undefined && { estUsd }),
        line: entry.line,
        id: entry.id,
        ...(entry.resultIsPlaceholder && { resultIsPlaceholder: true }),
      };
    });
}

/**
 * Compute cross-tool usage analytics over every thread's neutral tool calls
 * (main transcript first, then each subagent) — one joint pass, same rationale
 * as `bash-stats.ts`'s `computeBashStats` (see both module doc comments).
 */
export function computeToolUsageStats(threads: readonly NeutralToolThread[]): ToolUsageStats {
  const entries = collectEntries(threads);
  const totals = computeTotals(entries);
  return {
    totals,
    byTool: computeByTool(entries, totals),
    byThread: computeByThread(entries, totals),
    heavyHitters: computeHeavyHitters(entries),
  };
}
