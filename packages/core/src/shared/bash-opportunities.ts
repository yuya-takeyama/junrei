/**
 * Bash-analysis "opportunities" engine (v2 PR A) — turns the enriched
 * `BashStats` waste/thread data (`./bash-stats.ts`) into a ranked list of
 * actionable, templated fix suggestions. Wired in as `BashStats.opportunities`
 * from `computeBashStats` itself (see that module's doc comment for why that's
 * the chosen seam), so both harnesses — and the server's Codex forest-joint
 * recompute, which just re-exports `computeBashStats` — get this for free.
 *
 * Only depends on `byThread` (for a thread -> model lookup) and `waste` (the
 * four waste categories) — not the full `BashStats` — since that's the
 * complete, minimal input surface this module actually reads; see
 * `computeBashOpportunities`'s own parameter type.
 *
 * ## Savings rules (product-owner decisions, not re-litigated here)
 *
 * `near-duplicate` is MEASURED, but narrower than the raw
 * `waste.nearDuplicates` grouping it reads from: a shape-only match
 * (`normalizeCommandForDedup` — paths/numbers/quoted strings collapsed to
 * placeholders) is NOT enough to price as waste on its own. Two calls that
 * share a shape but differ in concrete arguments (`git diff a.ts` vs.
 * `git diff b.ts`, `cd <worktree-1> && pnpm test` vs. `cd <worktree-2> &&
 * pnpm test`) are legitimate, non-redundant work, not repetition — pricing
 * them as waste is a false positive (verified against real session data: 3
 * of the top 4 briefing items were exactly this). So each shape group is
 * FIRST re-partitioned by exact concrete command text, and a partition is
 * only priced when it (a) has >=3 occurrences with identical command text
 * AND (b) every occurrence's `resultChars` is known and STRICTLY EQUAL
 * across the partition — a byte-identical result is the actual confirming
 * signal of redundant work, not just a matching command shape. A shape
 * group can therefore yield zero, one, or several priced opportunities (one
 * per confirmed partition); partitions that don't confirm are silently
 * DROPPED, not surfaced as some lower-confidence placeholder — the raw
 * shape-only groups remain visible via `BashStats.waste.nearDuplicates` for
 * anyone who wants the unfiltered signal. See
 * `buildNearDuplicateOpportunities`/`confirmDuplicatePartition`.
 *
 * `rerun-after-error` is MEASURED the ordinary way: every group already
 * names its own occurrences with a real `resultChars`, so "what would fixing
 * this actually have saved" is a real sum, not a guess — see
 * `measuredSkipFirstSavings`'s own doc comment for exactly which occurrences
 * count.
 *
 * `bash-as-read` and `large-result` are HEURISTIC: there's no evidence of
 * what a targeted Read call or a quiet/tail'd command actually would have
 * produced, so the "avoidable" share is a fixed coefficient — see
 * `BASH_AS_READ_AVOIDABLE`/`LARGE_RESULT_AVOIDABLE`'s own doc comments.
 *
 * Per opportunity, `estUsdSaved` is ALL-OR-NOTHING: if even one occurrence
 * that contributes to the figure has an unknown/unpriced thread model, the
 * WHOLE opportunity's `estUsdSaved` stays `undefined` (never a partial sum) —
 * a headline "you could save $X" claim is far more likely to be acted on
 * literally than an aggregate rollup field, so a partial number here would be
 * actively misleading about how complete the picture is. This is the
 * opposite of `BashStats.totals.estUsd`/`byCommand[].estUsd`/
 * `byThread[].estUsd`, which stay PARTIAL sums (never zeroed out by one
 * unpriced contributor) — those are rollups meant to show "how much is
 * known so far", not a specific savings claim to act on.
 */
import type {
  BashAsReadCall,
  BashLargeResult,
  BashNearDuplicateGroup,
  BashRerunAfterError,
  BashThreadGroup,
  BashWaste,
} from "./bash-stats.js";
import { estUsdForChars, normalizeCommandForDedup } from "./bash-stats.js";
import { parseShellCommand, primaryCommand } from "./shell/parser.js";

export type BashOpportunityClass =
  | "bash-as-read"
  | "large-result"
  | "near-duplicate"
  | "rerun-after-error";

export type BashOpportunityLever =
  | "spawn-prompt"
  | "claude-md-rule"
  | "command-flag"
  | "delegation"
  | "investigate";

