import {
  analyzeCodexSession,
  buildCodexSubagentForest,
  buildCodexTimeline,
  type CodexSessionAnalysis,
  type CodexSessionFileRef,
  type CodexTranscript,
  computeDelegationSummary,
  type FileAccessEntry,
  getCodexRecordDetail,
  listCodexSessionFiles,
  loadCodexSessionIndexTitles,
  type ModelUsageSummary,
  mergeCodexFileAccess,
  mergeUsageByModel,
  parseCodexTranscriptFile,
  type RecordDetail,
  resolveCodexHome,
  type SubagentNode,
  type TimelineEntry,
  type TokenTotals,
} from "@junrei/core";
import {
  type ModelMixEntry,
  mixFromUsageTree,
  type SessionListBounds,
  type SessionListItemBase,
  type SourceAdapter,
  sliceDelegation,
  sliceUsageByModel,
} from "./shared.js";

/** Key identifying one Codex session — Codex has no project-dir concept, so the session id alone suffices. */
export interface CodexSessionKey {
  id: string;
}

/**
 * `projectDirName` (Claude-only, no Codex equivalent — see `sources/claude.ts`)
 * used to be faked here with a sentinel `"codex"` value so the web's
 * session-list UI could read it unconditionally. That sentinel is gone (see
 * `packages/web/src/sourceCaps.ts` / `sessionListHelpers.ts` for how the web
 * now branches on `source` explicitly instead).
 *
 * `subagentCount` used to be a Codex sentinel (`0`, "no subagent concept")
 * but Codex sub-agent threads (see `@junrei/core`'s `codex/orchestration.ts`)
 * gave it a real meaning: the direct+recursive count of sub-agent threads
 * this session spawned. Sub-agent sessions themselves are excluded from the
 * list entirely (see `codexListItems`) — they surface inside their parent's
 * Orchestration lens instead, same as Claude subagent sidecars.
 */
export interface CodexSessionListItem extends SessionListItemBase {
  source: "codex";
  /** Direct+recursive count of sub-agent threads this session spawned — 0 for a session with none. */
  subagentCount: number;
  /** True when the rollout file lives under `archived_sessions/` rather than `sessions/YYYY/MM/DD/`. */
  archived: boolean;
  /**
   * Normalized git remote URL from the rollout's `session_meta.git` (see
   * `@junrei/core`'s `normalizeRepoUrl`). For a Codex-worktree session whose
   * URL no local checkout anchors to a `repoRoot` (see `resolveCodexRepoRoot`),
   * this is the repo-grouping fallback — `repoKeyOf` (overview.ts) and the
   * web's `repoFilterKey` bucket it as `codex-repo:<repoUrl>`.
   */
  repoUrl?: string;
}

