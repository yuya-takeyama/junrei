import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeCodexSession,
  analyzeSession,
  buildCodexSubagentForest,
  buildCodexTimeline,
  buildSessionData,
  buildTimeline,
  type CodexSessionAnalysis,
  type CodexSessionFileRef,
  type CodexTranscript,
  type FileAccessEntry,
  getCodexRecordDetail,
  getRecordDetail,
  listCodexSessionFiles,
  listSessionFiles,
  loadSubagentSessionData,
  type ModelUsageSummary,
  mergeCodexFileAccess,
  mergeUsageByModel,
  parseCodexTranscriptFile,
  parseTranscriptFile,
  type RecordDetail,
  resolveCodexHome,
  resolveProjectsDirs,
  type SessionAnalysis,
  type SessionData,
  type SessionFileRef,
  type SessionSource,
  type SubagentNode,
  subagentsDirFor,
  type TimelineEntry,
  type TokenTotals,
} from "@junrei/core";

/** Per-model output-token totals (main session + all subagents, recursively). */
export interface ModelMixEntry {
  model: string;
  outputTokens: number;
}

/**
 * Fields genuinely shared by both harnesses' list items. `projectDirName` and
 * `subagentCount` are deliberately NOT here — see `ClaudeSessionListItem` /
 * `CodexSessionListItem` below for why Codex still carries them (sentinel
 * values) rather than omitting them.
 */
interface SessionListItemBase {
  sessionId: string;
  cwd?: string;
  title?: string;
  firstUserPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  userTurnCount: number;
  models: string[];
  totalCostUsd: number;
  costIsComplete: boolean;
  totalTokens: number;
  cacheReadTokens: number;
  compactionCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  sizeBytes: number;
  /** Output-token share per model, main session + all subagents (for the L0 model-mix bar). */
  modelMix: ModelMixEntry[];
}

/**
 * `projectDirName` is conceptually Claude-only (Codex has no project-dir
 * munging), but @junrei/web's session-list UI reads it unconditionally
 * without narrowing on `source`. Rather than making it optional (which would
 * force `string | undefined` through `formatProject`/`sessionPath` call
 * sites the web package isn't touched to fix), `CodexSessionListItem` below
 * fills a sentinel value: `projectDirName: "codex"` (the same literal
 * segment the detail route uses, so it never collides with a real munged
 * Claude dir).
 *
 * `subagentCount` used to be a Codex sentinel (`0`, "no subagent concept")
 * but Codex sub-agent threads (see `@junrei/core`'s `codex/orchestration.ts`)
 * gave it a real meaning: the direct+recursive count of sub-agent threads
 * this session spawned. Sub-agent sessions themselves are excluded from the
 * list entirely (see `codexListItems`) — they surface inside their parent's
 * Orchestration lens instead, same as Claude subagent sidecars.
 */
export interface ClaudeSessionListItem extends SessionListItemBase {
  source: "claude-code";
  projectDirName: string;
  subagentCount: number;
}

export interface CodexSessionListItem extends SessionListItemBase {
  source: "codex";
  /** Sentinel — see the comment above `ClaudeSessionListItem`. */
  projectDirName: "codex";
  /** Direct+recursive count of sub-agent threads this session spawned — 0 for a session with none. */
  subagentCount: number;
  /** True when the rollout file lives under `archived_sessions/` rather than `sessions/YYYY/MM/DD/`. */
  archived: boolean;
}

/** Either harness's list item, discriminated on `source`. */
export type AnySessionListItem = ClaudeSessionListItem | CodexSessionListItem;

/** Back-compat alias — pre-Codex call sites imported this name directly. */
export type SessionListItem = AnySessionListItem;

/**
 * Aggregate output tokens per model across a main transcript's own usage and
 * every node in a subagent/sub-agent forest (recursively) — shared by both
 * harnesses' "model mix" computation (Claude's tree of sidecar subagents,
 * Codex's tree of sub-agent rollouts), since a `SubagentNode` forest has the
 * same shape either way (see `@junrei/core`'s `codex/orchestration.ts`).
 */
