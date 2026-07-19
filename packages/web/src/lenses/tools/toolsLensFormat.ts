import type { ToolUsageStatsJson } from "../../api.js";
import { formatTokens } from "../../format.js";
import { modelShortLabel } from "../../modelClass.js";
import { formatEstUsd, type ThreadLabel, threadLabel } from "../bash/bashLensFormat.js";

/**
 * View-model builders for the Tools lens's "All" sub-tab (`AllView.tsx`),
 * modeled on `bash/bashLensFormat.ts` — every one is a pure function over
 * `SessionAnalysisCore.toolUsageStats` (the `ToolUsageStatsJson` the server
 * inlines into a session response), so the React components stay thin and the
 * derivations (decision strip, tool ranking, source split, error matrix,
 * heavy hitters) are unit-testable without rendering JSX.
 *
 * No analysis logic lives here beyond plain presentation math (shares,
 * roll-ups, category tallies): every dollar/token figure is already an
 * estimate carried on `toolUsageStats` (chars/4 × model input price — see the
 * core engine), so every one gets the `~`/"(est)" treatment `formatEstUsd`
 * already applies, never a bare figure, and an unknown price stays a muted
 * "—" rather than a fabricated "$0".
 */

export type ToolGroupJson = ToolUsageStatsJson["byTool"][number];
export type ToolHeavyHitterJson = ToolUsageStatsJson["heavyHitters"][number];
export type ToolTotalsJson = ToolUsageStatsJson["totals"];

/** Whether the session recorded any tool calls at all — the All sub-tab's single empty-state gate. */
export function hasToolActivity(totals: ToolTotalsJson): boolean {
  return totals.calls > 0;
}

/** An MCP tool's raw wire name is `mcp__<server>__<tool>` — this is the one place that identifies one for the `mcp` badge / source split. */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/** `mcp__junrei__get_bash_stats` → `junrei` (the server segment) — used only to COUNT distinct MCP servers for the source-split legend. `undefined` for a non-MCP name. */
function mcpServerOf(name: string): string | undefined {
  if (!isMcpTool(name)) return undefined;
  const rest = name.slice("mcp__".length);
  const server = rest.split("__")[0];
  return server === undefined || server === "" ? undefined : server;
}

function pctText(pct: number): string {
  return `${Math.round(pct)}%`;
}

