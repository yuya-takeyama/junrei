/**
 * Bash-command analytics ("Bash analysis" feature, PR 1 of 4) — every `Bash`
 * tool call across the MAIN transcript and every subagent transcript, parsed
 * with the harness-agnostic `parseShellCommand`/`primaryCommand`
 * (`../shared/shell/parser.js`) so a later Codex PR can reuse the exact same
 * command-family grouping over its own shell-call tool results.
 *
 * Scope & fold strategy: unlike `foldFileAccess`/`mergeFileAccess`
 * (`../shared/metrics.ts`), which fold each transcript's OWN pre-aggregated
 * map and merge additively, `computeBashStats` takes every thread's raw
 * `SessionData` and computes everything in ONE JOINT pass over the combined
 * call list. That's deliberate: several fields here are global rankings
 * (`heavyHitters`'s top 10, `byCommand`'s `sharePct`) that can't be derived
 * correctly from independently-computed per-thread top-N lists — a thread
 * with 15 large calls could out-rank another thread's top 10 entirely, so
 * "compute per thread, then merge" would silently drop true heavy hitters.
 * Per-thread attribution is preserved anyway: every entry that names a
 * specific call carries `thread` (`"main"` or a subagent's `agentId`) —
 * directly on the entry for single-call lists (`heavyHitters`,
 * `largeResults`, `bashAsRead`, `background`), or per OCCURRENCE for the
 * grouped waste lists (`nearDuplicates`, `rerunAfterError`) that fold
 * matches from every thread into one pattern-keyed group, since a bare line
 * number can't otherwise be resolved back to a call without knowing which
 * thread's transcript it belongs to.
 *
 * Token figures are ESTIMATES: `Math.ceil(chars / 4)`, the same rough
 * heuristic `sourceCompleteness` (`../shared/completeness.ts`) already
 * labels `cost` with — no real tokenizer runs over Bash input/output text.
 * Good for relative comparison ("which command group is expensive"), not
 * exact accounting.
 */

import type { ShellSegment } from "../shared/shell/parser.js";
import { parseShellCommand, primaryCommand } from "../shared/shell/parser.js";
import { backgroundStatus, spanMs } from "./metrics.js";
import type { SessionData, ToolCall } from "./session-data.js";

/** One thread's session data, tagged with how it should be attributed — `"main"` for the top-level transcript, else a subagent's `agentId`. */
export interface BashStatsThread {
  thread: string;
  data: SessionData;
}

export interface BashTotals {
  calls: number;
  errors: number;
  /** Sum of each call's `command` string length. */
  inputChars: number;
  /** Sum of each call's result `fullTextLength` (0 for calls with no recorded result). */
  resultChars: number;
  /** `Math.ceil((inputChars + resultChars) / 4)` — see the module doc comment. */
  estimatedTokens: number;
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
  /** One entry per occurrence, in detection order — which thread it came from and its line number, since occurrences here are folded across every thread (see the module doc comment). */
  occurrences: Array<{ thread: string; line: number }>;
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
}

export interface BashRerunAfterError {
  pattern: string;
  count: number;
  /** One entry per occurrence, in detection order — the thread it happened in (rerun-after-error is always looked up within a single thread, see `computeRerunAfterError`), plus the failing call's line and the rerun's line. */
  occurrences: Array<{ thread: string; errorLine: number; rerunLine: number }>;
}

export interface BashAsReadCall {
  command: string;
  resultChars: number;
  line: number;
  thread: string;
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
  /** Sorted by `count` desc. */
  programFrequency: BashProgramFrequency[];
  /** Top 10 calls by `resultChars`, across every thread. */
  heavyHitters: BashHeavyHitter[];
  background: BashBackgroundCall[];
  waste: BashWaste;
}

/** `resultChars` threshold for `waste.largeResults`. */
export const LARGE_RESULT_CHARS_THRESHOLD = 20_000;

const SAMPLE_COMMAND_LIMIT = 200;
const MAX_SAMPLE_COMMANDS = 3;
const HEAVY_HITTER_LIMIT = 10;
const RERUN_LOOKAHEAD = 3;
const NEAR_DUPLICATE_MIN_COUNT = 3;
const UNPARSED_FAMILY = "(unparsed)";

