/**
 * Harness-neutral Bash-command analytics engine ("Bash analysis" feature,
 * PR 4 of 4 — extracted out of `claude/bash-stats.ts`, PR 1's original home,
 * so `codex/bash-stats.ts` can feed it too). Operates entirely on the
 * neutral `NeutralBashCall`/`NeutralBashThread` shapes below — no
 * `SessionData`/`ToolCall` (Claude) or `CodexTranscript` (Codex) import here.
 * Each harness's own adapter (`claude/bash-stats.ts`, `codex/bash-stats.ts`)
 * maps its own tool-call records into this neutral shape and calls
 * `computeBashStats`; the CLAUDE adapter's public behavior/output values are
 * UNCHANGED by this extraction (same `BashStats` shape, same numbers — see
 * that file's own doc comment).
 *
 * Every command is parsed with the harness-agnostic `parseShellCommand`/
 * `primaryCommand` (`./shell/parser.js`).
 *
 * Scope & fold strategy: unlike `foldFileAccess`/`mergeFileAccess`
 * (`./metrics.ts`), which fold each transcript's OWN pre-aggregated map and
 * merge additively, `computeBashStats` takes every thread's neutral call list
 * and computes everything in ONE JOINT pass over the combined list. That's
 * deliberate: several fields here are global rankings (`heavyHitters`'s top
 * 10, `byCommand`'s `sharePct`) that can't be derived correctly from
 * independently-computed per-thread top-N lists — a thread with 15 large
 * calls could out-rank another thread's top 10 entirely, so "compute per
 * thread, then merge" would silently drop true heavy hitters. Per-thread
 * attribution is preserved anyway: every entry that names a specific call
 * carries `thread` (`"main"` or a subagent's own id) — directly on the entry
 * for single-call lists (`heavyHitters`, `largeResults`, `bashAsRead`,
 * `background`), or per OCCURRENCE for the grouped waste lists
 * (`nearDuplicates`, `rerunAfterError`) that fold matches from every thread
 * into one pattern-keyed group, since a bare line number can't otherwise be
 * resolved back to a call without knowing which thread's transcript it
 * belongs to.
 *
 * `background` is NOT computed here — unlike everything else, it depends on
 * harness-specific completion-signal linkage (Claude: `run_in_background`
 * launches joined to their `BashOutput`/task-notification via `taskId`; Codex
 * has no equivalent concept at all yet). Each adapter resolves its own
 * thread's `background: BashBackgroundCall[]` (or omits it) and this module
 * just concatenates every thread's list, in thread order — see
 * `NeutralBashThread.background`.
 *
 * Token figures are ESTIMATES: `Math.ceil(chars / 4)`, the same rough
 * heuristic `sourceCompleteness` (`./completeness.ts`) already labels `cost`
 * with — no real tokenizer runs over Bash input/output text. Good for
 * relative comparison ("which command group is expensive"), not exact
 * accounting.
 *
 * $ weighting (v2 PR A): chars alone mislead — 98%+ of a session's Bash chars
 * can sit in a cheap subagent thread's context, not the expensive
 * orchestrator's. `NeutralBashThread.model` (optional — an adapter can leave
 * it undefined) lets `estUsdForChars` price a call's `resultChars` at its OWN
 * thread's model, and every `estUsd?` field below is that priced figure,
 * NEVER a chars-only stand-in. `byThread` is the new per-thread rollup this
 * PR adds specifically to make "how much of this session's Bash spend sat in
 * the orchestrator vs. a subagent" answerable; `byCommand.orchestratorSharePct`
 * answers the same question per command group. `computeBashOpportunities`
 * (`./bash-opportunities.ts`) turns the enriched `waste`/`byThread` data into
 * ranked, templated fix suggestions and is wired in as `BashStats.opportunities`
 * at the bottom of `computeBashStats` — the one seam both harnesses (and the
 * server's Codex forest-joint recompute, which just re-exports this same
 * function) share.
 */

import type { BashOpportunity } from "./bash-opportunities.js";
import { computeBashOpportunities } from "./bash-opportunities.js";
import { findModelPricing } from "./pricing/pricing.js";
import type { ShellSegment } from "./shell/parser.js";
import { parseShellCommand, primaryCommand } from "./shell/parser.js";

