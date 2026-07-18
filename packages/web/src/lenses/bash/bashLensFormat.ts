import type { BashStatsJson } from "../../api.js";
import { formatTokens } from "../../format.js";

export type BashCommandGroupJson = BashStatsJson["byCommand"][number];
export type BashHeavyHitterJson = BashStatsJson["heavyHitters"][number];
export type BashWasteJson = BashStatsJson["waste"];
export type BashNearDuplicateGroupJson = BashWasteJson["nearDuplicates"][number];
export type BashLargeResultJson = BashWasteJson["largeResults"][number];
export type BashRerunAfterErrorJson = BashWasteJson["rerunAfterError"][number];
export type BashAsReadCallJson = BashWasteJson["bashAsRead"][number];

/**
 * "git diff" from `{family: "git", subcommand: "diff"}` — the Command
 * ranking table's row label (Bash lens panel 1). `subcommand` is only
 * present when `family` is a known command family (git, gh, pnpm, ...) — see
 * `BashCommandGroup`'s doc comment in `@junrei/core`'s `bash-stats.ts`.
 */
export function commandLabel(group: { family: string; subcommand?: string | undefined }): string {
  return group.subcommand !== undefined ? `${group.family} ${group.subcommand}` : group.family;
}

/**
 * Newline-joined tooltip text for a command group's up-to-3 sample commands
 * (`title=` attribute) — the disclosure mechanism the rest of this app
 * already uses for "more detail than fits the row" (e.g. `CostByModelTable`'s
 * `title={m.model}`, `FileAccessTree`'s `injectedTitle`), rather than
 * inventing a new expand/collapse widget for a table that has no sibling
 * precedent for one. `undefined` when there are no samples to show.
 */
export function sampleCommandsTitle(samples: readonly string[]): string | undefined {
  return samples.length === 0 ? undefined : samples.join("\n");
}

/** `≈ 25.3k` — every estimated-token figure in this lens gets this prefix so it never reads as an exact count (see `BashTotals.estimatedTokens`'s doc comment in `@junrei/core`: `Math.ceil(chars / 4)`, not a real tokenizer). Mirrors the `"≈ "` convention Timeline's turn columns already use for `costIncomplete`/`delegatedCostIncomplete` figures (`turnColumns.ts`). */
export function formatEstimatedTokens(n: number): string {
  return `≈ ${formatTokens(n)}`;
}

/** Length above which a thread id (an `agentId` — a tool_use id, not a short label) gets shortened for display — mirrors `SessionShell.tsx`'s own `shortenId`, kept as a separate small copy here rather than exporting that one, since it's a session-id-copy-pill concern there and a thread-attribution-badge concern here. */
const THREAD_ID_SHORTEN_THRESHOLD = 13;