function mixFromUsageTree(
  ownByModel: readonly { model: string; outputTokens: number }[],
  forest: readonly SubagentNode[],
): ModelMixEntry[] {
  const totals = new Map<string, number>();
  const addUsage = (byModel: readonly { model: string; outputTokens: number }[]) => {
    for (const m of byModel) {
      totals.set(m.model, (totals.get(m.model) ?? 0) + m.outputTokens);
    }
  };
  addUsage(ownByModel);
  const visit = (nodes: readonly SubagentNode[]) => {
    for (const node of nodes) {
      addUsage(node.usage.byModel);
      visit(node.children);
    }
  };
  visit(forest);
  return [...totals].map(([model, outputTokens]) => ({ model, outputTokens }));
}

/**
 * Aggregate output tokens per model across the main transcript and every
 * subagent (recursively), so the session-list "model mix" bar reflects the
 * whole session, not just the top-level model.
 */
export function computeModelMix(analysis: SessionAnalysis): ModelMixEntry[] {
  return mixFromUsageTree(analysis.usage.byModel, analysis.subagents);
}

/** Same aggregation as `computeModelMix`, but over a Codex sub-agent forest — see `mixFromUsageTree`. */
function codexModelMix(
  analysis: CodexSessionAnalysis,
  forest: readonly SubagentNode[],
): ModelMixEntry[] {
  return mixFromUsageTree(analysis.usage.byModel, forest);
}

/** Recursive node count of a subagent/sub-agent forest — Codex's real `subagentCount`. */
function countForestNodes(nodes: readonly SubagentNode[]): number {
  let count = 0;
  const visit = (list: readonly SubagentNode[]) => {
    for (const node of list) {
      count += 1;
      visit(node.children);
    }
  };
  visit(nodes);
  return count;
}

/**
 * Sum every node's own token/cost totals across a subagent forest
 * (recursively) — the Codex analog of the `subagentTotals` accumulator
 * Claude's `analyzeSubagents` builds while walking sidecar transcripts.
 * `costIsComplete` is AND-ed across the whole tree: any node with unpriced
 * usage makes the aggregate incomplete too.
 */
function sumForestUsage(
  nodes: readonly SubagentNode[],
): TokenTotals & { costUsd: number; costIsComplete: boolean } {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let costUsd = 0;
  let costIsComplete = true;
  const visit = (list: readonly SubagentNode[]) => {
    for (const node of list) {
      total.inputTokens += node.usage.total.inputTokens;
      total.outputTokens += node.usage.total.outputTokens;
      total.cacheReadTokens += node.usage.total.cacheReadTokens;
      total.cacheCreationTokens += node.usage.total.cacheCreationTokens;
      costUsd += node.usage.total.costUsd;
      if (!node.usage.total.costIsComplete) costIsComplete = false;
      visit(node.children);
    }
  };
  visit(nodes);
  return { ...total, costUsd, costIsComplete };
}

/**
 * Recompute `totalUsage`/`totalUsageByModel` for a Codex session as "this
 * session's own usage + every sub-agent in its forest, recursively" — Claude
 * parity (`analyzeSession` already bakes the same rollup into
 * `ClaudeSessionAnalysis.totalUsage` at analysis time; Codex can't do that at
 * analysis time because a sub-agent's rollout is a wholly separate file the
 * single-session `analyzeCodexSession` never sees, so the rollup happens here
 * instead, at serve time, over the already-cached per-session analyses —
 * never mutating them). A forest-less session (`forest.length === 0`, the
 * common case) is just `analysis.usage.total`/`analysis.usage.byModel`
 * again — same values `analyzeCodexSession` already produced.
 */
function computeCodexForestTotals(
  analysis: CodexSessionAnalysis,
  forest: readonly SubagentNode[],
): {
  totalUsage: TokenTotals & { costUsd: number; costIsComplete: boolean };
  totalUsageByModel: ModelUsageSummary[];
} {
  const childSum = sumForestUsage(forest);
  const own = analysis.usage.total;
  return {
    totalUsage: {
      inputTokens: own.inputTokens + childSum.inputTokens,
      outputTokens: own.outputTokens + childSum.outputTokens,
      cacheReadTokens: own.cacheReadTokens + childSum.cacheReadTokens,
      cacheCreationTokens: own.cacheCreationTokens + childSum.cacheCreationTokens,
      costUsd: own.costUsd + childSum.costUsd,
      costIsComplete: own.costIsComplete && childSum.costIsComplete,
    },
    totalUsageByModel: mergeUsageByModel(analysis.usage.byModel, forest),
  };
}