export type BashOpportunitySavingsBasis = "measured" | "heuristic" | "none";

export interface BashOpportunityEvidence {
  thread: string;
  line: number;
  toolUseId?: string;
  resultChars: number;
  /** `estUsdForChars` for this ONE evidence entry — `undefined` when its thread's model is unknown/unpriced. */
  estUsd?: number;
}

export interface BashOpportunity {
  class: BashOpportunityClass;
  /** Templated, data-filled headline naming the representative (largest) evidence — see each class's builder for the exact template. */
  title: string;
  lever: BashOpportunityLever;
  /** Copy-ready, imperative, templated advice — parameterized from this opportunity's own data (command/thread/pattern/sizes), never generic boilerplate. */
  fixText: string;
  /** `undefined` unless EVERY occurrence contributing to this figure has a known, priced thread model — see the module doc comment's "all-or-nothing" rule. Never `0` for "unknown"; a real `0` (e.g. every avoidable occurrence produced empty output) is a legitimate value. */
  estUsdSaved?: number;
  savingsBasis: BashOpportunitySavingsBasis;
  /** Present iff `savingsBasis === "heuristic"` — names the coefficient used (`BASH_AS_READ_AVOIDABLE`/`LARGE_RESULT_AVOIDABLE`) and its value. */
  heuristicNote?: string;
  occurrenceCount: number;
  /** Sum of every contributing occurrence's `resultChars` — descriptive only, NOT `estUsdSaved`'s basis (that's a priced, coefficient-applied subset). */
  totalChars: number;
  /** Every distinct thread this opportunity's occurrences touched, in first-seen order. */
  threads: string[];
  /** Largest-`resultChars`-first, capped to `EVIDENCE_LIMIT`. */
  evidence: BashOpportunityEvidence[];
}

/**
 * Judgment coefficient, NOT measured: a `bash-as-read` finding (a
 * `cat`/`head`/`tail`/`sed` call used the way the Read tool would) has no
 * evidence of what a targeted `Read` call (with `offset`/`limit`) actually
 * would have fetched instead — this is fixed product judgment that a
 * targeted Read typically retrieves ~30% of what a full-file dump costs, so
 * 70% of the observed `resultChars` is booked as the avoidable share.
 * Revisit if real offset/limit usage data ever justifies a different number.
 */
export const BASH_AS_READ_AVOIDABLE = 0.7;

/**
 * Judgment coefficient, NOT measured: a `large-result` finding has no
 * evidence of what a quiet-reporter or `| tail`'d version of the same command
 * would have produced instead — fixed product judgment that such a filter
 * typically retains ~10% of a verbose dump's volume, so 90% of the observed
 * `resultChars` is booked as the avoidable share.
 */
export const LARGE_RESULT_AVOIDABLE = 0.9;

const EVIDENCE_LIMIT = 10;

function threadModelLookup(
  byThread: readonly BashThreadGroup[],
): (thread: string) => string | undefined {
  const map = new Map(byThread.map((row) => [row.thread, row.model]));
  return (thread: string) => map.get(thread);
}

function uniqueThreads(items: readonly { thread: string }[]): string[] {
  return [...new Set(items.map((item) => item.thread))];
}

function sumChars(items: readonly { resultChars: number }[]): number {
  return items.reduce((sum, item) => sum + item.resultChars, 0);
}

/** `"sub1"` / `"sub1 and sub2"` / `"3 threads"` — keeps templated text readable regardless of how many threads an opportunity spans. */
function describeThreads(threads: readonly string[]): string {
  if (threads.length === 0) return "no threads";
  if (threads.length <= 2) return threads.join(" and ");
  return `${threads.length} threads`;
}