const READ_LIKE_COMMANDS: ReadonlySet<string> = new Set(["cat", "head", "tail", "less", "more"]);

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function cap(text: string, limit = SAMPLE_COMMAND_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Whether a `Bash` call's result text carries a Claude-Code-harness-emitted
 * truncation marker (as opposed to the parser's OWN 2000-char capture cap —
 * `TOOL_RESULT_TEXT_LIMIT` in `parser.ts`, an entirely different, Junrei-side
 * concern already covered by `fullTextLength`).
 *
 * No such harness-side marker was found anywhere in this repo's fixtures or
 * `docs/research/claude-code-session-log-completeness.md` while building
 * this PR — Claude Code's own Bash tool_result text, at least in every
 * sample available here, is just the raw stdout/stderr with no truncation
 * banner. This always returns `false`; `waste.largeResults` is therefore a
 * purely size-based signal for now. Revisit once a real fixture with a
 * confirmed marker turns up.
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
  toolUseId: string;
  line: number;
  command: string;
  inputChars: number;
  resultChars: number;
  isError: boolean;
  segments: readonly ShellSegment[];
  primary: ShellSegment | undefined;
  family: string;
}

function commandOf(call: ToolCall): string {
  const input = call.input;
  if (typeof input !== "object" || input === null) return "";
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function collectEntries(threads: readonly BashStatsThread[]): BashEntry[] {
  const entries: BashEntry[] = [];
  for (const { thread, data } of threads) {
    for (const call of data.toolCalls) {
      if (call.name !== "Bash") continue;
      const command = commandOf(call);
      const parsed = parseShellCommand(command);
      const primary = primaryCommand(parsed);
      entries.push({
        thread,
        toolUseId: call.toolUseId,
        line: call.line,
        command,
        inputChars: command.length,
        resultChars: call.result?.fullTextLength ?? 0,
        isError: call.result?.isError === true,
        segments: parsed.segments,
        primary,
        family: primary?.executable ?? UNPARSED_FAMILY,
      });
    }
  }
  return entries;
}

function computeTotals(entries: readonly BashEntry[]): BashTotals {
  let errors = 0;
  let inputChars = 0;
  let resultChars = 0;
  for (const entry of entries) {
    if (entry.isError) errors += 1;
    inputChars += entry.inputChars;
    resultChars += entry.resultChars;
  }
  return {
    calls: entries.length,
    errors,
    inputChars,
    resultChars,
    estimatedTokens: estimateTokens(inputChars + resultChars),
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
}

function computeByCommand(entries: readonly BashEntry[], totals: BashTotals): BashCommandGroup[] {
  const groups = new Map<string, GroupAccumulator>();
  for (const entry of entries) {
    const subcommand = entry.primary?.subcommand;
    const key = `${entry.family} ${subcommand ?? ""}`;
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
      };
      groups.set(key, group);
    }
    group.calls += 1;
    if (entry.isError) group.errors += 1;
    group.totalInputChars += entry.inputChars;
    group.totalResultChars += entry.resultChars;
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
    .map((entry) => ({
      command: cap(entry.command),
      family: entry.family,
      resultChars: entry.resultChars,
      line: entry.line,
      toolUseId: entry.toolUseId,
      thread: entry.thread,
    }));
}

function computeBackground(threads: readonly BashStatsThread[]): BashBackgroundCall[] {
  const background: BashBackgroundCall[] = [];
  for (const { thread, data } of threads) {
    const callsById = new Map(data.toolCalls.map((c) => [c.toolUseId, c]));
    for (const launch of data.backgroundLaunches) {
      if (launch.kind !== "bash") continue;
      const launchCall =
        launch.toolUseId !== undefined ? callsById.get(launch.toolUseId) : undefined;
      const command = launchCall !== undefined ? commandOf(launchCall) : "";
      // Last notification for this taskId wins — same rule `computeTaskExecutions` applies.
      let notification: (typeof data.taskNotifications)[number] | undefined;
      for (const candidate of data.taskNotifications) {
        if (candidate.taskId === launch.taskId) notification = candidate;
      }
      const wallClockMs = spanMs(
        launchCall?.timestamp ?? launch.timestamp,
        notification?.timestamp,
      );
      // `backgroundStatus` is shared with `computeTaskExecutions`, whose
      // status union also covers preview-server "stopped" — unreachable for
      // a Bash launch (never fed a preview-stop event), but the type isn't
      // narrowed for us, so fold it into "unresolved" defensively.
      const rawStatus = backgroundStatus(notification);
      const status = rawStatus === "stopped" ? "unresolved" : rawStatus;
      background.push({
        taskId: launch.taskId,
        command: cap(command !== "" ? command : launch.name),
        thread,
        launchLine: launch.line,
        ...(notification?.line !== undefined && { completionLine: notification.line }),
        ...(wallClockMs !== undefined && { wallClockMs }),
        status,
      });
    }
  }
  return background;
}

function computeNearDuplicates(entries: readonly BashEntry[]): BashNearDuplicateGroup[] {
  interface Acc {
    count: number;
    exampleSeen: Set<string>;
    examples: string[];
    occurrences: Array<{ thread: string; line: number }>;
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
    acc.occurrences.push({ thread: entry.thread, line: entry.line });
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
    .map((entry) => ({
      command: cap(entry.command),
      resultChars: entry.resultChars,
      line: entry.line,
      thread: entry.thread,
      truncatedByHarness: detectHarnessTruncation(),
    }))
    .sort((a, b) => b.resultChars - a.resultChars);
}

/**
 * Per-thread (a subagent's retries have nothing to do with the main
 * transcript's next call, so cross-thread lookahead would be meaningless),
 * but the result is grouped globally by normalized pattern.
 */
function computeRerunAfterError(threads: readonly BashStatsThread[]): BashRerunAfterError[] {
  const byPattern = new Map<
    string,
    { count: number; occurrences: Array<{ thread: string; errorLine: number; rerunLine: number }> }
  >();

  for (const { thread, data } of threads) {
    const threadEntries = data.toolCalls
      .filter((c) => c.name === "Bash")
      .map((c) => ({
        line: c.line,
        command: commandOf(c),
        isError: c.result?.isError === true,
      }));

    for (let i = 0; i < threadEntries.length; i += 1) {
      const failing = threadEntries[i];
      if (failing === undefined || !failing.isError) continue;
      const failingPattern = normalizeCommandForDedup(failing.command);
      const windowEnd = Math.min(i + RERUN_LOOKAHEAD, threadEntries.length - 1);
      for (let j = i + 1; j <= windowEnd; j += 1) {
        const candidate = threadEntries[j];
        if (candidate === undefined) continue;
        if (normalizeCommandForDedup(candidate.command) !== failingPattern) continue;
        let acc = byPattern.get(failingPattern);
        if (acc === undefined) {
          acc = { count: 0, occurrences: [] };
          byPattern.set(failingPattern, acc);
        }
        acc.count += 1;
        acc.occurrences.push({ thread, errorLine: failing.line, rerunLine: candidate.line });
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
    result.push({
      command: cap(entry.command),
      resultChars: entry.resultChars,
      line: entry.line,
      thread: entry.thread,
    });
  }
  return result;
}

/**
 * Compute Bash-command analytics over every thread's `Bash` tool calls (main
 * transcript first, then each subagent) — see the module doc comment for why
 * this is one joint pass rather than a per-thread fold+merge.
 */
export function computeBashStats(threads: readonly BashStatsThread[]): BashStats {
  const entries = collectEntries(threads);
  const totals = computeTotals(entries);
  return {
    totals,
    byCommand: computeByCommand(entries, totals),
    programFrequency: computeProgramFrequency(entries),
    heavyHitters: computeHeavyHitters(entries),
    background: computeBackground(threads),
    waste: {
      nearDuplicates: computeNearDuplicates(entries),
      largeResults: computeLargeResults(entries),
      rerunAfterError: computeRerunAfterError(threads),
      bashAsRead: computeBashAsRead(entries),
    },
  };
}