/**
 * Every descendant sub-agent thread's own `fileAccess`, resolved from the
 * analyzed pool by `agentId` (== that thread's own `sessionId`) — feeds
 * `mergeCodexFileAccess` the same list-of-arrays shape Claude's
 * `analyzeSubagents` builds from sidecar transcripts (analyze.ts), just
 * walking the already-built `SubagentNode` forest instead: a Codex
 * sub-agent's `fileAccess` was already computed once at analysis time (see
 * `analyzeCodexSession`), so this only re-associates it, it never
 * re-parses anything.
 */
function collectForestFileAccess(
  nodes: readonly SubagentNode[],
  bySessionId: ReadonlyMap<string, CodexSessionAnalysis>,
): FileAccessEntry[][] {
  const out: FileAccessEntry[][] = [];
  const visit = (list: readonly SubagentNode[]) => {
    for (const node of list) {
      const analysis = bySessionId.get(node.agentId);
      if (analysis !== undefined) out.push(analysis.fileAccess);
      visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

interface CacheEntry {
  mtimeMs: number;
  analysis: SessionAnalysis;
}

const cache = new Map<string, CacheEntry>();

async function analyzeCached(ref: SessionFileRef): Promise<SessionAnalysis> {
  const hit = cache.get(ref.filePath);
  if (hit !== undefined && hit.mtimeMs === ref.mtimeMs) {
    return hit.analysis;
  }
  const analysis = await analyzeSession(ref.filePath);
  cache.set(ref.filePath, { mtimeMs: ref.mtimeMs, analysis });
  return analysis;
}

interface CodexCacheEntry {
  mtimeMs: number;
  /** `undefined` when the transcript isn't `format: "current"` — callers must skip it. */
  analysis: CodexSessionAnalysis | undefined;
}

const codexCache = new Map<string, CodexCacheEntry>();

/**
 * Analyze a Codex rollout file, cached by mtime like `analyzeCached` above
 * (separate map, keyed by the same `filePath`, so a Claude and a Codex
 * session never collide even in the unlikely case their file paths matched).
 * Returns `undefined` for legacy/empty-format transcripts, which callers
 * must skip rather than surface as a broken session.
 */
async function analyzeCodexCached(
  ref: CodexSessionFileRef,
): Promise<CodexSessionAnalysis | undefined> {
  const hit = codexCache.get(ref.filePath);
  if (hit !== undefined && hit.mtimeMs === ref.mtimeMs) {
    return hit.analysis;
  }
  const transcript = await parseCodexTranscriptFile(ref.filePath);
  const analysis =
    transcript.format === "current" ? analyzeCodexSession(ref, transcript) : undefined;
  codexCache.set(ref.filePath, { mtimeMs: ref.mtimeMs, analysis });
  return analysis;
}

function toListItem(analysis: SessionAnalysis, ref: SessionFileRef): ClaudeSessionListItem {
  const toolCallCount = analysis.toolStats.reduce((sum, s) => sum + s.callCount, 0);
  const toolErrorCount = analysis.toolStats.reduce((sum, s) => sum + s.errorCount, 0);
  return {
    source: "claude-code",
    sessionId: analysis.sessionId,
    projectDirName: analysis.projectDirName,
    userTurnCount: analysis.userTurnCount,
    models: analysis.models,
    totalCostUsd: analysis.totalUsage.costUsd,
    costIsComplete: analysis.totalUsage.costIsComplete,
    totalTokens:
      analysis.totalUsage.inputTokens +
      analysis.totalUsage.outputTokens +
      analysis.totalUsage.cacheReadTokens +
      analysis.totalUsage.cacheCreationTokens,
    cacheReadTokens: analysis.totalUsage.cacheReadTokens,
    subagentCount: analysis.subagentCount,
    compactionCount: analysis.compactions.length,
    toolCallCount,
    toolErrorCount,
    sizeBytes: ref.sizeBytes,
    modelMix: computeModelMix(analysis),
    ...(analysis.cwd !== undefined && { cwd: analysis.cwd }),
    ...(analysis.title !== undefined && { title: analysis.title }),
    ...(analysis.firstUserPrompt !== undefined && { firstUserPrompt: analysis.firstUserPrompt }),
    ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
    ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
    ...(analysis.durationMs !== undefined && { durationMs: analysis.durationMs }),
  };
}

/**
 * `forest` is this session's own sub-agent tree (built by the caller via
 * `buildCodexSubagentForest` against the full Codex analysis pool). Feeds
 * `subagentCount`, the `modelMix` bar, AND (Claude parity — see
 * `computeCodexForestTotals`) the list row's own cost/token figures, so a
 * parent's "Total cost" column in the session list already reflects what it
 * spent on delegation, the same way Claude's list rows do.
 */
function toCodexListItem(
  analysis: CodexSessionAnalysis,
  ref: CodexSessionFileRef,
  forest: readonly SubagentNode[],
): CodexSessionListItem {
  const { totalUsage } = computeCodexForestTotals(analysis, forest);
  return {
    source: "codex",
    sessionId: analysis.sessionId,
    projectDirName: "codex",
    subagentCount: countForestNodes(forest),
    archived: ref.archived,
    userTurnCount: analysis.userTurnCount,
    models: analysis.models,
    totalCostUsd: totalUsage.costUsd,
    costIsComplete: totalUsage.costIsComplete,
    totalTokens:
      totalUsage.inputTokens +
      totalUsage.outputTokens +
      totalUsage.cacheReadTokens +
      totalUsage.cacheCreationTokens,
    cacheReadTokens: totalUsage.cacheReadTokens,
    compactionCount: analysis.compactions.length,
    toolCallCount: analysis.codex.toolCallCount,
    toolErrorCount: analysis.codex.toolErrorCount,
    sizeBytes: ref.sizeBytes,
    modelMix: codexModelMix(analysis, forest),
    ...(analysis.cwd !== undefined && { cwd: analysis.cwd }),
    ...(analysis.title !== undefined && { title: analysis.title }),
    ...(analysis.firstUserPrompt !== undefined && { firstUserPrompt: analysis.firstUserPrompt }),
    ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
    ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
    ...(analysis.durationMs !== undefined && { durationMs: analysis.durationMs }),
  };
}

async function listClaudeRefs(): Promise<SessionFileRef[]> {
  const dirs = await resolveProjectsDirs();
  return listSessionFiles(dirs);
}

/**
 * List Codex rollout files. `resolveCodexHome` is called per-request (not
 * cached at module load) so tests can override `CODEX_HOME` via
 * `process.env` the same way `resolveProjectsDirs` picks up
 * `CLAUDE_CONFIG_DIR` per-request. A missing `~/.codex` yields `[]`, not an
 * error — `listCodexSessionFiles` already treats missing dirs as empty.
 */
async function listCodexRefs(): Promise<CodexSessionFileRef[]> {
  const refs = await listCodexSessionFiles(resolveCodexHome(process.env));
  // A real ~/.codex can hold both a live and an archived rollout for the same
  // conversation; keep one ref per session (live wins, then newest mtime) so
  // the list has no duplicate sessionIds and detail lookups are deterministic.
  const bySession = new Map<string, CodexSessionFileRef>();
  for (const ref of refs) {
    const existing = bySession.get(ref.sessionId);
    if (
      existing === undefined ||
      (existing.archived && !ref.archived) ||
      (existing.archived === ref.archived && ref.mtimeMs > existing.mtimeMs)
    ) {
      bySession.set(ref.sessionId, ref);
    }
  }
  return refs.filter((ref) => bySession.get(ref.sessionId) === ref);
}

async function claudeListItems(): Promise<{ item: ClaudeSessionListItem; mtimeMs: number }[]> {
  const refs = await listClaudeRefs();
  const out: { item: ClaudeSessionListItem; mtimeMs: number }[] = [];
  for (const ref of refs) {
    try {
      out.push({ item: toListItem(await analyzeCached(ref), ref), mtimeMs: ref.mtimeMs });
    } catch {
      // Unreadable session — skip rather than failing the whole list.
    }
  }
  return out;
}

interface CodexAnalyzedRef {
  ref: CodexSessionFileRef;
  analysis: CodexSessionAnalysis;
}

/**
 * Every readable, current-format Codex analysis on this machine — the pool
 * `buildCodexSubagentForest` needs to resolve a session's sub-agent tree
 * (a sub-agent's own rollout can be arbitrarily far from its ancestor's file
 * in mtime order, so building a forest for one session requires having
 * analyzed all of them first). Legacy/empty-format and unreadable files are
 * skipped, same as `codexListItems`/`getCodexSession` always did.
 */
async function listCodexAnalyzed(): Promise<CodexAnalyzedRef[]> {
  const refs = await listCodexRefs();
  const out: CodexAnalyzedRef[] = [];
  for (const ref of refs) {
    try {
      const analysis = await analyzeCodexCached(ref);
      if (analysis === undefined) continue; // legacy/empty format — not listable.
      out.push({ ref, analysis });
    } catch {
      // Unreadable session — skip rather than failing the whole list.
    }
  }
  return out;
}

/**
 * Sub-agent sessions (`codex.isSubagent`) are excluded from the list — they
 * surface inside their parent's Orchestration lens instead, same as Claude
 * subagent sidecars never appear in the top-level session list either. They
 * stay directly fetchable via `getCodexSession` (deep links still work).
 *
 * Exclusion requires an actually-resolvable parent: `review`/`compact`
 * sub-agent variants carry no parent id, and a `thread_spawn` parent's
 * rollout can be deleted — hiding those would silently drop the session
 * (and its cost) from every view, so they are listed like ordinary
 * sessions instead.
 */
async function codexListItems(): Promise<{ item: CodexSessionListItem; mtimeMs: number }[]> {
  const pool = await listCodexAnalyzed();
  const analyses = pool.map((p) => p.analysis);
  const poolIds = new Set(analyses.map((a) => a.sessionId));
  const out: { item: CodexSessionListItem; mtimeMs: number }[] = [];
  for (const { ref, analysis } of pool) {
    const parentId = analysis.codex.parentThreadId;
    const attachesToParent =
      analysis.codex.isSubagent && parentId !== undefined && poolIds.has(parentId);
    if (attachesToParent) continue;
    const forest = buildCodexSubagentForest(analyses, analysis.sessionId);
    out.push({ item: toCodexListItem(analysis, ref, forest), mtimeMs: ref.mtimeMs });
  }
  return out;
}

/** `"all"` merges both harnesses; omitted defaults to Claude-only. */
export type SessionSourceFilter = SessionSource | "all";

/**
 * List sessions for one or both harnesses, newest first (by file mtime —
 * both discovery functions already sort that way, and merging preserves it).
 * `"all"` merges both, applying `limit` once *after* the merge so the cutoff
 * reflects true recency across sources rather than truncating each source
 * independently. Omitted `source` stays Claude-only so pre-Codex clients
 * (notably the web UI until it grows source-aware routing) see unchanged
 * behavior; they must opt in with `"all"`.
 */
export async function listSessions(
  limit: number,
  source: SessionSourceFilter = "claude-code",
): Promise<AnySessionListItem[]> {
  if (source === "claude-code") {
    return (await claudeListItems())
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((r) => r.item);
  }
  if (source === "codex") {
    return (await codexListItems())
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((r) => r.item);
  }
  const [claude, codex] = await Promise.all([claudeListItems(), codexListItems()]);
  return [...claude, ...codex]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((r) => r.item);
}

async function findRef(
  projectDirName: string,
  sessionId: string,
): Promise<SessionFileRef | undefined> {
  const refs = await listClaudeRefs();
  return refs.find((r) => r.projectDirName === projectDirName && r.sessionId === sessionId);
}

export async function getSession(
  projectDirName: string,
  sessionId: string,
): Promise<SessionAnalysis | undefined> {
  const ref = await findRef(projectDirName, sessionId);
  if (ref === undefined) return undefined;
  try {
    return await analyzeCached(ref);
  } catch {
    return undefined;
  }
}

async function findCodexRef(sessionId: string): Promise<CodexSessionFileRef | undefined> {
  const refs = await listCodexRefs();
  return refs.find((r) => r.sessionId === sessionId);
}

/**
 * `CodexSessionAnalysis` plus its sub-agent tree — Claude parity: putting
 * `subagents`/`subagentCount` directly on the analysis mirrors
 * `ClaudeSessionAnalysis` (see `@junrei/core`'s `analyze.ts`), so the web's
 * Orchestration lens can consume either session type with the same field
 * names. `totalUsage`/`totalUsageByModel` are OVERRIDDEN from the base
 * `CodexSessionAnalysis` values (see `computeCodexForestTotals`) to include
 * every sub-agent recursively — the cached single-file analysis itself is
 * never mutated, this is a fresh object built at serve time. `fileAccess`
 * (+ its truncation flags) is OVERRIDDEN the same way, folding in every
 * descendant's own file access with the `subagent`/`both` `threads` marker —
 * see `mergeCodexFileAccess`/`collectForestFileAccess`. `skillInvocations`
 * is NOT overridden — main-transcript-only, same as Claude's.
 */
export interface CodexSessionAnalysisWithSubagents extends CodexSessionAnalysis {
  subagents: SubagentNode[];
  subagentCount: number;
}

/**
 * Codex session detail, by session id alone (Codex has no project-dir
 * concept to scope by). Returns `undefined` for an unknown id *or* a
 * legacy/empty-format transcript — both surface as a 404 in `app.ts`.
 *
 * Works for both a top-level (parent) session AND a sub-agent session
 * fetched directly by its own id (deep link) — either way, `subagents` is
 * built from whatever further sub-agent threads chain back to THIS id, so a
 * sub-agent that itself delegated further still shows its own children here.
 */
export async function getCodexSession(
  sessionId: string,
): Promise<CodexSessionAnalysisWithSubagents | undefined> {
  const pool = await listCodexAnalyzed();
  const found = pool.find((p) => p.analysis.sessionId === sessionId);
  if (found === undefined) return undefined;
  try {
    const forest = buildCodexSubagentForest(
      pool.map((p) => p.analysis),
      sessionId,
    );
    const { totalUsage, totalUsageByModel } = computeCodexForestTotals(found.analysis, forest);
    const bySessionId = new Map(pool.map((p) => [p.analysis.sessionId, p.analysis] as const));
    const { fileAccess, fileAccessTruncated, fileAccessOmittedCount } = mergeCodexFileAccess(
      found.analysis.fileAccess,
      collectForestFileAccess(forest, bySessionId),
    );
    return {
      ...found.analysis,
      totalUsage,
      totalUsageByModel,
      subagents: forest,
      subagentCount: countForestNodes(forest),
      fileAccess,
      fileAccessTruncated,
      ...(fileAccessOmittedCount !== undefined && { fileAccessOmittedCount }),
    };
  } catch {
    return undefined;
  }
}

interface CodexTranscriptCacheEntry {
  mtimeMs: number;
  transcript: CodexTranscript;
}

const codexTranscriptCache = new Map<string, CodexTranscriptCacheEntry>();

/**
 * Parsed (but not analyzed) Codex transcript, cached by mtime — the Codex
 * analog of `sessionDataCached` below. A separate cache from `codexCache`
 * above (which stores the already-*analyzed* `CodexSessionAnalysis`) because
 * the Timeline/record-detail routes need the raw parsed records, not the
 * session-level rollup; both caches are keyed by `filePath` so a session's
 * `analyzeCodexCached` and `codexTranscriptCached` entries never collide.
 */
async function codexTranscriptCached(ref: CodexSessionFileRef): Promise<CodexTranscript> {
  const hit = codexTranscriptCache.get(ref.filePath);
  if (hit !== undefined && hit.mtimeMs === ref.mtimeMs) return hit.transcript;
  const transcript = await parseCodexTranscriptFile(ref.filePath);
  codexTranscriptCache.set(ref.filePath, { mtimeMs: ref.mtimeMs, transcript });
  return transcript;
}

/**
 * Full-transcript timeline for the Timeline lens (L2), scoped to a Codex
 * session — no `agentId` param (Codex has no subagent tree to scope into).
 * `undefined` for an unknown id or a legacy/empty-format transcript, same
 * 404 semantics as `getCodexSession`.
 */
export async function getCodexTimeline(sessionId: string): Promise<TimelineEntry[] | undefined> {
  const ref = await findCodexRef(sessionId);
  if (ref === undefined) return undefined;
  try {
    const transcript = await codexTranscriptCached(ref);
    if (transcript.format !== "current") return undefined;
    return buildCodexTimeline(transcript);
  } catch {
    return undefined;
  }
}

/** Full detail for one source line in a Codex transcript — for the Record detail (L3) slide-over. */
export async function getCodexSessionRecordDetail(
  sessionId: string,
  line: number,
): Promise<RecordDetail | undefined> {
  const ref = await findCodexRef(sessionId);
  if (ref === undefined) return undefined;
  try {
    const transcript = await codexTranscriptCached(ref);
    if (transcript.format !== "current") return undefined;
    return getCodexRecordDetail(transcript, line);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a subagent's own sidecar transcript as a synthetic `SessionFileRef`
 * (`sessionId` set to the agentId, `filePath` the sidecar jsonl) so it can
 * flow through the same `analyzeCached` cache as main sessions — keyed by
 * `filePath`, which is unique per sidecar, so no separate cache is needed.
 * `undefined` when the main session or the sidecar file doesn't exist.
 */
async function findAgentRef(
  projectDirName: string,
  sessionId: string,
  agentId: string,
): Promise<SessionFileRef | undefined> {
  const mainRef = await findRef(projectDirName, sessionId);
  if (mainRef === undefined) return undefined;
  const filePath = join(subagentsDirFor(mainRef.filePath), `agent-${agentId}.jsonl`);
  try {
    const stats = await stat(filePath);
    return {
      sessionId: agentId,
      filePath,
      projectDirName,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  } catch {
    return undefined;
  }
}

/**
 * Analysis for one subagent's own transcript, scoped exactly like
 * `getSession` but for a sidecar — same `SessionAnalysis` shape, reused
 * as-is by the web's agent-detail shell (deliberate: no separate DTO).
 */
export async function getAgentSession(
  projectDirName: string,
  sessionId: string,
  agentId: string,
): Promise<SessionAnalysis | undefined> {
  const ref = await findAgentRef(projectDirName, sessionId, agentId);
  if (ref === undefined) return undefined;
  try {
    return await analyzeCached(ref);
  } catch {
    return undefined;
  }
}

interface SessionDataCacheEntry {
  mtimeMs: number;
  data: SessionData;
}

const sessionDataCache = new Map<string, SessionDataCacheEntry>();

/** Parsed + structured (but not analyzed) main-session data, cached by mtime. */
async function sessionDataCached(ref: SessionFileRef): Promise<SessionData> {
  const hit = sessionDataCache.get(ref.filePath);
  if (hit !== undefined && hit.mtimeMs === ref.mtimeMs) return hit.data;
  const transcript = await parseTranscriptFile(ref.filePath);
  const data = buildSessionData(transcript);
  sessionDataCache.set(ref.filePath, { mtimeMs: ref.mtimeMs, data });
  return data;
}

/**
 * Resolve which transcript to read for a timeline/record request: the main
 * session, or — when `agentId` is given — that subagent's own sidecar
 * transcript (which lives alongside the main session file regardless of
 * nesting depth).
 */
async function resolveThreadData(
  ref: SessionFileRef,
  agentId: string | undefined,
): Promise<SessionData | undefined> {
  if (agentId === undefined) return sessionDataCached(ref);
  return loadSubagentSessionData(ref.filePath, agentId);
}

/** Full-transcript timeline for the Timeline lens (L2). `agentId` scopes it to one subagent. */
export async function getTimeline(
  projectDirName: string,
  sessionId: string,
  agentId?: string,
): Promise<TimelineEntry[] | undefined> {
  const ref = await findRef(projectDirName, sessionId);
  if (ref === undefined) return undefined;
  try {
    const data = await resolveThreadData(ref, agentId);
    if (data === undefined) return undefined;
    return await buildTimeline(data, { mainFilePath: ref.filePath });
  } catch {
    return undefined;
  }
}

/** Full detail for one source line — for the Record detail (L3) slide-over. */
export async function getSessionRecordDetail(
  projectDirName: string,
  sessionId: string,
  line: number,
  agentId?: string,
): Promise<RecordDetail | undefined> {
  const ref = await findRef(projectDirName, sessionId);
  if (ref === undefined) return undefined;
  try {
    const data = await resolveThreadData(ref, agentId);
    if (data === undefined) return undefined;
    return await getRecordDetail(data, line, { mainFilePath: ref.filePath });
  } catch {
    return undefined;
  }
}