function formatCharsShort(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}k` : `${chars}`;
}

function familyOf(command: string): string {
  const primary = primaryCommand(parseShellCommand(command));
  return primary?.executable ?? "(unparsed)";
}

function modelSuffix(thread: string, modelOf: (thread: string) => string | undefined): string {
  const model = modelOf(thread);
  return model !== undefined ? ` (${model})` : "";
}

function buildEvidence(
  items: ReadonlyArray<{ thread: string; line: number; resultChars: number }>,
  modelOf: (thread: string) => string | undefined,
): BashOpportunityEvidence[] {
  return [...items]
    .sort((a, b) => b.resultChars - a.resultChars)
    .slice(0, EVIDENCE_LIMIT)
    .map((item) => {
      const estUsd = estUsdForChars(item.resultChars, modelOf(item.thread));
      return {
        thread: item.thread,
        line: item.line,
        resultChars: item.resultChars,
        ...(estUsd !== undefined && { estUsd }),
      };
    });
}

/**
 * The MEASURED savings rule for a CONFIRMED `near-duplicate` partition (see
 * `confirmDuplicatePartition` — this is called only after a shape group has been
 * re-partitioned by exact concrete command and confirmed byte-identical):
 * the FIRST occurrence in the partition is forgiven (it established the
 * pattern — a first Bash call is normal), and every occurrence AFTER it is
 * priced as avoidable waste. All-or-nothing per the module doc comment:
 * `undefined` the moment any of `occurrences[1..]` can't be priced (its
 * thread's model is unknown/unpriced), rather than a partial sum.
 */
function measuredSkipFirstSavings(
  occurrences: readonly { thread: string; resultChars: number }[],
  modelOf: (thread: string) => string | undefined,
): number | undefined {
  return measuredSavings(occurrences.slice(1), modelOf);
}

/**
 * The MEASURED savings rule for `rerun-after-error`: EVERY occurrence is
 * priced — each element of a rerun group is already a repeat call (an
 * error→rerun pair), and the error output was there to read before
 * re-running, so no occurrence is "forgiven" the way a near-duplicate
 * group's first call is. All-or-nothing per the module doc comment.
 */
function measuredSavings(
  occurrences: readonly { thread: string; resultChars: number }[],
  modelOf: (thread: string) => string | undefined,
): number | undefined {
  let sum = 0;
  for (const occurrence of occurrences) {
    const usd = estUsdForChars(occurrence.resultChars, modelOf(occurrence.thread));
    if (usd === undefined) return undefined;
    sum += usd;
  }
  return sum;
}

/**
 * The HEURISTIC savings rule shared by `bash-as-read` and `large-result`:
 * every (non-placeholder) member's own priced `resultChars`, scaled by
 * `coefficient`. All-or-nothing per the module doc comment. `undefined` (not
 * `0`) when `calls` is empty (every member was a placeholder — nothing left
 * to price).
 */
function heuristicSavings(
  calls: readonly { thread: string; resultChars: number }[],
  modelOf: (thread: string) => string | undefined,
  coefficient: number,
): number | undefined {
  if (calls.length === 0) return undefined;
  let sum = 0;
  for (const call of calls) {
    const usd = estUsdForChars(call.resultChars, modelOf(call.thread));
    if (usd === undefined) return undefined;
    sum += usd * coefficient;
  }
  return sum;
}

/**
 * `BashNearDuplicateGroup.occurrences[].resultChars`/`BashRerunAfterError.occurrences[].resultChars`
 * are typed OPTIONAL on the public interface (backward compatibility for
 * hand-built literals elsewhere in the monorepo that predate this field —
 * see those interfaces' own doc comments), but `computeBashStats` itself
 * always sets a real value. This engine has no evidence to price a truly
 * missing figure with, so it coalesces to `0` (chars, not $) — a literal
 * `BashWaste` built by some OTHER caller without `resultChars` prices as "no
 * measured waste" for that occurrence rather than throwing.
 */
function charsOf(occurrence: { resultChars?: number }): number {
  return occurrence.resultChars ?? 0;
}

/** Same threshold semantics as `nearDuplicates` itself (see `NEAR_DUPLICATE_MIN_COUNT` in `./bash-stats.ts`) — applied here to a concrete-command PARTITION rather than the raw shape group. */
const NEAR_DUPLICATE_CONFIRM_MIN = 3;

type NearDuplicateOccurrence = BashNearDuplicateGroup["occurrences"][number];

interface ConfirmedDuplicatePartition {
  command: string;
  occurrences: ReadonlyArray<{ thread: string; line: number; resultChars: number }>;
}

/**
 * Re-partitions a shape group's occurrences by EXACT concrete `command`
 * text — see the module doc comment's near-duplicate section. An occurrence
 * with no known `command` (backward-compat data — see
 * `BashNearDuplicateGroup.occurrences`'s own doc comment) can never be
 * identified with a partition, so it's dropped here rather than folded into
 * some catch-all "unknown" bucket.
 */
function partitionByConcreteCommand(
  occurrences: readonly NearDuplicateOccurrence[],
): Map<string, NearDuplicateOccurrence[]> {
  const partitions = new Map<string, NearDuplicateOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.command === undefined) continue;
    const list = partitions.get(occurrence.command);
    if (list === undefined) partitions.set(occurrence.command, [occurrence]);
    else list.push(occurrence);
  }
  return partitions;
}

/**
 * Confirms (or rejects) one concrete-command partition as real (not just
 * shape-only) near-duplicate waste — see the module doc comment. Requires
 * >=3 occurrences (`NEAR_DUPLICATE_CONFIRM_MIN`) AND every occurrence's
 * `resultChars` known and STRICTLY EQUAL across the whole partition; a
 * partition with even one unknown result can never confirm. Returns
 * `undefined` for "doesn't qualify" rather than a boolean, since the caller
 * needs `resultChars` narrowed to non-optional for pricing anyway — this
 * shape sidesteps `noUncheckedIndexedAccess` friction a plain type-predicate
 * guard would hit when re-reading `partition[0]` after narrowing.
 */
function confirmDuplicatePartition(
  partition: readonly NearDuplicateOccurrence[],
): ConfirmedDuplicatePartition | undefined {
  if (partition.length < NEAR_DUPLICATE_CONFIRM_MIN) return undefined;
  const first = partition[0];
  if (first === undefined || first.resultChars === undefined || first.command === undefined) {
    return undefined;
  }
  const confirmedChars = first.resultChars;
  const command = first.command;
  const occurrences: Array<{ thread: string; line: number; resultChars: number }> = [];
  for (const o of partition) {
    if (o.resultChars !== confirmedChars) return undefined;
    occurrences.push({ thread: o.thread, line: o.line, resultChars: o.resultChars });
  }
  return { command, occurrences };
}

/** `"Run once and embed in spawn prompts"` (multi-thread) vs. `"reuse the first result"` (single-thread) — see the module doc comment: isolated subagent contexts can't reuse a result fetched in another thread, so the fix has to say so instead of suggesting reuse. */
function nearDuplicateFixText(command: string, threads: readonly string[], count: number): string {
  if (threads.length > 1) {
    return `Run \`${command}\` once in the orchestrator and embed the result in the spawn prompts for ${describeThreads(threads)} — it returned byte-identical output ${count} times across separate threads; isolated subagent contexts can't reuse a result fetched elsewhere.`;
  }
  return `Batch or cache \`${command}\` in ${describeThreads(threads)} — it ran ${count} times with identical output; combine the calls into one, or reuse the first result instead of re-running it.`;
}