function shortenThreadId(id: string): string {
  return id.length > THREAD_ID_SHORTEN_THRESHOLD ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export interface ThreadLabel {
  /** Display text — "main", or a shortened subagent `agentId`. */
  text: string;
  isMain: boolean;
}

/**
 * "main" vs. a shortened subagent `agentId` — every per-call Bash entry
 * carries a `thread` field (`"main"` or an `agentId`, see `BashHeavyHitter`
 * et al. in `@junrei/core`'s `bash-stats.ts`), and this is the one place that
 * turns it into a badge. Mirrors `FileAccessTree.tsx`'s `THREAD_LABEL`
 * convention (subagent gets the `amb` accent, main stays muted) rather than
 * introducing a new visual language for "which thread".
 */
export function threadLabel(thread: string): ThreadLabel {
  return thread === "main"
    ? { text: "main", isMain: true }
    : { text: shortenThreadId(thread), isMain: false };
}

/** Result of capping a list for display while still knowing the true total — same cap/count split `TaskExecutionsPanel`/`ApiErrorsPanel` already use ("+N more not shown"). */
export interface CappedList<T> {
  shown: readonly T[];
  hiddenCount: number;
}

export function capList<T>(items: readonly T[], limit: number): CappedList<T> {
  return { shown: items.slice(0, limit), hiddenCount: Math.max(0, items.length - limit) };
}

/** "main L12" — one near-duplicate/bash-as-read style occurrence, thread + line. */
export function formatOccurrence(o: { thread: string; line: number }): string {
  return `${threadLabel(o.thread).text} L${o.line}`;
}

/** "main L12→L15" — one rerun-after-error occurrence, thread + the failing call's line and its rerun's line. */
export function formatRerunOccurrence(o: {
  thread: string;
  errorLine: number;
  rerunLine: number;
}): string {
  return `${threadLabel(o.thread).text} L${o.errorLine}→L${o.rerunLine}`;
}

/** Whether the session has any Bash calls at all — the Bash lens's single empty-state gate (`Bash.tsx`), extracted as its own predicate so the "no Bash calls" branch is unit-testable without rendering JSX. */
export function hasBashActivity(totals: BashStatsJson["totals"]): boolean {
  return totals.calls > 0;
}

/** One rendered row of the Command ranking table (panel 1) — everything `CommandRankingTable.tsx` needs, precomputed so the component is a pure map+render over this array. */
export interface CommandRankingRow {
  key: string;
  label: string;
  sampleTitle: string | undefined;
  calls: number;
  errors: number;
  hasErrors: boolean;
  totalCharsText: string;
  avgCharsText: string;
  estTokensText: string;
  shareText: string;
}

export function buildCommandRankingRows(
  byCommand: readonly BashCommandGroupJson[],
): CommandRankingRow[] {
  return byCommand.map((group) => ({
    key: `${group.family}-${group.subcommand ?? ""}`,
    label: commandLabel(group),
    sampleTitle: sampleCommandsTitle(group.sampleCommands),
    calls: group.calls,
    errors: group.errors,
    hasErrors: group.errors > 0,
    totalCharsText: formatTokens(group.totalResultChars),
    avgCharsText: formatTokens(group.avgResultChars),
    estTokensText: formatEstimatedTokens(group.estimatedTokens),
    shareText: `${group.sharePct.toFixed(1)}%`,
  }));
}

/** One rendered row of the Heavy hitters table (panel 2) — see `HeavyHittersTable.tsx`. `line` stays on the row (not just baked into a formatted string) since the component's click handler needs the raw value to call `onOpenRecord`. */
export interface HeavyHitterRow {
  key: string;
  rank: number;
  command: string;
  thread: ThreadLabel;
  /**
   * Raw (untruncated) subagent `agentId` for this call's thread, or
   * `undefined` for the main thread — `thread.text` is display-shortened
   * (see `shortenThreadId`) and can't be used to route a record fetch, but
   * heavy hitters rank across every thread (see `computeHeavyHitters` in
   * `@junrei/core`'s `bash-stats.ts`), so most rows belong to a subagent.
   * `HeavyHittersTable`'s click handler needs this to pick between
   * `recordPath` and `agentRecordPath` (see `SessionShell.tsx`).
   */
  agentId: string | undefined;
  resultCharsText: string;
  line: number;
}

export function buildHeavyHitterRows(
  heavyHitters: readonly BashHeavyHitterJson[],
): HeavyHitterRow[] {
  return heavyHitters.map((hit, i) => ({
    key: hit.toolUseId,
    rank: i + 1,
    command: hit.command,
    thread: threadLabel(hit.thread),
    agentId: hit.thread === "main" ? undefined : hit.thread,
    resultCharsText: formatTokens(hit.resultChars),
    line: hit.line,
  }));
}

/** One rendered row of the near-duplicates / rerun-after-error waste subsections' free-form list — see `WasteDetectionPanel.tsx`. */
export interface WasteGroupRow {
  key: string;
  pattern: string;
  count: number;
  examplesText: string | undefined;
  occurrencesText: string;
}

function occurrencesText<T>(
  occurrences: readonly T[],
  format: (o: T) => string,
  limit: number,
): string {
  const { shown, hiddenCount } = capList(occurrences, limit);
  const text = shown.map(format).join(", ");
  return hiddenCount > 0 ? `${text}, +${hiddenCount} more` : text;
}

export function buildNearDuplicateRows(
  groups: readonly BashNearDuplicateGroupJson[],
  occurrenceLimit: number,
): WasteGroupRow[] {
  return groups.map((group) => ({
    key: group.pattern,
    pattern: group.pattern,
    count: group.count,
    examplesText: group.examples.length > 0 ? group.examples.join(" · ") : undefined,
    occurrencesText: occurrencesText(group.occurrences, formatOccurrence, occurrenceLimit),
  }));
}

export function buildRerunAfterErrorRows(
  groups: readonly BashRerunAfterErrorJson[],
  occurrenceLimit: number,
): WasteGroupRow[] {
  return groups.map((group) => ({
    key: group.pattern,
    pattern: group.pattern,
    count: group.count,
    examplesText: undefined,
    occurrencesText: occurrencesText(group.occurrences, formatRerunOccurrence, occurrenceLimit),
  }));
}

/** One rendered row of the large-results / bash-as-read waste subsections' flat `.bflat` list — see `WasteDetectionPanel.tsx`. Both subsections share this shape (`command`/`resultChars`/`thread`/`line`), so one builder covers either array. */
export interface FlatWasteRow {
  key: string;
  command: string;
  resultCharsText: string;
  thread: ThreadLabel;
  line: number;
}

export function buildFlatWasteRows(
  rows: readonly (BashLargeResultJson | BashAsReadCallJson)[],
): FlatWasteRow[] {
  return rows.map((row) => ({
    key: `${row.thread}-${row.line}`,
    command: row.command,
    resultCharsText: formatTokens(row.resultChars),
    thread: threadLabel(row.thread),
    line: row.line,
  }));
}
