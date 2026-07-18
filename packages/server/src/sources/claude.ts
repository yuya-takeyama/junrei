import {
  analyzeClaudeSession,
  buildClaudeTimeline,
  buildSessionData,
  type ClaudeSessionAnalysis,
  type ClaudeSessionFileRef,
  type ClaudeSessionStore,
  getClaudeRecordDetail,
  getClaudeToolCallDetail,
  listSubagentRefs,
  listWorkflowRuns,
  loadClaudeDesktopTitles,
  loadSubagentSessionData,
  localClaudeSessionStore,
  parseClaudeTranscriptFile,
  type RecordDetail,
  resolveClaudeDesktopSessionsDirs,
  type SessionData,
  type TimelineEntry,
  type ToolCallDetail,
} from "@junrei/core";
import { createS3ClaudeSessionStore, resolveS3StoreConfigFromEnv } from "./s3-store.js";
import {
  type ModelMixEntry,
  mixFromUsageTree,
  type SessionListBounds,
  type SessionListItemBase,
  type SourceAdapter,
  sliceBashSummary,
  sliceDelegation,
  sliceUsageByModel,
  sumSubagentReturns,
} from "./shared.js";

/**
 * Key identifying one Claude Code session — the bare session UUID.
 * `CodexSessionKey`-symmetric (Claude used to be scoped by `{project, id}`
 * — the munged project dir was needed to build the file path — but session
 * ids are UUIDv4, so a bare id resolves unambiguously via `findRefById`
 * below; the project dir is still resolved internally, it just no longer
 * needs to be supplied by the caller).
 */
export interface ClaudeSessionKey {
  id: string;
}

export interface ClaudeSessionListItem extends SessionListItemBase {
  source: "claude-code";
  projectDirName: string;
  subagentCount: number;
}

/**
 * Aggregate output tokens per model across the main transcript and every
 * subagent (recursively), so the session-list "model mix" bar reflects the
 * whole session, not just the top-level model.
 */
export function computeModelMix(analysis: ClaudeSessionAnalysis): ModelMixEntry[] {
  return mixFromUsageTree(analysis.usage.byModel, analysis.subagents);
}

/**
 * Titles for sessions whose transcript carries no `ai-title`/`custom-title`
 * records — Desktop-app sessions keep theirs only in the Desktop metadata
 * store (see `loadClaudeDesktopTitles`). A transcript's own title wins when
 * both exist. Local-only by nature (Claude Desktop has no S3 equivalent —
 * see the feature's non-goals) but harmless to consult for an S3 session too:
 * an S3-only sessionId simply won't match any local Desktop session id.
 */
function desktopTitles(): Promise<Map<string, string>> {
  return resolveClaudeDesktopSessionsDirs().then(loadClaudeDesktopTitles);
}

/**
 * Session-start ordering key for a ref that hasn't been analyzed yet — file
 * birth time when the store tracks it (session files are created at session
 * start), `mtimeMs` otherwise. Clamped to `mtimeMs` because a file can't have
 * been written before it started (guards copied/synced files whose birth time
 * is the copy time). For an S3 ref, `birthtimeMs === mtimeMs` always (S3 has
 * no birth-time concept — see `s3-store.ts`), so this is a no-op there.
 */
function startProxyMs(ref: ClaudeSessionFileRef): number {
  return ref.birthtimeMs > 0 ? Math.min(ref.birthtimeMs, ref.mtimeMs) : ref.mtimeMs;
}

/**
 * How far `startProxyMs` (file birthtime/mtime) is allowed to drift from a
 * transcript's real `startedAt` before `listItems` will still analyze it when
 * `bounds` is given. The proxy is a filesystem/S3 timestamp, not the
 * transcript's own claim about when it started (synced/copied files, clock
 * skew, etc.), so pruning on the proxy ALONE — with no slack — could skip a
 * ref that the exact post-filter (below) would have kept. 24h is generous
 * enough to absorb ordinary drift while still letting a 7-day default window
 * skip the vast majority of old sessions.
 */