export interface BashTotals {
  calls: number;
  errors: number;
  /** Sum of each call's `command` string length. */
  inputChars: number;
  /** Sum of each call's result char count (0 for calls with no recorded result). */
  resultChars: number;
  /** `Math.ceil((inputChars + resultChars) / 4)` — see the module doc comment. */
  estimatedTokens: number;
  /**
   * Sum of every non-placeholder call's `estUsdForChars(resultChars, thread's
   * model)` that resolved to a real number — a PARTIAL sum, silently skipping
   * any call whose thread has no known/priced model (or whose result is a
   * placeholder, see `NeutralBashCall.resultIsPlaceholder`), so this is
   * "known-priced Bash $ spend", not "total Bash $ spend". `undefined` only
   * when NOT ONE call anywhere resolved a price — never `0` for "nothing
   * priced". See the module doc comment's "$ weighting" section.
   */
  estUsd?: number;
}

export interface BashCommandGroup {
  /** The resolved executable (post wrapper-unwrapping) — e.g. `"git"`, `"node"`. `"(unparsed)"` for a call whose command had no identifiable executable (see `primaryCommand`). */
  family: string;
  /** First non-flag arg, only when `family` is a known command family (git, gh, pnpm, ...) — e.g. `"diff"` for `git diff --stat`. */
  subcommand?: string;
  calls: number;
  errors: number;
  totalInputChars: number;
  totalResultChars: number;
  /** `Math.round(totalResultChars / calls)`. */
  avgResultChars: number;
  /** `Math.ceil((totalInputChars + totalResultChars) / 4)`. */
  estimatedTokens: number;
  /** This group's share of `BashStats.totals.resultChars`, as a 0-100 percentage rounded to 1 decimal. `0` when totals.resultChars is 0. */
  sharePct: number;
  /** Up to 3 DISTINCT raw commands from this group, each capped to ~200 chars. */
  sampleCommands: string[];
  /** Same partial-sum/never-0-for-unknown rule as `BashTotals.estUsd`, scoped to this group's own calls. */
  estUsd?: number;
  /**
   * Share (0-100, 1 decimal) of this group's OWN `totalResultChars` that sat
   * in the `"main"` (top-level/orchestrator) thread, as opposed to a
   * subagent's — a high value means an expensive orchestrator turn is paying
   * for this command's chars directly; a low value means a cheap subagent is
   * absorbing most of it. Always computable from thread names alone (no
   * pricing dependency) — `0` when `totalResultChars` is 0 or no occurrence
   * came from `"main"`.
   */
  orchestratorSharePct?: number;
}

/**
 * Per-thread rollup — new in v2 PR A, alongside `byCommand`'s per-command
 * rollup, specifically to make "how much of this session's Bash spend sat in
 * the orchestrator vs. a subagent" answerable without eyeballing
 * `heavyHitters`/`byCommand`'s `thread` tags one at a time. Built the same
 * way `byCommand` is: one row per thread that has at least one Bash call
 * (a thread with zero Bash calls never appears), ranked by `resultChars` desc.
 */
export interface BashThreadGroup {
  thread: string;
  /** This thread's own model, when the adapter supplied one — see `NeutralBashThread.model`. */
  model?: string;
  calls: number;
  errors: number;
  inputChars: number;
  resultChars: number;
  /** `Math.ceil((inputChars + resultChars) / 4)`. */
  estimatedTokens: number;
  /** Same partial-sum/never-0-for-unknown rule as `BashTotals.estUsd`, scoped to this thread's own calls. */
  estUsd?: number;
  /** This thread's share of `BashStats.totals.resultChars`, 0-100 rounded to 1 decimal. `0` when totals.resultChars is 0. */
  charsSharePct: number;
  /** This thread's share of `BashStats.totals.estUsd`, 0-100 rounded to 1 decimal — `undefined` whenever either this thread's own `estUsd` or the session `totals.estUsd` is itself unknown (never a share of an unpriced total). */
  usdSharePct?: number;
}

export interface BashProgramFrequency {
  /** A segment's resolved executable — see `ShellSegment.executable`. */
  program: string;
  /** Number of segments (across every call, every thread) resolved to this executable — includes `cd` and every side of a pipeline (`git diff | grep foo` counts both `git` and `grep`). */
  count: number;
}