function buildNearDuplicateOpportunities(
  groups: readonly BashNearDuplicateGroup[],
  modelOf: (thread: string) => string | undefined,
): BashOpportunity[] {
  const opportunities: BashOpportunity[] = [];
  for (const group of groups) {
    for (const partition of partitionByConcreteCommand(group.occurrences).values()) {
      const confirmed = confirmDuplicatePartition(partition);
      if (confirmed === undefined) continue;
      const { command, occurrences } = confirmed;
      const threads = uniqueThreads(occurrences);
      const estUsdSaved = measuredSkipFirstSavings(occurrences, modelOf);
      opportunities.push({
        class: "near-duplicate",
        title: `${occurrences.length}× "${command}" repeated across ${describeThreads(threads)}`,
        lever: "spawn-prompt",
        fixText: nearDuplicateFixText(command, threads, occurrences.length),
        ...(estUsdSaved !== undefined && { estUsdSaved }),
        savingsBasis: "measured",
        occurrenceCount: occurrences.length,
        totalChars: sumChars(occurrences),
        threads,
        evidence: buildEvidence(occurrences, modelOf),
      });
    }
  }
  return opportunities;
}

function buildRerunAfterErrorOpportunities(
  groups: readonly BashRerunAfterError[],
  modelOf: (thread: string) => string | undefined,
): BashOpportunity[] {
  return groups.map((group) => {
    const reruns = group.occurrences.map((o) => ({ thread: o.thread, resultChars: charsOf(o) }));
    const threads = uniqueThreads(group.occurrences);
    const estUsdSaved = measuredSavings(reruns, modelOf);
    return {
      class: "rerun-after-error",
      title: `${group.count}× re-run after error: "${group.pattern}"`,
      lever: "investigate",
      fixText: `Read the failure output before re-running \`${group.pattern}\` — it failed then was immediately re-run ${group.count} time(s) in ${describeThreads(threads)}; investigating the error first can avoid the repeat call entirely.`,
      ...(estUsdSaved !== undefined && { estUsdSaved }),
      savingsBasis: "measured",
      occurrenceCount: group.count,
      totalChars: sumChars(reruns),
      threads,
      evidence: buildEvidence(
        group.occurrences.map((o) => ({
          thread: o.thread,
          line: o.rerunLine,
          resultChars: charsOf(o),
        })),
        modelOf,
      ),
    };
  });
}