const PROXY_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Everything one store (local filesystem, or an S3 bucket) needs to serve as
 * a Claude Code session source — built once per store by
 * `createClaudeAdapterBundle` below, each with its OWN analysis/session-data
 * caches (keyed by `filePath`, which is unique per store since it's a
 * store-scoped URI — see `@junrei/core`'s `store.ts` — so a local and an S3
 * bundle can never collide even though they'd otherwise share a cache).
 */
interface ClaudeAdapterBundle {
  listItems(
    max?: number,
    bounds?: SessionListBounds,
  ): Promise<{ entries: { item: ClaudeSessionListItem; sortMs: number }[]; total: number }>;
  getDetail(key: ClaudeSessionKey): Promise<ClaudeSessionAnalysis | undefined>;
  getTimeline(key: ClaudeSessionKey, agentId?: string): Promise<TimelineEntry[] | undefined>;
  getRecordDetail(
    key: ClaudeSessionKey,
    line: number,
    agentId?: string,
  ): Promise<RecordDetail | undefined>;
  getToolCallDetail(key: ClaudeSessionKey, toolUseId: string): Promise<ToolCallDetail | undefined>;
  getLastActivityAt(sessionId: string): Promise<string | undefined>;
  getAgentSession(sessionId: string, agentId: string): Promise<ClaudeSessionAnalysis | undefined>;
  getSessionData(key: ClaudeSessionKey): Promise<SessionData | undefined>;
}

function toListItem(
  analysis: ClaudeSessionAnalysis,
  ref: ClaudeSessionFileRef,
  desktopTitle?: string,
): ClaudeSessionListItem {
  const title = analysis.title ?? desktopTitle;
  const subagentReturn = sumSubagentReturns(analysis.subagents);
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
    toolCallCount: analysis.toolCallCount,
    toolErrorCount: analysis.toolErrorCount,
    sizeBytes: ref.sizeBytes,
    modelMix: computeModelMix(analysis),
    usageByModel: sliceUsageByModel(analysis.totalUsageByModel),
    delegation: sliceDelegation(analysis.delegation),
    // `analysis.bashStats` is ALREADY the main+every-subagent joint pass
    // (`analyzeClaudeSession` — see `SessionAnalysisCore.bashStats`'s doc
    // comment), computed as part of the very analysis this function is
    // already projecting every other field from — no extra work here.
    bashSummary: sliceBashSummary(analysis.bashStats),
    ...(analysis.cwd !== undefined && { cwd: analysis.cwd }),
    ...(analysis.repoRoot !== undefined && { repoRoot: analysis.repoRoot }),
    ...(analysis.worktreeName !== undefined && { worktreeName: analysis.worktreeName }),
    ...(title !== undefined && { title }),
    ...(analysis.firstUserPrompt !== undefined && { firstUserPrompt: analysis.firstUserPrompt }),
    ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
    ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
    ...(analysis.durationMs !== undefined && { durationMs: analysis.durationMs }),
    ...(subagentReturn !== undefined && { subagentReturn }),
  };
}

/**
 * Build the adapter bundle for ONE store — every fs/S3 touch below goes
 * through `store`, and `store.findSessionFileById`/`listSessionFiles` do
 * their own environment resolution (local: `CLAUDE_CONFIG_DIR` et al; S3: the
 * bucket/prefix baked into the store at construction time).
 */