export interface BashHeavyHitter {
  /** Raw command, capped to ~200 chars. */
  command: string;
  /** `primaryCommand`'s resolved executable, or `"(unparsed)"`. */
  family: string;
  resultChars: number;
  line: number;
  toolUseId: string;
  thread: string;
  /** Same partial/never-0-for-unknown rule as `BashTotals.estUsd`, priced from THIS call's own `resultChars` at its thread's model — `undefined` when unknown OR when `resultIsPlaceholder` is set (a placeholder's `resultChars` is never priced). */
  estUsd?: number;
  /** `true` only when this call's `resultChars` is a synthesized placeholder, not real captured output — see `NeutralBashCall.resultIsPlaceholder`. Omitted (never `false`) when not a placeholder. */
  resultIsPlaceholder?: boolean;
}

export interface BashBackgroundCall {
  taskId: string;
  /** Raw launch command, capped to ~200 chars — falls back to the launch's recorded `name` when the launching tool_use itself can't be resolved. */
  command: string;
  thread: string;
  launchLine: number;
  completionLine?: number;
  /**
   * Wall-clock milliseconds from launch to the harness's completion
   * notification — includes real background execution time, NOT just API
   * latency. Reported here ONLY: never folded into `totals`/`byCommand`/
   * `heavyHitters`, which rank by char counts alone.
   */
  wallClockMs?: number;
  status: "completed" | "failed" | "unresolved";
}

export interface BashNearDuplicateGroup {
  /** Normalized command text shared by every occurrence in this group — see `normalizeCommandForDedup`. */
  pattern: string;
  count: number;
  /** Up to 3 distinct original (un-normalized) commands, capped to ~200 chars. */
  examples: string[];
  /**
   * One entry per occurrence, in detection order — which thread it came
   * from, its line number, and its own `resultChars` (since occurrences here
   * are folded across every thread, see the module doc comment;
   * `resultChars` lets `computeBashOpportunities` price each occurrence
   * individually). `resultChars` is OPTIONAL on the type only for backward
   * compatibility with existing hand-built literals elsewhere in the
   * monorepo that predate it (e.g. presentational formatting tests that never
   * read it) — `computeBashStats` itself always sets a real value here.
   */
  occurrences: Array<{ thread: string; line: number; resultChars?: number }>;
}

export interface BashLargeResult {
  command: string;
  resultChars: number;
  line: number;
  thread: string;
  /**
   * Whether the result text itself carries a harness-emitted truncation
   * marker (as opposed to merely being long). Currently ALWAYS `false` — see
   * `detectHarnessTruncation`'s doc comment for why. `largeResults` is a
   * purely size-based signal (`resultChars >= LARGE_RESULT_CHARS_THRESHOLD`)
   * until a real marker is identified.
   */
  truncatedByHarness: boolean;
  /** Same rule as `BashHeavyHitter.estUsd`. */
  estUsd?: number;
  /** Same rule as `BashHeavyHitter.resultIsPlaceholder`. */
  resultIsPlaceholder?: boolean;
}

export interface BashRerunAfterError {
  pattern: string;
  count: number;
  /**
   * One entry per occurrence, in detection order — the thread it happened in
   * (rerun-after-error is always looked up within a single thread, see
   * `computeRerunAfterError`), the failing call's line, the rerun's line, and
   * the RERUN call's own `resultChars` (not the failing call's — the rerun is
   * the avoidable re-fetch `computeBashOpportunities` prices; the error's own
   * result is usually just a short error message, not the waste signal).
   * `resultChars` is OPTIONAL on the type for the same backward-compatibility
   * reason as `BashNearDuplicateGroup.occurrences` — `computeBashStats`
   * itself always sets a real value here.
   */
  occurrences: Array<{
    thread: string;
    errorLine: number;
    rerunLine: number;
    resultChars?: number;
  }>;
}

export interface BashAsReadCall {
  command: string;
  resultChars: number;
  line: number;
  thread: string;
  /** Same rule as `BashHeavyHitter.estUsd`. */
  estUsd?: number;
  /** Same rule as `BashHeavyHitter.resultIsPlaceholder`. */
  resultIsPlaceholder?: boolean;
}

/**
 * Quantitative-only findings — counts and line-number occurrences, no
 * prose/advice (that's a later PR's job, once this data has a UI).
 */
export interface BashWaste {
  /** Groups of >=3 occurrences of the same normalized command (across every thread) — see `normalizeCommandForDedup`. */
  nearDuplicates: BashNearDuplicateGroup[];
  /** Calls at or above `LARGE_RESULT_CHARS_THRESHOLD`. */
  largeResults: BashLargeResult[];
  /** Same normalized command re-run within the next 3 Bash calls of the SAME thread after an `isError` result. Every occurrence is reported (no minimum count) — the `isError` gate already keeps this low-noise. */
  rerunAfterError: BashRerunAfterError[];
  /** Single-segment calls that read a file the way the Read tool would (`cat`/`head`/`tail`/`less`/`more`, or `sed -n 'N,Mp' file`). */
  bashAsRead: BashAsReadCall[];
}