/** Normalize a share to the largest share in the table so the top row's bar fills the track and the rest read relative to it — the mockup's `.shfill` width convention. */
function barWidthPct(share: number, maxShare: number): number {
  return maxShare > 0 ? Math.round((share / maxShare) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Decision strip — 4 pure data statements (no judgment language)
// ---------------------------------------------------------------------------

export interface DecisionCard {
  label: string;
  /** Headline value, rendered `.big`. */
  value: string;
  /** Amber accent for the headline (the tool name in the cost/error cards). */
  valueAccent?: string;
  /** Muted qualifier next to the headline. */
  valueSub?: string;
  /** Meter fill 0–100, or `undefined` to omit the meter. */
  meterPct?: number;
  /** Muted meter fill (orchestrator card) vs. the default amber. */
  meterMuted?: boolean;
  /** One or two muted sub-lines beneath the meter. */
  subLines: string[];
}

export interface DecisionStripModel {
  costConcentration: DecisionCard;
  errorConcentration: DecisionCard;
  largestResult: DecisionCard;
  orchestratorShare: DecisionCard;
}

/** Tool with the most errors (byTool is $-sorted, so scan for the error max) — `undefined` when nothing errored. */
function topErrorTool(byTool: readonly ToolGroupJson[]): ToolGroupJson | undefined {
  let top: ToolGroupJson | undefined;
  for (const t of byTool) {
    if (t.errors > 0 && (top === undefined || t.errors > top.errors)) top = t;
  }
  return top;
}

/** Overall orchestrator (main-thread) share of tool result chars, derived from each tool's own `orchestratorSharePct` weighted by its chars — equals the main thread's char share, computed without a `byThread` pass. */
function overallOrchestratorPct(byTool: readonly ToolGroupJson[], totalChars: number): number {
  if (totalChars <= 0) return 0;
  let orchChars = 0;
  for (const t of byTool) orchChars += (t.resultChars * (t.orchestratorSharePct ?? 0)) / 100;
  return (orchChars / totalChars) * 100;
}

export function buildDecisionStrip(stats: ToolUsageStatsJson): DecisionStripModel {
  const { totals, byTool, byThread, heavyHitters } = stats;
  const priced = totals.estUsd !== undefined;

  // 1. Cost concentration — the top tool (byTool[0], already $-sorted).
  const top = byTool[0];
  const costConcentration: DecisionCard =
    top === undefined
      ? { label: "Cost concentration", value: "—", subLines: ["no tool calls recorded"] }
      : (() => {
          const usdShare =
            priced && top.estUsd !== undefined && (totals.estUsd as number) > 0
              ? (top.estUsd / (totals.estUsd as number)) * 100
              : undefined;
          const meterPct = usdShare ?? top.sharePct;
          const headSub =
            top.estUsd !== undefined
              ? `${formatEstUsd(top.estUsd)} (est)`
              : `${formatTokens(top.resultChars)} chars`;
          const shareLine =
            usdShare !== undefined
              ? `${pctText(usdShare)} of tool $ (est) · ${top.calls.toLocaleString()} calls`
              : `${pctText(top.sharePct)} of tool output · ${top.calls.toLocaleString()} calls`;
          return {
            label: "Cost concentration",
            value: top.name,
            valueAccent: top.name,
            valueSub: headSub,
            meterPct,
            subLines: [shareLine],
          };
        })();

  // 2. Error concentration — the tool carrying the most errors.
  const errTool = topErrorTool(byTool);
  const errorConcentration: DecisionCard =
    errTool === undefined || totals.errors === 0
      ? {
          label: "Error concentration",
          value: `0 / ${totals.errors}`,
          meterPct: 0,
          subLines: ["no tool errors recorded"],
        }
      : (() => {
          const share = (errTool.errors / totals.errors) * 100;
          return {
            label: "Error concentration",
            value: `${errTool.errors} / ${totals.errors}`,
            valueSub: errTool.name,
            meterPct: share,
            subLines: [`${errTool.name} · ${pctText(share)} of tool errors`],
          };
        })();

  // 3. Largest single result — the top heavy hitter across every tool/thread.
  const hh = heavyHitters[0];
  const largestResult: DecisionCard =
    hh === undefined
      ? { label: "Largest single result", value: "—", subLines: ["no tool results recorded"] }
      : (() => {
          const tokPart = `~${formatTokens(hh.estimatedTokens)} tok`;
          const usdPart = hh.estUsd !== undefined ? ` · ${formatEstUsd(hh.estUsd)}` : "";
          const model = hh.model !== undefined ? ` (${modelShortLabel(hh.model)})` : "";
          return {
            label: "Largest single result",
            value: formatTokens(hh.resultChars),
            valueSub: `chars · ${tokPart}${usdPart}`,
            subLines: [`${hh.tool} · thread ${threadLabel(hh.thread).text}${model}`],
          };
        })();

  // 4. Orchestrator share — how much tool output landed in main vs. subagents.
  const orchPct = overallOrchestratorPct(byTool, totals.resultChars);
  const main = byThread.find((t) => t.thread === "main");
  const subagentThreads = byThread.filter((t) => t.thread !== "main").length;
  const mainUsdPct = main?.usdSharePct;
  const orchLine =
    subagentThreads > 0
      ? `${pctText(100 - orchPct)} lands across ${subagentThreads} subagent${subagentThreads === 1 ? "" : "s"}${
          mainUsdPct !== undefined ? ` · main pays ${pctText(mainUsdPct)} of tool $` : ""
        }`
      : "single thread · all tool output in main";
  const orchestratorShare: DecisionCard = {
    label: "Orchestrator share",
    value: `~${pctText(orchPct)}`,
    valueSub: "(est) of tool chars in main",
    meterPct: orchPct,
    meterMuted: true,
    subLines: [orchLine],
  };

  return { costConcentration, errorConcentration, largestResult, orchestratorShare };
}

// ---------------------------------------------------------------------------
// Tool usage ranking table
// ---------------------------------------------------------------------------

export interface ToolRankingRow {
  key: string;
  name: string;
  isMcp: boolean;
  /** The Bash row carries a "drill down →" link to the Bash sub-tab. */
  isBash: boolean;
  /** The trailing "+N more tools" roll-up row (muted). */
  isRollup: boolean;
  /** The bottom Totals row. */
  isTotals: boolean;
  /** "(Read, Grep, …)" sample names for the roll-up row. */
  rollupNames?: string;
  calls: number;
  errors: number;
  hasErrors: boolean;
  estUsdText: string;
  /** Actual $ (or char, when unpriced) share — the `.shpct` number. */
  sharePct: number;
  shareText: string;
  /** Bar fill, normalized to the largest share (`.shfill` width). */
  barPct: number;
  /** Bar renders muted for the roll-up row. */
  barMuted: boolean;
  orchShareText: string;
  charsText: string;
}

export interface ToolRankingModel {
  rows: ToolRankingRow[];
  totals: ToolRankingRow;
  toolCount: number;
}

const TOP_TOOLS = 8;

/** Whole-session $ share of one tool, or its char share when nothing in the session priced — the value the `$ share` column shows and the bar scales. */
function toolShare(tool: ToolGroupJson, totals: ToolTotalsJson, priced: boolean): number {
  if (priced && tool.estUsd !== undefined && (totals.estUsd as number) > 0) {
    return (tool.estUsd / (totals.estUsd as number)) * 100;
  }
  return tool.sharePct;
}

export function buildToolRanking(stats: ToolUsageStatsJson): ToolRankingModel {
  const { totals, byTool } = stats;
  const priced = totals.estUsd !== undefined;
  const shares = byTool.map((t) => toolShare(t, totals, priced));
  const maxShare = shares.reduce((m, s) => Math.max(m, s), 0);

  const shown = byTool.slice(0, TOP_TOOLS);
  const rest = byTool.slice(TOP_TOOLS);

  const rows: ToolRankingRow[] = shown.map((t, i) => {
    const share = shares[i] as number;
    return {
      key: t.name,
      name: t.name,
      isMcp: isMcpTool(t.name),
      isBash: t.name === "Bash",
      isRollup: false,
      isTotals: false,
      calls: t.calls,
      errors: t.errors,
      hasErrors: t.errors > 0,
      estUsdText: t.estUsd !== undefined ? formatEstUsd(t.estUsd) : "—",
      sharePct: share,
      shareText: pctText(share),
      barPct: barWidthPct(share, maxShare),
      barMuted: false,
      orchShareText: pctText(t.orchestratorSharePct ?? 0),
      charsText: formatTokens(t.resultChars),
    };
  });

  if (rest.length > 0) {
    let calls = 0;
    let errors = 0;
    let resultChars = 0;
    let estUsd = 0;
    let estUsdKnown = false;
    for (const t of rest) {
      calls += t.calls;
      errors += t.errors;
      resultChars += t.resultChars;
      if (t.estUsd !== undefined) {
        estUsd += t.estUsd;
        estUsdKnown = true;
      }
    }
    const rollupShare =
      priced && estUsdKnown && (totals.estUsd as number) > 0
        ? (estUsd / (totals.estUsd as number)) * 100
        : totals.resultChars > 0
          ? (resultChars / totals.resultChars) * 100
          : 0;
    const sampleNames = rest.slice(0, 2).map((t) => t.name);
    rows.push({
      key: "__rollup__",
      name: `+ ${rest.length} more tools`,
      isMcp: false,
      isBash: false,
      isRollup: true,
      isTotals: false,
      rollupNames:
        rest.length > 2 ? `(${sampleNames.join(", ")}, …)` : `(${sampleNames.join(", ")})`,
      calls,
      errors,
      hasErrors: false,
      estUsdText: estUsdKnown ? formatEstUsd(estUsd) : "—",
      sharePct: rollupShare,
      shareText: pctText(rollupShare),
      barPct: barWidthPct(rollupShare, maxShare),
      barMuted: true,
      orchShareText: "—",
      charsText: formatTokens(resultChars),
    });
  }

  const totalsRow: ToolRankingRow = {
    key: "__totals__",
    name: `Totals · ${byTool.length} tool${byTool.length === 1 ? "" : "s"}`,
    isMcp: false,
    isBash: false,
    isRollup: false,
    isTotals: true,
    calls: totals.calls,
    errors: totals.errors,
    hasErrors: totals.errors > 0,
    estUsdText: totals.estUsd !== undefined ? formatEstUsd(totals.estUsd) : "—",
    sharePct: 100,
    shareText: "100%",
    barPct: 100,
    barMuted: false,
    orchShareText: pctText(overallOrchestratorPct(byTool, totals.resultChars)),
    charsText: formatTokens(totals.resultChars),
  };

  return { rows, totals: totalsRow, toolCount: byTool.length };
}

// ---------------------------------------------------------------------------
// Source split — built-in vs MCP
// ---------------------------------------------------------------------------

export interface SourceSplitSegment {
  toolCount: number;
  calls: number;
  estUsd: number | undefined;
  resultChars: number;
  /** Width 0–100 of this segment's bar (by est $, or chars when unpriced). */
  widthPct: number;
  /** "Built-in · 13 tools · 2,329 calls · ~$1.88 · 98.9%". */
  legend: string;
}

export interface SourceSplitModel {
  /** `undefined` when the session called no built-in tools (e.g. an MCP-only session). */
  builtIn: SourceSplitSegment | undefined;
  /** `undefined` when the session called no MCP tools. */
  mcp: SourceSplitSegment | undefined;
}

interface SplitAccum {
  toolCount: number;
  calls: number;
  resultChars: number;
  estUsd: number;
  estUsdKnown: boolean;
  servers: Set<string>;
}

function emptyAccum(): SplitAccum {
  return {
    toolCount: 0,
    calls: 0,
    resultChars: 0,
    estUsd: 0,
    estUsdKnown: false,
    servers: new Set(),
  };
}

export function buildSourceSplit(stats: ToolUsageStatsJson): SourceSplitModel {
  const builtInAcc = emptyAccum();
  const mcpAcc = emptyAccum();
  for (const t of stats.byTool) {
    const acc = isMcpTool(t.name) ? mcpAcc : builtInAcc;
    acc.toolCount += 1;
    acc.calls += t.calls;
    acc.resultChars += t.resultChars;
    if (t.estUsd !== undefined) {
      acc.estUsd += t.estUsd;
      acc.estUsdKnown = true;
    }
    const server = mcpServerOf(t.name);
    if (server !== undefined) acc.servers.add(server);
  }

  const priced = builtInAcc.estUsdKnown || mcpAcc.estUsdKnown;
  const denom = priced
    ? builtInAcc.estUsd + mcpAcc.estUsd
    : builtInAcc.resultChars + mcpAcc.resultChars;
  const widthOf = (acc: SplitAccum): number => {
    if (denom <= 0) return 0;
    const num = priced ? acc.estUsd : acc.resultChars;
    return Math.round((num / denom) * 1000) / 10;
  };

  const legendOf = (acc: SplitAccum, kind: "builtin" | "mcp"): string => {
    const head =
      kind === "builtin"
        ? `Built-in · ${acc.toolCount} tool${acc.toolCount === 1 ? "" : "s"}`
        : `MCP (mcp__*) · ${acc.servers.size} server${acc.servers.size === 1 ? "" : "s"}`;
    const usd = acc.estUsdKnown ? formatEstUsd(acc.estUsd) : "—";
    return `${head} · ${acc.calls.toLocaleString()} calls · ${usd} · ${widthOf(acc).toFixed(1)}%`;
  };

  const builtIn: SourceSplitSegment | undefined =
    builtInAcc.toolCount === 0
      ? undefined
      : {
          toolCount: builtInAcc.toolCount,
          calls: builtInAcc.calls,
          estUsd: builtInAcc.estUsdKnown ? builtInAcc.estUsd : undefined,
          resultChars: builtInAcc.resultChars,
          widthPct: widthOf(builtInAcc),
          legend: legendOf(builtInAcc, "builtin"),
        };
  const mcp: SourceSplitSegment | undefined =
    mcpAcc.toolCount === 0
      ? undefined
      : {
          toolCount: mcpAcc.toolCount,
          calls: mcpAcc.calls,
          estUsd: mcpAcc.estUsdKnown ? mcpAcc.estUsd : undefined,
          resultChars: mcpAcc.resultChars,
          widthPct: widthOf(mcpAcc),
          legend: legendOf(mcpAcc, "mcp"),
        };

  return { builtIn, mcp };
}

// ---------------------------------------------------------------------------
// Errors by tool × category matrix
// ---------------------------------------------------------------------------

/** Canonical column order + two-line display label per category — mirrors the mockup's header cells; only categories that actually appear render as columns. */
const ERROR_CATEGORY_LABELS: readonly { key: string; lines: [string, string] }[] = [
  { key: "command-failed", lines: ["command", "failed"] },
  { key: "string-not-found", lines: ["string", "not-found"] },
  { key: "file-not-found", lines: ["file", "not-found"] },
  { key: "permission-denied", lines: ["permission", "denied"] },
  { key: "interrupted", lines: ["inter-", "rupted"] },
  { key: "timeout", lines: ["time-", "out"] },
  { key: "other", lines: ["other", ""] },
];

export interface ErrorMatrixColumn {
  key: string;
  lines: [string, string];
}

export interface ErrorMatrixRow {
  name: string;
  isMcp: boolean;
  /** Per-column counts, aligned to `columns` order (0 for absent). */
  counts: number[];
  total: number;
}

export interface ErrorMatrixModel {
  columns: ErrorMatrixColumn[];
  rows: ErrorMatrixRow[];
  /** Column-wise totals, aligned to `columns`. */
  columnTotals: number[];
  grandTotal: number;
}

/** `undefined` when the session recorded no tool errors — the section is hidden entirely. */
export function buildErrorMatrix(stats: ToolUsageStatsJson): ErrorMatrixModel | undefined {
  const erroring = stats.byTool.filter((t) => t.errors > 0);
  if (erroring.length === 0) return undefined;

  const present = new Set<string>();
  for (const t of erroring) {
    for (const [cat, count] of Object.entries(t.errorCategories)) {
      if ((count ?? 0) > 0) present.add(cat);
    }
  }
  const columns = ERROR_CATEGORY_LABELS.filter((c) => present.has(c.key));

  const rows: ErrorMatrixRow[] = erroring
    .map((t) => ({
      name: t.name,
      isMcp: isMcpTool(t.name),
      counts: columns.map((c) => (t.errorCategories as Record<string, number>)[c.key] ?? 0),
      total: t.errors,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const columnTotals = columns.map((_, i) => rows.reduce((sum, r) => sum + (r.counts[i] ?? 0), 0));
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  return { columns, rows, columnTotals, grandTotal };
}

// ---------------------------------------------------------------------------
// Heavy hitters — top single results across all tools
// ---------------------------------------------------------------------------

export interface ToolHeavyHitterRow {
  key: string;
  rank: number;
  tool: string;
  thread: ThreadLabel;
  /** Owning thread's model, for the row's dot accent — `undefined` when unknown. */
  model: string | undefined;
  /** Raw (untruncated) subagent id for `onOpenRecord`, `undefined` for main. */
  agentId: string | undefined;
  resultCharsText: string;
  estUsdText: string;
  line: number;
}

export function buildToolHeavyHitterRows(
  heavyHitters: readonly ToolHeavyHitterJson[],
): ToolHeavyHitterRow[] {
  return heavyHitters.map((hit, i) => ({
    key: hit.id,
    rank: i + 1,
    tool: hit.tool,
    thread: threadLabel(hit.thread),
    model: hit.model,
    agentId: hit.thread === "main" ? undefined : hit.thread,
    resultCharsText: formatTokens(hit.resultChars),
    estUsdText: hit.estUsd !== undefined ? formatEstUsd(hit.estUsd) : "—",
    line: hit.line,
  }));
}

/** Sub-nav cost hint next to the "Bash" sub-tab — the Bash context $ (or est-token) figure, `~`-prefixed. `undefined` when there's nothing priced/no Bash calls. */
export function bashSubTabCostHint(bashTotals: {
  calls: number;
  estUsd?: number | undefined;
}): string | undefined {
  if (bashTotals.calls === 0) return undefined;
  return bashTotals.estUsd !== undefined ? formatEstUsd(bashTotals.estUsd) : undefined;
}