function createClaudeAdapterBundle(store: ClaudeSessionStore): ClaudeAdapterBundle {
  interface CacheEntry {
    changeToken: string;
    analysis: ClaudeSessionAnalysis;
  }
  const cache = new Map<string, CacheEntry>();

  async function analyzeCached(ref: ClaudeSessionFileRef): Promise<ClaudeSessionAnalysis> {
    const hit = cache.get(ref.filePath);
    if (hit !== undefined && hit.changeToken === ref.changeToken) {
      return hit.analysis;
    }
    const analysis = await analyzeClaudeSession(ref.filePath, store);
    cache.set(ref.filePath, { changeToken: ref.changeToken, analysis });
    return analysis;
  }

  /**
   * List Claude sessions as `{ entries, total }` — entries carry `sortMs`
   * (the session's start time in epoch ms, see `ListingAdapter` in
   * sessions.ts).
   *
   * `max` bounds how many transcripts get ANALYZED, not just how many rows
   * come back: refs are ordered by `startProxyMs` (no parsing needed) and
   * analysis stops once `max` items exist, so a first page of 50 costs ~50
   * transcript parses instead of every session the store knows about.
   * `bounds` (see `SessionListBounds`) is a second, independent lever on the
   * same cost: a ref whose `startProxyMs` falls outside `[sinceMs, untilMs)`
   * by more than `PROXY_MARGIN_MS` is skipped WITHOUT being analyzed at all
   * (`continue`, not `break` — proxy order isn't perfectly reliable, so a
   * later ref can still be in range even after an out-of-range one). Once a
   * ref survives that coarse pre-filter and gets analyzed, its EXACT `sortMs`
   * (the real `startedAt`, not the proxy) is checked against the same bounds
   * and the entry is dropped if it doesn't actually qualify.
   *
   * `total` is the full ref count regardless of `max`/`bounds` — for the
   * local store this is cheap (stat-level); for the S3 store it's free once
   * the cached LIST sweep exists.
   */
  async function listItems(
    max?: number,
    bounds?: SessionListBounds,
  ): Promise<{ entries: { item: ClaudeSessionListItem; sortMs: number }[]; total: number }> {
    const refs = [...(await store.listSessionFiles())].sort(
      (a, b) => startProxyMs(b) - startProxyMs(a),
    );
    const titles = await desktopTitles();
    const entries: { item: ClaudeSessionListItem; sortMs: number }[] = [];
    for (const ref of refs) {
      if (max !== undefined && entries.length >= max) break;
      const proxyMs = startProxyMs(ref);
      if (bounds?.sinceMs !== undefined && proxyMs < bounds.sinceMs - PROXY_MARGIN_MS) continue;
      if (bounds?.untilMs !== undefined && proxyMs >= bounds.untilMs + PROXY_MARGIN_MS) continue;
      try {
        const analysis = await analyzeCached(ref);
        const startedMs = analysis.startedAt === undefined ? NaN : Date.parse(analysis.startedAt);
        const sortMs = Number.isNaN(startedMs) ? proxyMs : startedMs;
        if (bounds?.sinceMs !== undefined && sortMs < bounds.sinceMs) continue;
        if (bounds?.untilMs !== undefined && sortMs >= bounds.untilMs) continue;
        entries.push({
          item: toListItem(analysis, ref, titles.get(analysis.sessionId)),
          sortMs,
        });
      } catch {
        // Unreadable session — skip rather than failing the whole list.
      }
    }
    return { entries, total: refs.length };
  }

  async function getDetail(key: ClaudeSessionKey): Promise<ClaudeSessionAnalysis | undefined> {
    const ref = await store.findSessionFileById(key.id);
    if (ref === undefined) return undefined;
    try {
      const analysis = await analyzeCached(ref);
      if (analysis.title !== undefined) return analysis;
      const title = (await desktopTitles()).get(key.id);
      // Copy rather than mutate: analyzeCached shares one object per change
      // token, and a later Desktop rename must not be baked into the cache.
      return title === undefined ? analysis : { ...analysis, title };
    } catch {
      return undefined;
    }
  }

  /**
   * Last known activity for a session — the max mtime across the main
   * transcript, every subagent sidecar transcript (classic AND
   * Workflow-tool layouts, via `listSubagentRefs`), and every workflow run's
   * own state file (`workflows/<runId>.json`, which keeps getting rewritten
   * as a run progresses even between individual agent-transcript writes —
   * see `listWorkflowRuns`), so a session with a quiet main transcript but a
   * subagent or workflow run still actively writing still reads as live.
   * Deliberately narrower than the full `listSidecarFiles` sweep: sidecar
   * `.meta.json` files, workflow `scripts/*.js`, and a workflow run's
   * `journal.jsonl` resume log are excluded, matching the pre-store-refactor
   * behavior (see `git show HEAD:packages/server/src/sources/claude.ts`) —
   * those files can be rewritten well after a session's real last activity
   * (e.g. a meta file touched by unrelated tooling) and would otherwise
   * skew "still running" liveness.
   *
   * Fresh per request (never cached alongside `ClaudeSessionAnalysis`, which
   * is keyed by the main file's change token alone) — the web derives "still
   * running" from this value, so it must reflect the CURRENT store state,
   * not whatever the analysis was cached under. Never throws: a read
   * failure degrades to `undefined` rather than failing the whole session
   * detail request over a liveness nicety.
   */
  async function getLastActivityAt(sessionId: string): Promise<string | undefined> {
    const ref = await store.findSessionFileById(sessionId);
    if (ref === undefined) return undefined;
    try {
      const [subagentRefs, workflowRuns] = await Promise.all([
        listSubagentRefs(ref.filePath, store),
        listWorkflowRuns(ref.filePath, store),
      ]);
      const candidatePaths = new Set([
        ...subagentRefs.map((r) => r.jsonlPath),
        ...workflowRuns.map((r) => r.filePath),
      ]);
      let latestMs = ref.mtimeMs;
      if (candidatePaths.size > 0) {
        const sidecars = await store.listSidecarFiles(ref.filePath);
        for (const sidecar of sidecars) {
          if (candidatePaths.has(sidecar.path) && sidecar.mtimeMs > latestMs) {
            latestMs = sidecar.mtimeMs;
          }
        }
      }
      return new Date(latestMs).toISOString();
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a subagent's own sidecar transcript as a synthetic
   * `ClaudeSessionFileRef` (`sessionId` set to the agentId, `filePath` the
   * sidecar's own path) so it can flow through the same `analyzeCached` cache
   * as main sessions — keyed by `filePath`, unique per sidecar. `undefined`
   * when the main session or the sidecar file doesn't exist.
   *
   * Resolves via `listSubagentRefs` (not a direct top-level path join) so it
   * finds Workflow-tool agents too — those live one level deeper, under
   * `subagents/workflows/<runId>/`. `mtimeMs`/`sizeBytes` come from the same
   * `listSidecarFiles` sweep `listSubagentRefs` itself already reads (no
   * per-file stat/HEAD call needed beyond what that sweep already did).
   */
  async function findAgentRef(
    sessionId: string,
    agentId: string,
  ): Promise<ClaudeSessionFileRef | undefined> {
    const mainRef = await store.findSessionFileById(sessionId);
    if (mainRef === undefined) return undefined;
    const [subagentRefs, sidecarFiles] = await Promise.all([
      listSubagentRefs(mainRef.filePath, store),
      store.listSidecarFiles(mainRef.filePath),
    ]);
    const subagentRef = subagentRefs.find((r) => r.agentId === agentId);
    if (subagentRef === undefined) return undefined;
    const sidecarFile = sidecarFiles.find((f) => f.path === subagentRef.jsonlPath);
    const mtimeMs = sidecarFile?.mtimeMs ?? 0;
    return {
      sessionId: agentId,
      filePath: subagentRef.jsonlPath,
      projectDirName: mainRef.projectDirName,
      mtimeMs,
      birthtimeMs: mtimeMs,
      sizeBytes: sidecarFile?.sizeBytes ?? 0,
      // The sidecar's own change token (S3: ETag-based, sub-second-accurate)
      // rather than `String(mtimeMs)` — S3's `mtimeMs` is `LastModified`,
      // only 1-second precision, so two writes within the same second would
      // otherwise share a cache key and serve a stale cached agent analysis
      // (see `ClaudeSidecarFileRef.changeToken`'s doc comment).
      changeToken: sidecarFile?.changeToken ?? String(mtimeMs),
    };
  }

  /**
   * Analysis for one subagent's own transcript, scoped exactly like
   * `getDetail` but for a sidecar — same `ClaudeSessionAnalysis` shape,
   * reused as-is by the web's agent-detail shell (deliberate: no separate
   * DTO). Claude-only — Codex sub-agent threads are full sessions in their
   * own right (see `sources/codex.ts`), not sidecar transcripts, so there is
   * no Codex equivalent of this lookup.
   */
  async function getAgentSession(
    sessionId: string,
    agentId: string,
  ): Promise<ClaudeSessionAnalysis | undefined> {
    const ref = await findAgentRef(sessionId, agentId);
    if (ref === undefined) return undefined;
    try {
      return await analyzeCached(ref);
    } catch {
      return undefined;
    }
  }

  interface SessionDataCacheEntry {
    changeToken: string;
    data: SessionData;
  }
  const sessionDataCache = new Map<string, SessionDataCacheEntry>();

  /** Parsed + structured (but not analyzed) main-session data, cached by change token. */
  async function sessionDataCached(ref: ClaudeSessionFileRef): Promise<SessionData> {
    const hit = sessionDataCache.get(ref.filePath);
    if (hit !== undefined && hit.changeToken === ref.changeToken) return hit.data;
    const transcript = await parseClaudeTranscriptFile(ref.filePath, store);
    const data = buildSessionData(transcript);
    sessionDataCache.set(ref.filePath, { changeToken: ref.changeToken, data });
    return data;
  }

  /**
   * Resolve which transcript to read for a timeline/record request: the main
   * session, or — when `agentId` is given — that subagent's own sidecar
   * transcript (which lives alongside the main session file regardless of
   * nesting depth).
   */
  async function resolveThreadData(
    ref: ClaudeSessionFileRef,
    agentId: string | undefined,
  ): Promise<SessionData | undefined> {
    if (agentId === undefined) return sessionDataCached(ref);
    return loadSubagentSessionData(ref.filePath, agentId, store);
  }

  /** Full-transcript timeline for the Timeline lens (L2). `agentId` scopes it to one subagent. */
  async function getTimeline(
    key: ClaudeSessionKey,
    agentId?: string,
  ): Promise<TimelineEntry[] | undefined> {
    const ref = await store.findSessionFileById(key.id);
    if (ref === undefined) return undefined;
    try {
      const data = await resolveThreadData(ref, agentId);
      if (data === undefined) return undefined;
      return await buildClaudeTimeline(data, { mainFilePath: ref.filePath }, store);
    } catch {
      return undefined;
    }
  }

  /** Full detail for one source line — for the Record detail (L3) slide-over. */
  async function getRecordDetail(
    key: ClaudeSessionKey,
    line: number,
    agentId?: string,
  ): Promise<RecordDetail | undefined> {
    const ref = await store.findSessionFileById(key.id);
    if (ref === undefined) return undefined;
    try {
      const data = await resolveThreadData(ref, agentId);
      if (data === undefined) return undefined;
      return await getClaudeRecordDetail(data, line, { mainFilePath: ref.filePath }, store);
    } catch {
      return undefined;
    }
  }

  /**
   * One tool call + its result as a single unit — for the `get_tool_call` MCP
   * tool. Scoped to the MAIN transcript only (no `agentId` — unlike
   * `getRecordDetail`/`getTimeline`, `get_tool_call`'s spec has no subagent
   * scoping; a subagent's own tool calls aren't reachable through this
   * lookup). `undefined` for BOTH an unknown session id and an unknown
   * `toolUseId` — the MCP layer already resolved the session separately
   * before calling this, so it can tell the two apart itself.
   */
  async function getToolCallDetail(
    key: ClaudeSessionKey,
    toolUseId: string,
  ): Promise<ToolCallDetail | undefined> {
    const ref = await store.findSessionFileById(key.id);
    if (ref === undefined) return undefined;
    try {
      const data = await sessionDataCached(ref);
      return await getClaudeToolCallDetail(data, toolUseId, store);
    } catch {
      return undefined;
    }
  }

  /**
   * Raw (parsed but not analyzed) main-thread `SessionData` — for the
   * `get_bash_stats` MCP tool's `includeSubagents: false` recompute path
   * (`computeBashStats` needs per-thread `SessionData`, not the joint
   * `ClaudeSessionAnalysis.bashStats`) and `get_tool_calls`'s main-thread
   * listing. Scoped exactly like `getDetail` (ref resolution + cache), just
   * short of the full `analyzeClaudeSession` pass.
   */
  async function getSessionData(key: ClaudeSessionKey): Promise<SessionData | undefined> {
    const ref = await store.findSessionFileById(key.id);
    if (ref === undefined) return undefined;
    try {
      return await sessionDataCached(ref);
    } catch {
      return undefined;
    }
  }

  return {
    listItems,
    getDetail,
    getTimeline,
    getRecordDetail,
    getToolCallDetail,
    getLastActivityAt,
    getAgentSession,
    getSessionData,
  };
}

const localBundle = createClaudeAdapterBundle(localClaudeSessionStore);

/**
 * When `JUNREI_S3_SOURCE_URI` is set, a second bundle over an S3-backed store
 * — resolved/constructed once at module load (this module is imported once
 * per server process). `undefined` when unset (or malformed — see
 * `resolveS3StoreConfigFromEnv`), in which case every S3-aware helper below
 * degrades to exactly the local-only behavior this module always had.
 */
const s3Config = resolveS3StoreConfigFromEnv();
const s3Store = s3Config !== undefined ? createS3ClaudeSessionStore(s3Config) : undefined;
const s3Bundle = s3Store !== undefined ? createClaudeAdapterBundle(s3Store) : undefined;

/**
 * Local-first, S3-fallback lookup for the single-session helpers below — a
 * session found locally always wins over an S3 session with the same id
 * (accepted duplicate-id precedence, see the feature's design notes); an S3
 * session is only reached when no local session has that id at all.
 */
async function firstDefined<T>(
  lookups: readonly (() => Promise<T | undefined>)[],
): Promise<T | undefined> {
  for (const lookup of lookups) {
    const result = await lookup();
    if (result !== undefined) return result;
  }
  return undefined;
}

export async function getSession(sessionId: string): Promise<ClaudeSessionAnalysis | undefined> {
  return firstDefined([
    () => localBundle.getDetail({ id: sessionId }),
    () => s3Bundle?.getDetail({ id: sessionId }) ?? Promise.resolve(undefined),
  ]);
}

export async function getClaudeLastActivityAt(sessionId: string): Promise<string | undefined> {
  return firstDefined([
    () => localBundle.getLastActivityAt(sessionId),
    () => s3Bundle?.getLastActivityAt(sessionId) ?? Promise.resolve(undefined),
  ]);
}

export async function getAgentSession(
  sessionId: string,
  agentId: string,
): Promise<ClaudeSessionAnalysis | undefined> {
  return firstDefined([
    () => localBundle.getAgentSession(sessionId, agentId),
    () => s3Bundle?.getAgentSession(sessionId, agentId) ?? Promise.resolve(undefined),
  ]);
}

export async function getTimeline(
  sessionId: string,
  agentId?: string,
): Promise<TimelineEntry[] | undefined> {
  return firstDefined([
    () => localBundle.getTimeline({ id: sessionId }, agentId),
    () => s3Bundle?.getTimeline({ id: sessionId }, agentId) ?? Promise.resolve(undefined),
  ]);
}

export async function getSessionRecordDetail(
  sessionId: string,
  line: number,
  agentId?: string,
): Promise<RecordDetail | undefined> {
  return firstDefined([
    () => localBundle.getRecordDetail({ id: sessionId }, line, agentId),
    () => s3Bundle?.getRecordDetail({ id: sessionId }, line, agentId) ?? Promise.resolve(undefined),
  ]);
}

/** Local-first, S3-fallback lookup for one tool call — see `getSessionRecordDetail`. */
export async function getSessionToolCallDetail(
  sessionId: string,
  toolUseId: string,
): Promise<ToolCallDetail | undefined> {
  return firstDefined([
    () => localBundle.getToolCallDetail({ id: sessionId }, toolUseId),
    () => s3Bundle?.getToolCallDetail({ id: sessionId }, toolUseId) ?? Promise.resolve(undefined),
  ]);
}

/**
 * Local-first, S3-fallback lookup for one session's raw main-thread
 * `SessionData` — see `ClaudeAdapterBundle.getSessionData`'s doc comment for
 * why the `get_bash_stats`/`get_tool_calls` MCP tools need this short of the
 * full `ClaudeSessionAnalysis`.
 */
export async function getSessionData(sessionId: string): Promise<SessionData | undefined> {
  return firstDefined([
    () => localBundle.getSessionData({ id: sessionId }),
    () => s3Bundle?.getSessionData({ id: sessionId }) ?? Promise.resolve(undefined),
  ]);
}

/**
 * The Claude Code source adapter — one cohesive object app.ts/sessions.ts
 * dispatch to instead of scattering `if (source === "claude-code")` checks.
 * `listItems` here is LOCAL ONLY — `sessions.ts`'s merge registers `s3Adapter`
 * (below) as a SEPARATE `ListingAdapter` when S3 is configured, so both
 * sources' rows appear in the merged list independently (accepted duplicate
 * sessionId behavior, see the feature's design notes) rather than this
 * adapter silently unioning them itself. `getDetail`/`getTimeline`/
 * `getRecordDetail` are local-first-then-S3-fallback (see `firstDefined`
 * above) since those ARE keyed by a single `ClaudeSessionKey` regardless of
 * which store a session actually lives in. Checked against `SourceAdapter`
 * (see `sources/shared.ts`) via `satisfies` so both adapters are held to the
 * same contract without widening this object's own inferred type.
 */
export const claudeAdapter = {
  source: "claude-code" as const,
  listItems: localBundle.listItems,
  getDetail: (key: ClaudeSessionKey): Promise<ClaudeSessionAnalysis | undefined> =>
    getSession(key.id),
  getTimeline: (key: ClaudeSessionKey, agentId?: string): Promise<TimelineEntry[] | undefined> =>
    getTimeline(key.id, agentId),
  getRecordDetail: (
    key: ClaudeSessionKey,
    line: number,
    agentId?: string,
  ): Promise<RecordDetail | undefined> => getSessionRecordDetail(key.id, line, agentId),
} satisfies SourceAdapter<ClaudeSessionKey, ClaudeSessionListItem, ClaudeSessionAnalysis>;

/**
 * The S3-backed Claude Code adapter, registered ALONGSIDE `claudeAdapter` in
 * `sessions.ts`'s merge when `JUNREI_S3_SOURCE_URI` is configured —
 * `undefined` otherwise, so `byte-for-byte identical when unset` holds
 * (`sessions.ts` filters `undefined` out of its registry). Shares
 * `getDetail`/`getTimeline`/`getRecordDetail` with `claudeAdapter` (both are
 * the same local-first-then-S3-fallback functions) since a single-session
 * lookup is keyed by id alone regardless of which registry entry produced the
 * row that linked to it.
 */
export const s3ClaudeAdapter:
  | SourceAdapter<ClaudeSessionKey, ClaudeSessionListItem, ClaudeSessionAnalysis>
  | undefined =
  s3Bundle !== undefined
    ? ({
        source: "claude-code" as const,
        listItems: s3Bundle.listItems,
        getDetail: claudeAdapter.getDetail,
        getTimeline: claudeAdapter.getTimeline,
        getRecordDetail: claudeAdapter.getRecordDetail,
      } satisfies SourceAdapter<ClaudeSessionKey, ClaudeSessionListItem, ClaudeSessionAnalysis>)
    : undefined;

/**
 * Which store owns a Claude-transcript `filePath` — local absolute path or an
 * S3-backed store's `s3://bucket/key` URI (see `@junrei/core`'s `store.ts`).
 * Used by `search.ts` to read/scan a candidate file through the right store.
 * Falls back to the local store for an `s3://` path when no S3 store is
 * configured — shouldn't happen in practice (such a path could only have come
 * from `s3Store.listSessionFiles()` itself), kept only so the function total.
 */
export function claudeStoreForFilePath(filePath: string): ClaudeSessionStore {
  return filePath.startsWith("s3://")
    ? (s3Store ?? localClaudeSessionStore)
    : localClaudeSessionStore;
}

/**
 * Every Claude session file ref across BOTH stores (local + S3, when
 * configured) — the merged candidate pool `search.ts` scans, mirroring how
 * `sessions.ts` merges both sources' list items.
 */
export async function listAllClaudeRefs(): Promise<ClaudeSessionFileRef[]> {
  const [localRefs, s3Refs] = await Promise.all([
    localClaudeSessionStore.listSessionFiles(),
    s3Store !== undefined ? s3Store.listSessionFiles() : Promise.resolve([]),
  ]);
  return [...localRefs, ...s3Refs];
}