export interface BashStats {
  totals: BashTotals;
  /** Grouped by resolved family + subcommand, sorted by `totalResultChars` desc. */
  byCommand: BashCommandGroup[];
  /** Grouped by thread, sorted by `resultChars` desc — see `BashThreadGroup`'s doc comment. */
  byThread: BashThreadGroup[];
  /** Sorted by `count` desc. */
  programFrequency: BashProgramFrequency[];
  /** Top 10 calls by `resultChars`, across every thread. */
  heavyHitters: BashHeavyHitter[];
  background: BashBackgroundCall[];
  waste: BashWaste;
  /** Ranked, templated fix suggestions derived from `waste`/`byThread` — see `./bash-opportunities.ts`. */
  opportunities: BashOpportunity[];
}

/**
 * One harness-neutral shell call — a single Bash/shell execution, already
 * reduced to a plain command string (any wrapper-argv unwrapping or argv
 * reassembly a harness needed happens in ITS OWN adapter before this shape
 * is built; see `claude/bash-stats.ts`'s `toNeutralCalls` and
 * `codex/bash-stats.ts`'s `computeCodexBashEntries`).
 */
export interface NeutralBashCall {
  /** Stable per-call id — Claude's `toolUseId`, Codex's `call_id` (or a synthesized fallback when the wire carried none). Surfaces on `BashHeavyHitter.toolUseId`. */
  id: string;
  /** 1-based source line of the call itself (not its result) — provenance anchor for every list below. */
  line: number;
  command: string;
  /** Result char count — 0 when no result/output text is recorded for this call. */
  resultChars: number;
  /** Defaults to `false` when omitted (no recorded result, or a result that isn't flagged as an error). */
  isError?: boolean;
  /**
   * `true` when `resultChars` is a synthesized placeholder rather than real
   * captured output — currently only Codex's `local_shell_call` surface,
   * whose only "result" is a synthesized `"exited with code N"` string (see
   * `codex/tool-calls.ts`'s module doc comment). Placeholder calls are
   * excluded from every `estUsd` sum (their `resultChars` is real chars, but
   * pricing it would silently misrepresent a tiny placeholder string as the
   * command's real output cost) and marked via the matching entry's own
   * `resultIsPlaceholder`. Defaults to `false` when omitted.
   */
  resultIsPlaceholder?: boolean;
}

/** One thread's neutral call list, tagged with how it should be attributed — `"main"` for the top-level transcript, else a subagent's own id. */
export interface NeutralBashThread {
  thread: string;
  /**
   * This thread's own dominant model, when the adapter can supply one — the
   * Claude adapter uses the main transcript's highest-input-token model (or a
   * subagent's own `SubagentNode.model`), the Codex adapter uses the
   * transcript's session-level model. `undefined` when unknown (never
   * guessed) — every `estUsd` figure derived from this thread's calls stays
   * `undefined` too, rather than defaulting to some other model's price.
   */
  model?: string;
  calls: NeutralBashCall[];
  /**
   * This thread's own background-task entries, already fully resolved by the
   * adapter (launch/completion linkage is harness-specific — see the module
   * doc comment) — omitted (or `[]`) for a harness/thread with no background
   * concept.
   */
  background?: BashBackgroundCall[];
}

/** `resultChars` threshold for `waste.largeResults`. */
export const LARGE_RESULT_CHARS_THRESHOLD = 20_000;

const SAMPLE_COMMAND_LIMIT = 200;
const MAX_SAMPLE_COMMANDS = 3;
const HEAVY_HITTER_LIMIT = 10;
const RERUN_LOOKAHEAD = 3;
const NEAR_DUPLICATE_MIN_COUNT = 3;
const UNPARSED_FAMILY = "(unparsed)";

/**
 * The harness-wide convention (both adapters use it, see `NeutralBashThread`'s
 * own doc comment) for "the top-level transcript, not a subagent" — the
 * `BashCommandGroup.orchestratorSharePct` calculation's reference thread.
 */
const ORCHESTRATOR_THREAD = "main";

const READ_LIKE_COMMANDS: ReadonlySet<string> = new Set(["cat", "head", "tail", "less", "more"]);