/** Same aggregation as Claude's `computeModelMix`, but over a Codex sub-agent forest — see `mixFromUsageTree`. */
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
 * parity (`analyzeClaudeSession` already bakes the same rollup into
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

/**
 * Codex Desktop runs each task in a worktree under
 * `$CODEX_HOME/worktrees/<hash>/<repoName>` — a path that carries no trace of
 * where the parent repo actually lives, so `deriveRepoIdentity` (core) can't
 * give those sessions a `repoRoot` and, ungrouped, one repo splinters into a
 * repo-dropdown entry per worktree hash. What every Codex session DOES carry
 * is `session_meta.git.repository_url`; this map recovers a `repoRoot` for
 * the worktree sessions from it, anchored by the sessions that ran at the
 * repo's real path (which have both a `repoRoot` and the same URL). When one
 * URL anchors to several roots — a session run in a subdirectory of the repo
 * claims that subdir as its `repoRoot`, and a throwaway clone (observed on
 * real data: a `/private/tmp/<repo>-review-<sha>` checkout) claims its own
 * path — the root with the MOST anchoring sessions wins: the repo's usual
 * checkout dwarfs one-off clones and occasional subdir runs. Ties break to
 * the shortest path (a repo root is shorter than its own subdirs), then
 * lexicographic, for determinism.
 */
function buildRepoRootByUrl(analyses: readonly CodexSessionAnalysis[]): Map<string, string> {
  const countsByUrl = new Map<string, Map<string, number>>();
  for (const a of analyses) {
    if (a.repoRoot === undefined || a.gitRepositoryUrl === undefined) continue;
    let perRoot = countsByUrl.get(a.gitRepositoryUrl);
    if (perRoot === undefined) {
      perRoot = new Map();
      countsByUrl.set(a.gitRepositoryUrl, perRoot);
    }
    perRoot.set(a.repoRoot, (perRoot.get(a.repoRoot) ?? 0) + 1);
  }
  const map = new Map<string, string>();
  for (const [url, perRoot] of countsByUrl) {
    let best: string | undefined;
    let bestCount = 0;
    for (const [root, count] of perRoot) {
      const wins =
        best === undefined ||
        count > bestCount ||
        (count === bestCount &&
          (root.length < best.length || (root.length === best.length && root < best)));
      if (wins) {
        best = root;
        bestCount = count;
      }
    }
    if (best !== undefined) map.set(url, best);
  }
  return map;
}

/** This analysis's own `repoRoot`, or the one its repository URL anchors to (see `buildRepoRootByUrl`). */
function resolveCodexRepoRoot(
  analysis: CodexSessionAnalysis,
  repoRootByUrl: ReadonlyMap<string, string>,
): string | undefined {
  if (analysis.repoRoot !== undefined) return analysis.repoRoot;
  return analysis.gitRepositoryUrl === undefined
    ? undefined
    : repoRootByUrl.get(analysis.gitRepositoryUrl);
}

interface CodexCacheEntry {
  mtimeMs: number;
  /** `undefined` when the transcript isn't `format: "current"` — callers must skip it. */
  analysis: CodexSessionAnalysis | undefined;
}

const codexCache = new Map<string, CodexCacheEntry>();

/**
 * Analyze a Codex rollout file, cached by mtime like Claude's `analyzeCached`
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
  repoRootByUrl: ReadonlyMap<string, string>,
): CodexSessionListItem {
  const { totalUsage, totalUsageByModel } = computeCodexForestTotals(analysis, forest);
  const repoRoot = resolveCodexRepoRoot(analysis, repoRootByUrl);
  return {
    source: "codex",
    sessionId: analysis.sessionId,
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
    toolCallCount: analysis.toolCallCount,
    toolErrorCount: analysis.toolErrorCount,
    sizeBytes: ref.sizeBytes,
    modelMix: codexModelMix(analysis, forest),
    usageByModel: sliceUsageByModel(totalUsageByModel),
    delegation: sliceDelegation(
      computeDelegationSummary(analysis.usage, totalUsage, totalUsageByModel),
    ),
    ...(analysis.cwd !== undefined && { cwd: analysis.cwd }),
    ...(repoRoot !== undefined && { repoRoot }),
    ...(analysis.gitRepositoryUrl !== undefined && { repoUrl: analysis.gitRepositoryUrl }),
    ...(analysis.worktreeName !== undefined && { worktreeName: analysis.worktreeName }),
    ...(analysis.title !== undefined && { title: analysis.title }),
    ...(analysis.firstUserPrompt !== undefined && { firstUserPrompt: analysis.firstUserPrompt }),
    ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
    ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
    ...(analysis.durationMs !== undefined && { durationMs: analysis.durationMs }),
  };
}

/**
 * List Codex rollout files. `resolveCodexHome` is called per-request (not
 * cached at module load) so tests can override `CODEX_HOME` via
 * `process.env` the same way `resolveClaudeProjectsDirs` picks up
 * `CLAUDE_CONFIG_DIR` per-request. A missing `~/.codex` yields `[]`, not an
 * error — `listCodexSessionFiles` already treats missing dirs as empty.
 */
export async function listCodexRefs(): Promise<CodexSessionFileRef[]> {
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
 *
 * Thread names from `$CODEX_HOME/session_index.jsonl` are overlaid onto each
 * analysis's `title` here (the Codex analog of Claude's Desktop-title
 * fallback — see `desktopTitles` in `sources/claude.ts`): newer Codex
 * versions never write `thread_name_updated` into the rollout, and a rename
 * made after the session ended only touches the index, so the INDEX name
 * wins when both exist. Overlaying at this single funnel covers the session
 * list, session detail, and sub-agent forest descriptions alike.
 */
async function listCodexAnalyzed(): Promise<CodexAnalyzedRef[]> {
  const refs = await listCodexRefs();
  const indexTitles = await loadCodexSessionIndexTitles(resolveCodexHome(process.env));
  const out: CodexAnalyzedRef[] = [];
  for (const ref of refs) {
    try {
      const analysis = await analyzeCodexCached(ref);
      if (analysis === undefined) continue; // legacy/empty format — not listable.
      const indexTitle = indexTitles.get(analysis.sessionId);
      // Copy rather than mutate: analyzeCodexCached shares one object per
      // mtime, and a later index rename must not be baked into the cache.
      const overlaid =
        indexTitle === undefined || indexTitle === analysis.title
          ? analysis
          : { ...analysis, title: indexTitle };
      out.push({ ref, analysis: overlaid });
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
 *
 * Unlike `claudeListItems`, `max` only truncates the RESULT — every rollout
 * still gets analyzed, because sub-agent exclusion and each parent's
 * forest-inclusive totals both need the full analysis pool (see
 * `listCodexAnalyzed`). `bounds` (see `SessionListBounds`) is likewise a
 * pure RESULT filter here rather than an analysis-skipping optimization like
 * the Claude adapter's: it's applied by `sortMs` AFTER the sub-agent
 * exclusion above and BEFORE the sort/slice below, so a bounded page still
 * reflects the correct merged order. `total` is computed BEFORE that date
 * filter (right after exclusion), so it stays the count of every listable
 * session regardless of `bounds` — same unbounded meaning `max` already had.
 * Entries carry `sortMs` = the session's start time (falling back to file
 * mtime — see `ListingAdapter` in sessions.ts).
 */
export async function codexListItems(
  max?: number,
  bounds?: SessionListBounds,
): Promise<{ entries: { item: CodexSessionListItem; sortMs: number }[]; total: number }> {
  const pool = await listCodexAnalyzed();
  const analyses = pool.map((p) => p.analysis);
  const poolIds = new Set(analyses.map((a) => a.sessionId));
  const repoRootByUrl = buildRepoRootByUrl(analyses);
  const entries: { item: CodexSessionListItem; sortMs: number }[] = [];
  for (const { ref, analysis } of pool) {
    const parentId = analysis.codex.parentThreadId;
    const attachesToParent =
      analysis.codex.isSubagent && parentId !== undefined && poolIds.has(parentId);
    if (attachesToParent) continue;
    const forest = buildCodexSubagentForest(analyses, analysis.sessionId);
    const startedMs = analysis.startedAt === undefined ? NaN : Date.parse(analysis.startedAt);
    entries.push({
      item: toCodexListItem(analysis, ref, forest, repoRootByUrl),
      sortMs: Number.isNaN(startedMs) ? ref.mtimeMs : startedMs,
    });
  }
  const total = entries.length;
  const withinBounds = entries.filter((e) => {
    if (bounds?.sinceMs !== undefined && e.sortMs < bounds.sinceMs) return false;
    if (bounds?.untilMs !== undefined && e.sortMs >= bounds.untilMs) return false;
    return true;
  });
  withinBounds.sort((a, b) => b.sortMs - a.sortMs);
  return {
    entries: max === undefined ? withinBounds : withinBounds.slice(0, max),
    total,
  };
}

async function findCodexRef(sessionId: string): Promise<CodexSessionFileRef | undefined> {
  const refs = await listCodexRefs();
  return refs.find((r) => r.sessionId === sessionId);
}

/**
 * Last on-disk activity for a Codex session — the rollout file's own mtime,
 * plus every child sub-agent rollout's mtime IF this session has any (a
 * parent session is still "live" while a sub-agent it spawned keeps writing,
 * same rationale as Claude's sidecar mtimes in `getClaudeLastActivityAt`).
 * Child refs come from `listCodexAnalyzed`'s already-cached pool (mtime-keyed
 * via `analyzeCodexCached`) — the SAME pool `getCodexSession` builds its
 * forest from, so this reuses cheap, already-resolved data rather than
 * issuing extra stats per child. Never throws — a stat/lookup failure
 * degrades to `undefined` rather than failing the whole detail request.
 */
export async function getCodexLastActivityAt(sessionId: string): Promise<string | undefined> {
  const pool = await listCodexAnalyzed();
  const found = pool.find((p) => p.analysis.sessionId === sessionId);
  if (found === undefined) return undefined;
  try {
    const forest = buildCodexSubagentForest(
      pool.map((p) => p.analysis),
      sessionId,
    );
    const refBySessionId = new Map(pool.map((p) => [p.analysis.sessionId, p.ref] as const));
    let latestMs = found.ref.mtimeMs;
    const visit = (nodes: readonly SubagentNode[]) => {
      for (const node of nodes) {
        const childRef = refBySessionId.get(node.agentId);
        if (childRef !== undefined && childRef.mtimeMs > latestMs) latestMs = childRef.mtimeMs;
        visit(node.children);
      }
    };
    visit(forest);
    return new Date(latestMs).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * `CodexSessionAnalysis` plus its sub-agent tree — Claude parity: putting
 * `subagents`/`subagentCount` directly on the analysis mirrors
 * `ClaudeSessionAnalysis` (see `@junrei/core`'s `analyze.ts`), so the web's
 * Orchestration lens can consume either session type with the same field
 * names. `totalUsage`/`totalUsageByModel` are OVERRIDDEN from the base
 * `CodexSessionAnalysis` values (see `computeCodexForestTotals`) to include
 * every sub-agent recursively — the cached single-file analysis itself is
 * never mutated, this is a fresh object built at serve time. `delegation` is
 * OVERRIDDEN the same way, recomputed from the forest-inclusive
 * `totalUsage`/`totalUsageByModel` rather than the own-thread-only value
 * `analyzeCodexSession` attached (see `session-analysis.ts`'s field doc).
 * `fileAccess`
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
    const delegation = computeDelegationSummary(
      found.analysis.usage,
      totalUsage,
      totalUsageByModel,
    );
    const bySessionId = new Map(pool.map((p) => [p.analysis.sessionId, p.analysis] as const));
    const { fileAccess, fileAccessTruncated, fileAccessOmittedCount } = mergeCodexFileAccess(
      found.analysis.fileAccess,
      collectForestFileAccess(forest, bySessionId),
    );
    // Same URL-anchored repoRoot the session's list row shows (see
    // `buildRepoRootByUrl`) — detail and list must agree on repo identity.
    const repoRoot = resolveCodexRepoRoot(
      found.analysis,
      buildRepoRootByUrl(pool.map((p) => p.analysis)),
    );
    return {
      ...found.analysis,
      ...(repoRoot !== undefined && { repoRoot }),
      totalUsage,
      totalUsageByModel,
      delegation,
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
 * analog of Claude's `sessionDataCached`. A separate cache from `codexCache`
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
 * The Codex source adapter — mirrors `claudeAdapter` (`sources/claude.ts`).
 * `getTimeline`/`getRecordDetail` take no `agentId` (Codex has no subagent
 * tree to scope a fetch into — a Codex sub-agent is its own full session,
 * fetched by its own `CodexSessionKey`), unlike the Claude adapter's
 * corresponding methods — still `satisfies SourceAdapter` (see
 * `sources/shared.ts`) because a function accepting fewer parameters than
 * its declared type is always call-compatible.
 */
export const codexAdapter = {
  source: "codex" as const,
  listItems: codexListItems,
  getDetail: (key: CodexSessionKey): Promise<CodexSessionAnalysisWithSubagents | undefined> =>
    getCodexSession(key.id),
  getTimeline: (key: CodexSessionKey): Promise<TimelineEntry[] | undefined> =>
    getCodexTimeline(key.id),
  getRecordDetail: (key: CodexSessionKey, line: number): Promise<RecordDetail | undefined> =>
    getCodexSessionRecordDetail(key.id, line),
} satisfies SourceAdapter<CodexSessionKey, CodexSessionListItem, CodexSessionAnalysisWithSubagents>;