interface SizedCall {
  command: string;
  resultChars: number;
  line: number;
  thread: string;
  resultIsPlaceholder?: boolean;
}

/** Groups a flat per-call waste list by `normalizeCommandForDedup` — the same shape-only pattern `nearDuplicates` already groups by — so one CLAUDE.md rule / command fix can address every near-identical call at once, across every thread it occurred in. */
function groupByPattern<T extends SizedCall>(calls: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const call of calls) {
    const pattern = normalizeCommandForDedup(call.command);
    const list = groups.get(pattern);
    if (list === undefined) groups.set(pattern, [call]);
    else list.push(call);
  }
  return groups;
}

function largestOf<T extends SizedCall>(calls: readonly T[]): T | undefined {
  return [...calls].sort((a, b) => b.resultChars - a.resultChars)[0];
}

function buildBashAsReadOpportunities(
  calls: readonly BashAsReadCall[],
  modelOf: (thread: string) => string | undefined,
): BashOpportunity[] {
  const result: BashOpportunity[] = [];
  for (const members of groupByPattern(calls).values()) {
    const largest = largestOf(members);
    if (largest === undefined) continue;
    const priced = members.filter((m) => m.resultIsPlaceholder !== true);
    const threads = uniqueThreads(members);
    const totalChars = sumChars(members);
    const family = familyOf(largest.command);
    const estUsdSaved = heuristicSavings(priced, modelOf, BASH_AS_READ_AVOIDABLE);
    result.push({
      class: "bash-as-read",
      title: `${formatCharsShort(largest.resultChars)}-char ${family} inside ${largest.thread}${modelSuffix(largest.thread, modelOf)}`,
      lever: "claude-md-rule",
      fixText: `Add a CLAUDE.md rule for ${describeThreads(threads)}: use the Read tool (with offset/limit) instead of \`${family}\` — \`${largest.command}\` alone returned ${largest.resultChars.toLocaleString()} chars (${members.length} call(s) of this shape, ${totalChars.toLocaleString()} chars total).`,
      ...(estUsdSaved !== undefined && { estUsdSaved }),
      savingsBasis: "heuristic",
      heuristicNote: `Assumes a targeted Read recovers the rest of the value — ${Math.round(BASH_AS_READ_AVOIDABLE * 100)}% of resultChars is booked as avoidable (BASH_AS_READ_AVOIDABLE=${BASH_AS_READ_AVOIDABLE}).`,
      occurrenceCount: members.length,
      totalChars,
      threads,
      evidence: buildEvidence(members, modelOf),
    });
  }
  return result;
}

/**
 * Whether `command` is a JSON-extraction pipeline — invokes `jq` (as its own
 * token/segment, not a substring match — e.g. `jqsomething` doesn't count),
 * or `cat`s a `.json` file. A quiet-reporter/`--quiet`/`| tail` suggestion is
 * the wrong fix for this shape: the oversized output is typically ONE large
 * string field (verified against a real 29,467-char result where ~29k was
 * two embedded `script` fields that passed a `type != array/object` jq
 * filter) that a volume-trimming flag wouldn't touch — the real fix is
 * excluding/selecting fields. See `buildLargeResultOpportunities`.
 */
function isJsonExtractionCommand(command: string): boolean {
  const segments = parseShellCommand(command).segments;
  return segments.some((segment) => {
    if (segment.executable === "jq") return true;
    if (segment.executable === "cat") return segment.args.some((arg) => /\.json$/i.test(arg));
    return false;
  });
}

function largeResultFixText(
  command: string,
  resultChars: number,
  count: number,
  totalChars: number,
  threads: readonly string[],
): string {
  const sizeDescription = `it returned ${resultChars.toLocaleString()} chars (${count} call(s) of this shape totaling ${totalChars.toLocaleString()} chars in ${describeThreads(threads)}).`;
  if (isJsonExtractionCommand(command)) {
    return `Exclude the large JSON fields from \`${command}\` — drop the large string fields with \`del(...)\` or select only the fields you need — ${sizeDescription}`;
  }
  return `Pipe \`${command}\` through a quiet reporter or add a \`--quiet\`/\`| tail\` filter — ${sizeDescription}`;
}