/**
 * `Math.ceil(chars / 4)` — the rough char→token heuristic this whole module
 * (and the parallel `./tool-usage-stats.ts` engine, which imports it rather
 * than re-deriving it) uses; no real tokenizer runs. See the module doc
 * comment.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function cap(text: string, limit = SAMPLE_COMMAND_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * $ weighting's one pricing hook: `chars` (a call's `resultChars`) priced at
 * `model`'s INPUT rate — deliberately the input rate, never output. A Bash
 * result isn't "generated" by the model the way a completion is; it's text
 * that gets read back in as INPUT context on every subsequent turn, so the
 * input rate is what actually recurs each time the agent re-reads it (and,
 * for the CURRENT turn, is a closer proxy than the output rate the harness
 * paid once to produce the tool_use that requested it).
 *
 * `undefined` — NEVER `0` — whenever `model` is unknown or has no priced
 * `input_cost_per_token` entry (`findModelPricing`), so callers can tell
 * "genuinely free" apart from "can't estimate".
 */
export function estUsdForChars(chars: number, model: string | undefined): number | undefined {
  if (model === undefined) return undefined;
  const inputRate = findModelPricing(model)?.input_cost_per_token;
  if (inputRate === undefined) return undefined;
  return estimateTokens(chars) * inputRate;
}

/**
 * Whether a shell call's result text carries a harness-emitted truncation
 * marker (as opposed to a parser's OWN capture cap — an entirely different,
 * Junrei-side concern already covered by each harness's own `resultChars`).
 *
 * No such harness-side marker was found anywhere in this repo's fixtures or
 * `docs/research/claude-code-session-log-completeness.md` while building the
 * original (Claude) PR — Claude Code's own Bash tool_result text, at least in
 * every sample available here, is just the raw stdout/stderr with no
 * truncation banner; Codex's rollout format carries no such marker either.
 * This always returns `false`; `waste.largeResults` is therefore a purely
 * size-based signal for now. Revisit once a real fixture with a confirmed
 * marker turns up, for either harness.
 */
function detectHarnessTruncation(): boolean {
  return false;
}

/** `-n`/`-c`-style flags that consume a separate value on `head`/`tail` (line/byte counts) — a bare `head -n 100` has no file arg at all, so this value must not be mistaken for one. */
const VALUE_CONSUMING_READ_FLAGS: ReadonlySet<string> = new Set(["-n", "-c"]);

/** Whether `args` has an actual file-like non-flag argument, skipping the value of any `-n`/`-c`-style flag along the way (see `VALUE_CONSUMING_READ_FLAGS`). */
function hasFileArg(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (VALUE_CONSUMING_READ_FLAGS.has(a)) {
      i += 1; // skip its value, e.g. the "100" in "-n 100"
      continue;
    }
    if (!a.startsWith("-")) return true;
  }
  return false;
}

function isSedRangePrint(args: readonly string[]): boolean {
  if (!args.includes("-n")) return false;
  const rangeIndex = args.findIndex((a) => /^\d+,\d+p$/.test(a));
  if (rangeIndex === -1) return false;
  // `sed -n '10,20p'` alone reads stdin — require an actual file arg AFTER
  // the range, same reasoning as `hasFileArg` above.
  return args.slice(rangeIndex + 1).some((a) => !a.startsWith("-"));
}

function isBashAsRead(segment: ShellSegment): boolean {
  if (segment.executable === undefined) return false;
  // A redirected read (`cat foo.log > out.txt`) sends its content to a file
  // instead of back to the agent via the tool result. `bashAsRead` exists to
  // find calls that substitute for the Read tool, and a call whose output
  // never reaches the agent isn't one — even though the file itself is
  // still being read. See `ShellSegment.hasOutputRedirect`.
  if (segment.hasOutputRedirect === true) return false;
  if (READ_LIKE_COMMANDS.has(segment.executable)) {
    return hasFileArg(segment.args);
  }
  if (segment.executable === "sed") return isSedRangePrint(segment.args);
  return false;
}

/**
 * Collapse a command to a shape-only "pattern" for waste detection: quoted
 * strings, standalone numbers, and path-like tokens (anything containing a
 * `/`) are replaced with placeholders, so `git commit -m "fix bug 1"` and
 * `git commit -m "fix bug 2"` normalize identically. Order matters — quotes
 * collapse first so numbers/paths INSIDE a quoted string don't get a second,
 * partial substitution.
 *
 * Regex-level, operating on the raw command text directly rather than
 * re-tokenizing via `parseShellCommand` — this is a looser, purely textual
 * heuristic for "do these two commands look like the same shape", not a
 * structural comparison.
 */
