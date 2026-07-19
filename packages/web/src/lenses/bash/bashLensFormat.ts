import type { BashStatsJson, SessionBashPercentileJson } from "../../api.js";
import { formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";

export type BashCommandGroupJson = BashStatsJson["byCommand"][number];
export type BashThreadGroupJson = BashStatsJson["byThread"][number];
export type BashHeavyHitterJson = BashStatsJson["heavyHitters"][number];
export type BashOpportunityJson = BashStatsJson["opportunities"][number];
export type BashOpportunityEvidenceJson = BashOpportunityJson["evidence"][number];

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
 * precedent. `undefined` when there are no samples to show.
 */
export function sampleCommandsTitle(samples: readonly string[]): string | undefined {
  return samples.length === 0 ? undefined : samples.join("\n");
}

/** `≈ 25.3k` — every estimated-token figure in this lens gets this prefix so it never reads as an exact count (see `BashTotals.estimatedTokens`'s doc comment in `@junrei/core`: `Math.ceil(chars / 4)`, not a real tokenizer). Mirrors the `"≈ "` convention Timeline's turn columns already use for `costIncomplete`/`delegatedCostIncomplete` figures (`turnColumns.ts`). */
export function formatEstimatedTokens(n: number): string {
  return `≈ ${formatTokens(n)}`;
}

/** `~$0.42` — every Bash $ figure in this lens is an ESTIMATE (chars/4 × model input price, see the footer caveat in `Bash.tsx`), so every one of them gets this `~` prefix, never a bare `formatUsd`. */
export function formatEstUsd(n: number): string {
  return `~${formatUsd(n)}`;
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

/** Whether the session has any Bash calls at all — the Bash lens's single empty-state gate (`Bash.tsx`), extracted as its own predicate so the "no Bash calls" branch is unit-testable without rendering JSX. */
export function hasBashActivity(totals: BashStatsJson["totals"]): boolean {
  return totals.calls > 0;
}

/**
 * Header strip (Bash lens, top) — the lede: "Bash context cost ~$X.XX (est)"
 * (falling back to "~N est tokens" when no model in this session priced),
 * plus the optional percentile chip's two lines and its tooltip text.
 * `bashPercentile` is `undefined` whenever the server's `bash-percentile.ts`
 * gate didn't clear (not enough repo history) — the chip simply doesn't
 * render in that case, never a "not enough data" placeholder (this whole
 * lens already has a full-tab empty state for "no Bash calls at all"; a
 * thin repo history is a much more common, much less alarming case that
 * doesn't deserve its own placeholder).
 */
export interface HeaderStripModel {
  /** "~$0.42 (est)" or "~12.3k est tokens" — always `~`-prefixed, see the footer caveat. */
  costText: string;
  /** Whether `costText` is a priced $ figure (vs. the token-count fallback) — drives the chip's basis, since the percentile itself was ranked on whichever figure this is (see the server's `computeSessionBashPercentile`). */
  isUsd: boolean;
  /** "p88 for this repo" — `undefined` when the chip is hidden. */
  percentileText: string | undefined;
  /** "3.2x median" — `undefined` when the chip is hidden OR the repo's median for this metric is 0 (see the server's `computeSessionBashPercentile`). */
  medianRatioText: string | undefined;
  /** Chip tooltip — sample count, plus (Codex only) the main-thread-only caveat. `undefined` when the chip is hidden. */
  tooltip: string | undefined;
}

export function buildHeaderStrip(
  totals: BashStatsJson["totals"],
  bashPercentile: SessionBashPercentileJson | undefined,
  source: "claude-code" | "codex",
): HeaderStripModel {
  const isUsd = totals.estUsd !== undefined;
  const costText = isUsd
    ? `${formatEstUsd(totals.estUsd as number)} (est)`
    : `~${formatTokens(totals.estimatedTokens)} est tokens`;

  if (bashPercentile === undefined) {
    return {
      costText,
      isUsd,
      percentileText: undefined,
      medianRatioText: undefined,
      tooltip: undefined,
    };
  }

  const percentileText = `p${Math.round(bashPercentile.pct)} for this repo`;
  const medianRatioText =
    bashPercentile.medianRatio !== undefined
      ? `${bashPercentile.medianRatio.toFixed(1)}x median`
      : undefined;

  const notes = [`ranked against ${bashPercentile.sampleCount} session(s) in this repo`];
  if (source === "codex") {
    notes.push(
      "Codex sessions rank on main-thread-only Bash usage — this session's own figure above may understate its true total once sub-agents are included.",
    );
  }

  return { costText, isUsd, percentileText, medianRatioText, tooltip: notes.join(" — ") };
}

/**
 * WHO PAID panel's per-row view-model (Bash lens, money attribution) — the
 * orchestrator ("main") gets its own row, then up to `TOP_SUBAGENT_MODEL_ROWS`
 * subagent rows GROUPED BY MODEL (not by raw thread id — a session can carry
 * dozens of same-model subagent threads, and the question this panel answers
 * — "how much of the $ sat in the expensive orchestrator vs. cheap
 * subagents" — is a MODEL question, not a per-thread one), sorted by their
 * combined `resultChars` desc, plus one trailing "+N more" row folding
 * whatever model groups didn't make the top N. Percentages are computed
 * against the sum of every `byThread` row's own resultChars/estUsd (which
 * equals `BashStats.totals.resultChars`/`.estUsd` by construction — see
 * `computeByThread`'s doc comment in `@junrei/core`), so this needs no
 * separate `totals` argument.
 */
export interface ThreadMoneyRow {
  key: string;
  /** "main", a model's short label, or "+N more". */
  label: string;
  model: string | undefined;
  isOrchestrator: boolean;
  /** The trailing rolled-up row — renders muted, no model dot. */
  isAggregate: boolean;
  threadCount: number;
  resultChars: number;
  charsSharePct: number;
  estUsd: number | undefined;
  estUsdText: string;
  usdSharePct: number | undefined;
}

const TOP_SUBAGENT_MODEL_ROWS = 3;

interface ModelAgg {
  model: string | undefined;
  threadCount: number;
  resultChars: number;
  estUsd: number;
  estUsdKnown: boolean;
}

export function buildThreadMoneyRows(byThread: readonly BashThreadGroupJson[]): ThreadMoneyRow[] {
  let grandChars = 0;
  let grandUsd = 0;
  let grandUsdKnown = false;
  for (const t of byThread) {
    grandChars += t.resultChars;
    if (t.estUsd !== undefined) {
      grandUsd += t.estUsd;
      grandUsdKnown = true;
    }
  }

  const pctChars = (chars: number): number =>
    grandChars > 0 ? Math.round((chars / grandChars) * 1000) / 10 : 0;
  const pctUsd = (usd: number | undefined): number | undefined =>
    usd !== undefined && grandUsdKnown && grandUsd > 0
      ? Math.round((usd / grandUsd) * 1000) / 10
      : undefined;

  const rows: ThreadMoneyRow[] = [];

  const main = byThread.find((t) => t.thread === "main");
  if (main !== undefined) {
    rows.push({
      key: "main",
      label: "main",
      model: main.model,
      isOrchestrator: true,
      isAggregate: false,
      threadCount: 1,
      resultChars: main.resultChars,
      charsSharePct: pctChars(main.resultChars),
      estUsd: main.estUsd,
      estUsdText: main.estUsd !== undefined ? formatEstUsd(main.estUsd) : "—",
      usdSharePct: pctUsd(main.estUsd),
    });
  }

  const groups = new Map<string, ModelAgg>();
  for (const t of byThread) {
    if (t.thread === "main") continue;
    const key = t.model ?? " unknown";
    const g = groups.get(key) ?? {
      model: t.model,
      threadCount: 0,
      resultChars: 0,
      estUsd: 0,
      estUsdKnown: false,
    };
    g.threadCount += 1;
    g.resultChars += t.resultChars;
    if (t.estUsd !== undefined) {
      g.estUsd += t.estUsd;
      g.estUsdKnown = true;
    }
    groups.set(key, g);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => b.resultChars - a.resultChars);
  const shown = sortedGroups.slice(0, TOP_SUBAGENT_MODEL_ROWS);
  const rest = sortedGroups.slice(TOP_SUBAGENT_MODEL_ROWS);

  for (const g of shown) {
    rows.push({
      key: `model-${g.model ?? "unknown"}`,
      label: g.model !== undefined ? modelShortLabel(g.model) : "unknown model",
      model: g.model,
      isOrchestrator: false,
      isAggregate: false,
      threadCount: g.threadCount,
      resultChars: g.resultChars,
      charsSharePct: pctChars(g.resultChars),
      estUsd: g.estUsdKnown ? g.estUsd : undefined,
      estUsdText: g.estUsdKnown ? formatEstUsd(g.estUsd) : "—",
      usdSharePct: pctUsd(g.estUsdKnown ? g.estUsd : undefined),
    });
  }

  if (rest.length > 0) {
    const threadCount = rest.reduce((sum, g) => sum + g.threadCount, 0);
    const resultChars = rest.reduce((sum, g) => sum + g.resultChars, 0);
    let estUsd = 0;
    let estUsdKnown = false;
    for (const g of rest) {
      if (g.estUsdKnown) {
        estUsd += g.estUsd;
        estUsdKnown = true;
      }
    }
    rows.push({
      key: "more",
      label: `+${threadCount} more`,
      model: undefined,
      isOrchestrator: false,
      isAggregate: true,
      threadCount,
      resultChars,
      charsSharePct: pctChars(resultChars),
      estUsd: estUsdKnown ? estUsd : undefined,
      estUsdText: estUsdKnown ? formatEstUsd(estUsd) : "—",
      usdSharePct: pctUsd(estUsdKnown ? estUsd : undefined),
    });
  }

  return rows;
}

/** Model-dot accent class + short label for a `ThreadMoneyRow`/opportunity-evidence model — `undefined` model renders as a muted "?" dot (unknown/unpriced thread). */
export function threadMoneyModelDotClass(model: string | undefined): string {
  return model !== undefined ? `c-${classifyModel(model)}` : "c-mut";
}

/** One rendered row of the Fix Queue's expandable evidence list — see `OpportunityCardModel.evidence`. */
export interface OpportunityEvidenceRow {
  key: string;
  thread: ThreadLabel;
  /** Raw (untruncated) subagent id for `onOpenRecord`'s `agentId` param — `undefined` for the main thread. Same convention as `HeavyHitterRow.agentId`. */
  agentId: string | undefined;
  line: number;
  resultChars: number;
  resultCharsText: string;
  /** `undefined` when this one evidence entry's thread has no known/priced model — never a bare "$0". */
  estUsdText: string | undefined;
}

/**
 * Fix Queue card view-model (Bash lens, core section) — one per
 * `BashOpportunity`, already ranked by the core engine
 * (`computeBashOpportunities`, `@junrei/core`'s `bash-opportunities.ts`), so
 * `rank` is just this array's own index. `title`/`fixText` are rendered
 * VERBATIM from core — this builder only formats raw numeric fields
 * (occurrenceCount/totalChars/evidence chars) and derives the savings-figure
 * rendering rule; it never generates its own advice text.
 *
 * Savings-figure rule (reconciling the product brief with
 * `BashOpportunity`'s actual all-or-nothing typing — see
 * `bash-opportunities.ts`'s module doc comment): a real number renders
 * whenever `estUsdSaved` resolved AND `savingsBasis` isn't `"none"`
 * (`measured` renders plain, `heuristic` gets the info-glyph + tooltip via
 * `heuristicNote`); everything else — `savingsBasis === "none"` OR an
 * unpriced/unresolved `estUsdSaved` — renders the "candidate" chip instead
 * of a number, since there's nothing dollar-shaped to show.
 */
export interface OpportunityCardModel {
  key: string;
  rank: number;
  class: BashOpportunityJson["class"];
  lever: BashOpportunityJson["lever"];
  title: string;
  fixText: string;
  /** "~$0.42" or "candidate". */
  savingsText: string;
  savingsIsCandidate: boolean;
  /** Only true alongside a real (non-candidate) `savingsText` — drives the info-glyph + `heuristicNote` tooltip. */
  savingsIsHeuristic: boolean;
  heuristicNote: string | undefined;
  occurrenceCount: number;
  totalCharsText: string;
  threads: ThreadLabel[];
  evidence: OpportunityEvidenceRow[];
}

export function buildOpportunityCards(
  opportunities: readonly BashOpportunityJson[],
): OpportunityCardModel[] {
  return opportunities.map((o, i) => {
    const hasSavings = o.savingsBasis !== "none" && o.estUsdSaved !== undefined;
    return {
      key: `${o.class}-${i}`,
      rank: i + 1,
      class: o.class,
      lever: o.lever,
      title: o.title,
      fixText: o.fixText,
      savingsText: hasSavings ? formatEstUsd(o.estUsdSaved as number) : "candidate",
      savingsIsCandidate: !hasSavings,
      savingsIsHeuristic: hasSavings && o.savingsBasis === "heuristic",
      heuristicNote: o.heuristicNote,
      occurrenceCount: o.occurrenceCount,
      totalCharsText: formatTokens(o.totalChars),
      threads: o.threads.map(threadLabel),
      evidence: o.evidence.map((e) => ({
        key: `${e.thread}-${e.line}`,
        thread: threadLabel(e.thread),
        agentId: e.thread === "main" ? undefined : e.thread,
        line: e.line,
        resultChars: e.resultChars,
        resultCharsText: formatTokens(e.resultChars),
        estUsdText: e.estUsd !== undefined ? formatEstUsd(e.estUsd) : undefined,
      })),
    };
  });
}

/**
 * One rendered row of the Cost by command table (Bash lens, re-anchored on
 * money) — everything `CommandRankingTable.tsx` needs, precomputed so the
 * component is a pure map+render over this array. Carries both the
 * formatted `*Text` field (what renders) and, for every numeric column, the
 * raw value it was formatted from — sorting must compare real numbers,
 * never the display strings. `estUsd`/`usdSharePct` are `undefined` for a
 * command group with no priced model (never `0`) — `sortRows` already
 * places `undefined` values last regardless of sort direction, which is
 * exactly right for a money-anchored table (unpriced rows sink to the
 * bottom, they don't win a "cheapest first" ascending sort).
 */
export interface CommandRankingRow {
  key: string;
  label: string;
  sampleTitle: string | undefined;
  calls: number;
  errors: number;
  hasErrors: boolean;
  estUsd: number | undefined;
  estUsdText: string;
  /** This command's share of the SESSION's total $ — `undefined` whenever either this command's own `estUsd` or the session total is itself unknown. */
  usdSharePct: number | undefined;
  usdShareText: string;
  orchSharePct: number;
  orchShareText: string;
  estTokens: number;
  estTokensText: string;
  totalChars: number;
  totalCharsText: string;
  avgChars: number;
  avgCharsText: string;
  share: number;
  shareText: string;
}

export function buildCommandRankingRows(
  byCommand: readonly BashCommandGroupJson[],
  totals: BashStatsJson["totals"],
): CommandRankingRow[] {
  return byCommand.map((group) => {
    const usdSharePct =
      group.estUsd !== undefined && totals.estUsd !== undefined && totals.estUsd > 0
        ? Math.round((group.estUsd / totals.estUsd) * 1000) / 10
        : undefined;
    const orchSharePct = group.orchestratorSharePct ?? 0;
    return {
      key: `${group.family}-${group.subcommand ?? ""}`,
      label: commandLabel(group),
      sampleTitle: sampleCommandsTitle(group.sampleCommands),
      calls: group.calls,
      errors: group.errors,
      hasErrors: group.errors > 0,
      estUsd: group.estUsd,
      estUsdText: group.estUsd !== undefined ? formatEstUsd(group.estUsd) : "—",
      usdSharePct,
      usdShareText: usdSharePct !== undefined ? `${usdSharePct.toFixed(1)}%` : "—",
      orchSharePct,
      orchShareText: `${orchSharePct.toFixed(1)}%`,
      estTokens: group.estimatedTokens,
      estTokensText: formatEstimatedTokens(group.estimatedTokens),
      totalChars: group.totalResultChars,
      totalCharsText: formatTokens(group.totalResultChars),
      avgChars: group.avgResultChars,
      avgCharsText: formatTokens(group.avgResultChars),
      share: group.sharePct,
      shareText: `${group.sharePct.toFixed(1)}%`,
    };
  });
}

/** One rendered row of the Evidence section's heavy hitters table — see `HeavyHittersTable.tsx`. `line` stays on the row (not just baked into a formatted string) since the component's click handler needs the raw value to call `onOpenRecord`. */
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
  /** Raw result-chars count `resultCharsText` was formatted from — sorting compares this, never the formatted string (see this file's other row types for why). */
  resultChars: number;
  resultCharsText: string;
  /** `undefined` when this call's thread has no known/priced model, or its result is a placeholder — never a bare "$0". */
  estUsd: number | undefined;
  estUsdText: string;
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
    resultChars: hit.resultChars,
    resultCharsText: formatTokens(hit.resultChars),
    estUsd: hit.estUsd,
    estUsdText: hit.estUsd !== undefined ? formatEstUsd(hit.estUsd) : "—",
    line: hit.line,
  }));
}