function largeResultHeuristicNote(command: string): string {
  const volumeNote = isJsonExtractionCommand(command)
    ? "Assumes excluding the large JSON fields keeps"
    : "Assumes a quiet/tail'd version keeps";
  return `${volumeNote} ~${Math.round((1 - LARGE_RESULT_AVOIDABLE) * 100)}% of the volume — ${Math.round(LARGE_RESULT_AVOIDABLE * 100)}% of resultChars is booked as avoidable (LARGE_RESULT_AVOIDABLE=${LARGE_RESULT_AVOIDABLE}).`;
}

function buildLargeResultOpportunities(
  calls: readonly BashLargeResult[],
  modelOf: (thread: string) => string | undefined,
): BashOpportunity[] {
  const result: BashOpportunity[] = [];
  for (const members of groupByPattern(calls).values()) {
    const largest = largestOf(members);
    if (largest === undefined) continue;
    const priced = members.filter((m) => m.resultIsPlaceholder !== true);
    const threads = uniqueThreads(members);
    const totalChars = sumChars(members);
    const family = familyOf(largest.command);
    const estUsdSaved = heuristicSavings(priced, modelOf, LARGE_RESULT_AVOIDABLE);
    result.push({
      class: "large-result",
      title: `${formatCharsShort(largest.resultChars)}-char ${family} result inside ${largest.thread}${modelSuffix(largest.thread, modelOf)}`,
      lever: "command-flag",
      fixText: largeResultFixText(
        largest.command,
        largest.resultChars,
        members.length,
        totalChars,
        threads,
      ),
      ...(estUsdSaved !== undefined && { estUsdSaved }),
      savingsBasis: "heuristic",
      heuristicNote: largeResultHeuristicNote(largest.command),
      occurrenceCount: members.length,
      totalChars,
      threads,
      evidence: buildEvidence(members, modelOf),
    });
  }
  return result;
}

const BASIS_TIER: Record<BashOpportunitySavingsBasis, number> = {
  measured: 0,
  heuristic: 1,
  none: 2,
};

/**
 * Sorted by `estUsdSaved` desc; `savingsBasis === "none"` entries always sort
 * last regardless of anything else (no class currently produces "none" — see
 * `BashOpportunitySavingsBasis`'s doc comment — this is defensive for a
 * future class that might). Within entries that share "no `estUsdSaved`"
 * (an unpriced model), group by basis tier (measured before heuristic — real
 * repeat-occurrence evidence outranks a coefficient-based guess even without
 * a dollar figure), then by `totalChars` desc.
 */
function compareOpportunities(a: BashOpportunity, b: BashOpportunity): number {
  const aNone = a.savingsBasis === "none";
  const bNone = b.savingsBasis === "none";
  if (aNone !== bNone) return aNone ? 1 : -1;

  const aHas = a.estUsdSaved !== undefined;
  const bHas = b.estUsdSaved !== undefined;
  if (aHas && bHas) return (b.estUsdSaved ?? 0) - (a.estUsdSaved ?? 0);
  if (aHas !== bHas) return aHas ? -1 : 1;

  if (BASIS_TIER[a.savingsBasis] !== BASIS_TIER[b.savingsBasis]) {
    return BASIS_TIER[a.savingsBasis] - BASIS_TIER[b.savingsBasis];
  }
  return b.totalChars - a.totalChars;
}

/**
 * Pure function over the enriched Bash-analysis waste data — see the module
 * doc comment for the savings rules and why only `byThread`/`waste` (not the
 * full `BashStats`) is needed.
 */
export function computeBashOpportunities(input: {
  byThread: readonly BashThreadGroup[];
  waste: BashWaste;
}): BashOpportunity[] {
  const modelOf = threadModelLookup(input.byThread);
  const opportunities: BashOpportunity[] = [
    ...buildNearDuplicateOpportunities(input.waste.nearDuplicates, modelOf),
    ...buildRerunAfterErrorOpportunities(input.waste.rerunAfterError, modelOf),
    ...buildBashAsReadOpportunities(input.waste.bashAsRead, modelOf),
    ...buildLargeResultOpportunities(input.waste.largeResults, modelOf),
  ];
  return opportunities.sort(compareOpportunities);
}