export function normalizeCommandForDedup(command: string): string {
  let normalized = command;
  normalized = normalized.replace(/'[^']*'|"[^"]*"/g, "<STR>");
  normalized = normalized.replace(/\b\d+(\.\d+)?\b/g, "<NUM>");
  normalized = normalized.replace(
    /(^|\s)([\w.@~-]*\/[\w./@~-]*)/g,
    (_match, lead: string) => `${lead}<PATH>`,
  );
  return normalized.trim().replace(/\s+/g, " ");
}

interface BashEntry {
  thread: string;
  model: string | undefined;
  toolUseId: string;
  line: number;
  command: string;
  inputChars: number;
  resultChars: number;
  isError: boolean;
  resultIsPlaceholder: boolean;
  segments: readonly ShellSegment[];
  primary: ShellSegment | undefined;
  family: string;
}

/** This entry's own `estUsdForChars`, or `undefined` for a placeholder result (never priced) or an unknown/unpriced model. */
function entryEstUsd(entry: BashEntry): number | undefined {
  if (entry.resultIsPlaceholder) return undefined;
  return estUsdForChars(entry.resultChars, entry.model);
}

function toBashEntry(thread: string, model: string | undefined, call: NeutralBashCall): BashEntry {
  const parsed = parseShellCommand(call.command);
  const primary = primaryCommand(parsed);
  return {
    thread,
    model,
    toolUseId: call.id,
    line: call.line,
    command: call.command,
    inputChars: call.command.length,
    resultChars: call.resultChars,
    isError: call.isError === true,
    resultIsPlaceholder: call.resultIsPlaceholder === true,
    segments: parsed.segments,
    primary,
    family: primary?.executable ?? UNPARSED_FAMILY,
  };
}

function collectEntries(threads: readonly NeutralBashThread[]): BashEntry[] {
  const entries: BashEntry[] = [];
  for (const { thread, model, calls } of threads) {
    for (const call of calls) entries.push(toBashEntry(thread, model, call));
  }
  return entries;
}

function computeTotals(entries: readonly BashEntry[]): BashTotals {
  let errors = 0;
  let inputChars = 0;
  let resultChars = 0;
  let estUsd = 0;
  let estUsdKnown = false;
  for (const entry of entries) {
    if (entry.isError) errors += 1;
    inputChars += entry.inputChars;
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
    inputChars,
    resultChars,
    estimatedTokens: estimateTokens(inputChars + resultChars),
    ...(estUsdKnown && { estUsd }),
  };
}

interface GroupAccumulator {
  family: string;
  subcommand: string | undefined;
  calls: number;
  errors: number;
  totalInputChars: number;
  totalResultChars: number;
  sampleSeen: Set<string>;
  sampleCommands: string[];
  estUsd: number;
  estUsdKnown: boolean;
  /** This group's own `totalResultChars` restricted to `ORCHESTRATOR_THREAD` occurrences — `orchestratorSharePct`'s numerator. */
  orchestratorResultChars: number;
}

function computeByCommand(entries: readonly BashEntry[], totals: BashTotals): BashCommandGroup[] {
  const groups = new Map<string, GroupAccumulator>();
  for (const entry of entries) {
    const subcommand = entry.primary?.subcommand;
    const key = `${entry.family} ${subcommand ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        family: entry.family,
        subcommand,
        calls: 0,
        errors: 0,
        totalInputChars: 0,
        totalResultChars: 0,
        sampleSeen: new Set(),
        sampleCommands: [],
        estUsd: 0,
        estUsdKnown: false,
        orchestratorResultChars: 0,
      };
      groups.set(key, group);
    }
    group.calls += 1;
    if (entry.isError) group.errors += 1;
    group.totalInputChars += entry.inputChars;
    group.totalResultChars += entry.resultChars;
    if (entry.thread === ORCHESTRATOR_THREAD) group.orchestratorResultChars += entry.resultChars;
    const usd = entryEstUsd(entry);
    if (usd !== undefined) {
      group.estUsd += usd;
      group.estUsdKnown = true;
    }
    if (group.sampleCommands.length < MAX_SAMPLE_COMMANDS && !group.sampleSeen.has(entry.command)) {
      group.sampleSeen.add(entry.command);
      group.sampleCommands.push(cap(entry.command));
    }
  }

  const result: BashCommandGroup[] = [...groups.values()].map((group) => ({
    family: group.family,
    ...(group.subcommand !== undefined && { subcommand: group.subcommand }),
    calls: group.calls,
    errors: group.errors,
    totalInputChars: group.totalInputChars,
    totalResultChars: group.totalResultChars,
    avgResultChars: Math.round(group.totalResultChars / group.calls),
    estimatedTokens: estimateTokens(group.totalInputChars + group.totalResultChars),
    sharePct:
      totals.resultChars > 0
        ? Math.round((group.totalResultChars / totals.resultChars) * 1000) / 10
        : 0,
    sampleCommands: group.sampleCommands,
    ...(group.estUsdKnown && { estUsd: group.estUsd }),
    orchestratorSharePct:
      group.totalResultChars > 0
        ? Math.round((group.orchestratorResultChars / group.totalResultChars) * 1000) / 10
        : 0,
  }));

  result.sort((a, b) => {
    if (b.totalResultChars !== a.totalResultChars) return b.totalResultChars - a.totalResultChars;
    if (b.calls !== a.calls) return b.calls - a.calls;
    return (
      a.family.localeCompare(b.family) || (a.subcommand ?? "").localeCompare(b.subcommand ?? "")
    );
  });
  return result;
}

interface ThreadAccumulator {
  thread: string;
  model: string | undefined;
  calls: number;
  errors: number;
  inputChars: number;
  resultChars: number;
  estUsd: number;
  estUsdKnown: boolean;
}

/** New in v2 PR A — see `BashThreadGroup`'s doc comment. */
function computeByThread(entries: readonly BashEntry[], totals: BashTotals): BashThreadGroup[] {
  const groups = new Map<string, ThreadAccumulator>();
  for (const entry of entries) {
    let group = groups.get(entry.thread);
    if (group === undefined) {
      group = {
        thread: entry.thread,
        model: entry.model,
        calls: 0,
        errors: 0,
        inputChars: 0,
        resultChars: 0,
        estUsd: 0,
        estUsdKnown: false,
      };
      groups.set(entry.thread, group);
    }
    group.calls += 1;
    if (entry.isError) group.errors += 1;
    group.inputChars += entry.inputChars;
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
    inputChars: group.inputChars,
    resultChars: group.resultChars,
    estimatedTokens: estimateTokens(group.inputChars + group.resultChars),
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

/**
 * Every segment's resolved executable, across every call — see
 * `BashProgramFrequency`'s doc comment for why this counts differently from
 * `byCommand` (which attributes a whole call to ONE `primaryCommand`).
 */
function computeProgramFrequency(entries: readonly BashEntry[]): BashProgramFrequency[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const segment of entry.segments) {
      if (segment.executable === undefined) continue;
      counts.set(segment.executable, (counts.get(segment.executable) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([program, count]) => ({ program, count }))
    .sort((a, b) => b.count - a.count || a.program.localeCompare(b.program));
}

function computeHeavyHitters(entries: readonly BashEntry[]): BashHeavyHitter[] {
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
        command: cap(entry.command),
        family: entry.family,
        resultChars: entry.resultChars,
        line: entry.line,
        toolUseId: entry.toolUseId,
        thread: entry.thread,
        ...(estUsd !== undefined && { estUsd }),
        ...(entry.resultIsPlaceholder && { resultIsPlaceholder: true }),
      };
    });
}

function computeNearDuplicates(entries: readonly BashEntry[]): BashNearDuplicateGroup[] {
  interface Acc {
    count: number;
    exampleSeen: Set<string>;
    examples: string[];
    occurrences: Array<{ thread: string; line: number; resultChars: number }>;
  }
  const groups = new Map<string, Acc>();
  for (const entry of entries) {
    const pattern = normalizeCommandForDedup(entry.command);
    let acc = groups.get(pattern);
    if (acc === undefined) {
      acc = { count: 0, exampleSeen: new Set(), examples: [], occurrences: [] };
      groups.set(pattern, acc);
    }
    acc.count += 1;
    acc.occurrences.push({
      thread: entry.thread,
      line: entry.line,
      resultChars: entry.resultChars,
    });
    if (acc.examples.length < MAX_SAMPLE_COMMANDS && !acc.exampleSeen.has(entry.command)) {
      acc.exampleSeen.add(entry.command);
      acc.examples.push(cap(entry.command));
    }
  }

  return [...groups.entries()]
    .filter(([, acc]) => acc.count >= NEAR_DUPLICATE_MIN_COUNT)
    .map(([pattern, acc]) => ({
      pattern,
      count: acc.count,
      examples: acc.examples,
      occurrences: acc.occurrences,
    }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

function computeLargeResults(entries: readonly BashEntry[]): BashLargeResult[] {
  return entries
    .filter((entry) => entry.resultChars >= LARGE_RESULT_CHARS_THRESHOLD)
    .map((entry) => {
      const estUsd = entryEstUsd(entry);
      return {
        command: cap(entry.command),
        resultChars: entry.resultChars,
        line: entry.line,
        thread: entry.thread,
        truncatedByHarness: detectHarnessTruncation(),
        ...(estUsd !== undefined && { estUsd }),
        ...(entry.resultIsPlaceholder && { resultIsPlaceholder: true }),
      };
    })
    .sort((a, b) => b.resultChars - a.resultChars);
}

/**
 * Per-thread (a subagent's retries have nothing to do with the main
 * transcript's next call, so cross-thread lookahead would be meaningless),
 * but the result is grouped globally by normalized pattern. Each occurrence's
 * `resultChars` is the RERUN's own (`candidate`, not `failing`) — the rerun
 * is the avoidable re-fetch `computeBashOpportunities` prices, not the
 * failing call's (usually short) error output.
 */
function computeRerunAfterError(threads: readonly NeutralBashThread[]): BashRerunAfterError[] {
  const byPattern = new Map<
    string,
    {
      count: number;
      occurrences: Array<{
        thread: string;
        errorLine: number;
        rerunLine: number;
        resultChars: number;
      }>;
    }
  >();

  for (const { thread, calls } of threads) {
    for (let i = 0; i < calls.length; i += 1) {
      const failing = calls[i];
      if (failing === undefined || failing.isError !== true) continue;
      const failingPattern = normalizeCommandForDedup(failing.command);
      const windowEnd = Math.min(i + RERUN_LOOKAHEAD, calls.length - 1);
      for (let j = i + 1; j <= windowEnd; j += 1) {
        const candidate = calls[j];
        if (candidate === undefined) continue;
        if (normalizeCommandForDedup(candidate.command) !== failingPattern) continue;
        let acc = byPattern.get(failingPattern);
        if (acc === undefined) {
          acc = { count: 0, occurrences: [] };
          byPattern.set(failingPattern, acc);
        }
        acc.count += 1;
        acc.occurrences.push({
          thread,
          errorLine: failing.line,
          rerunLine: candidate.line,
          resultChars: candidate.resultChars,
        });
        break; // one rerun credited per failing call
      }
    }
  }

  return [...byPattern.entries()]
    .map(([pattern, acc]) => ({ pattern, count: acc.count, occurrences: acc.occurrences }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

function computeBashAsRead(entries: readonly BashEntry[]): BashAsReadCall[] {
  const result: BashAsReadCall[] = [];
  for (const entry of entries) {
    if (entry.segments.length !== 1) continue;
    const segment = entry.segments[0];
    if (segment === undefined || !isBashAsRead(segment)) continue;
    const estUsd = entryEstUsd(entry);
    result.push({
      command: cap(entry.command),
      resultChars: entry.resultChars,
      line: entry.line,
      thread: entry.thread,
      ...(estUsd !== undefined && { estUsd }),
      ...(entry.resultIsPlaceholder && { resultIsPlaceholder: true }),
    });
  }
  return result;
}

/**
 * Compute Bash-command analytics over every thread's neutral shell calls
 * (main transcript first, then each subagent) — see the module doc comment
 * for why this is one joint pass rather than a per-thread fold+merge, and for
 * why `background` is concatenated rather than computed here.
 */
export function computeBashStats(threads: readonly NeutralBashThread[]): BashStats {
  const entries = collectEntries(threads);
  const totals = computeTotals(entries);
  const byThread = computeByThread(entries, totals);
  const waste: BashWaste = {
    nearDuplicates: computeNearDuplicates(entries),
    largeResults: computeLargeResults(entries),
    rerunAfterError: computeRerunAfterError(threads),
    bashAsRead: computeBashAsRead(entries),
  };
  return {
    totals,
    byCommand: computeByCommand(entries, totals),
    byThread,
    programFrequency: computeProgramFrequency(entries),
    heavyHitters: computeHeavyHitters(entries),
    background: threads.flatMap((t) => t.background ?? []),
    waste,
    opportunities: computeBashOpportunities({ byThread, waste }),
  };
}
