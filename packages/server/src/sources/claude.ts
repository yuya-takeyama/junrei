import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeSession,
  buildSessionData,
  buildTimeline,
  type ClaudeSessionAnalysis,
  type ClaudeSessionFileRef,
  getRecordDetail,
  listSessionFiles,
  loadSubagentSessionData,
  parseClaudeTranscriptFile,
  type RecordDetail,
  resolveProjectsDirs,
  type SessionData,
  subagentsDirFor,
  type TimelineEntry,
} from "@junrei/core";
import {
  type ModelMixEntry,
  mixFromUsageTree,
  type SessionListItemBase,
  sliceDelegation,
  sliceUsageByModel,
} from "./shared.js";

/** Key identifying one Claude Code session — a munged project dir plus the session UUID. */
export interface ClaudeSessionKey {
  project: string;
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

interface CacheEntry {
  mtimeMs: number;
  analysis: ClaudeSessionAnalysis;
}

const cache = new Map<string, CacheEntry>();

async function analyzeCached(ref: ClaudeSessionFileRef): Promise<ClaudeSessionAnalysis> {
  const hit = cache.get(ref.filePath);
  if (hit !== undefined && hit.mtimeMs === ref.mtimeMs) {
    return hit.analysis;
  }
  const analysis = await analyzeSession(ref.filePath);
  cache.set(ref.filePath, { mtimeMs: ref.mtimeMs, analysis });
  return analysis;
}

function toListItem(
  analysis: ClaudeSessionAnalysis,
  ref: ClaudeSessionFileRef,
): ClaudeSessionListItem {
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
    usageByModel: sliceUsageByModel(analysis.totalUsageByModel),
    delegation: sliceDelegation(analysis.delegation),
    ...(analysis.cwd !== undefined && { cwd: analysis.cwd }),
    ...(analysis.repoRoot !== undefined && { repoRoot: analysis.repoRoot }),
    ...(analysis.worktreeName !== undefined && { worktreeName: analysis.worktreeName }),
    ...(analysis.title !== undefined && { title: analysis.title }),
    ...(analysis.firstUserPrompt !== undefined && { firstUserPrompt: analysis.firstUserPrompt }),
    ...(analysis.startedAt !== undefined && { startedAt: analysis.startedAt }),
    ...(analysis.endedAt !== undefined && { endedAt: analysis.endedAt }),
    ...(analysis.durationMs !== undefined && { durationMs: analysis.durationMs }),
  };
}

async function listClaudeRefs(): Promise<ClaudeSessionFileRef[]> {
  const dirs = await resolveProjectsDirs();
  return listSessionFiles(dirs);
}

/**
 * Session-start ordering key for a ref that hasn't been analyzed yet — file
 * birth time when the filesystem tracks it (session files are created at
 * session start), `mtimeMs` otherwise. Clamped to `mtimeMs` because a file
 * can't have been written before it started (guards copied/synced files whose
 * birth time is the copy time).
 */
function startProxyMs(ref: ClaudeSessionFileRef): number {
  return ref.birthtimeMs > 0 ? Math.min(ref.birthtimeMs, ref.mtimeMs) : ref.mtimeMs;
}

/**
 * List Claude sessions as `{ entries, total }` — entries carry `sortMs` (the
 * session's start time in epoch ms, see `ListingAdapter` in sessions.ts).
 *
 * `max` bounds how many transcripts get ANALYZED, not just how many rows come
 * back: refs are ordered by `startProxyMs` (no parsing needed) and analysis
 * stops once `max` items exist, so a first page of 50 costs ~50 transcript
 * parses instead of every session on the machine. `total` is the full ref
 * count — cheap (stat-level) and what pagination needs. It can overcount by
 * however many unreadable files got skipped; a short last page is the
 * accepted trade for not parsing everything just to count.
 */
export async function claudeListItems(
  max?: number,
): Promise<{ entries: { item: ClaudeSessionListItem; sortMs: number }[]; total: number }> {
  const refs = [...(await listClaudeRefs())].sort((a, b) => startProxyMs(b) - startProxyMs(a));
  const entries: { item: ClaudeSessionListItem; sortMs: number }[] = [];
  for (const ref of refs) {
    if (max !== undefined && entries.length >= max) break;
    try {
      const analysis = await analyzeCached(ref);
      const startedMs = analysis.startedAt === undefined ? NaN : Date.parse(analysis.startedAt);
      entries.push({
        item: toListItem(analysis, ref),
        sortMs: Number.isNaN(startedMs) ? startProxyMs(ref) : startedMs,
      });
    } catch {
      // Unreadable session — skip rather than failing the whole list.
    }
  }
  return { entries, total: refs.length };
}

async function findRef(
  projectDirName: string,
  sessionId: string,
): Promise<ClaudeSessionFileRef | undefined> {
  const refs = await listClaudeRefs();
  return refs.find((r) => r.projectDirName === projectDirName && r.sessionId === sessionId);
}

export async function getSession(
  projectDirName: string,
  sessionId: string,
): Promise<ClaudeSessionAnalysis | undefined> {
  const ref = await findRef(projectDirName, sessionId);
  if (ref === undefined) return undefined;
  try {
    return await analyzeCached(ref);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a subagent's own sidecar transcript as a synthetic `ClaudeSessionFileRef`
 * (`sessionId` set to the agentId, `filePath` the sidecar jsonl) so it can
 * flow through the same `analyzeCached` cache as main sessions — keyed by
 * `filePath`, which is unique per sidecar, so no separate cache is needed.
 * `undefined` when the main session or the sidecar file doesn't exist.
 */
async function findAgentRef(
  projectDirName: string,
  sessionId: string,
  agentId: string,
): Promise<ClaudeSessionFileRef | undefined> {
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
      birthtimeMs: stats.birthtimeMs,
      sizeBytes: stats.size,
    };
  } catch {
    return undefined;
  }
}

/**
 * Analysis for one subagent's own transcript, scoped exactly like
 * `getSession` but for a sidecar — same `ClaudeSessionAnalysis` shape, reused
 * as-is by the web's agent-detail shell (deliberate: no separate DTO).
 * Claude-only — Codex sub-agent threads are full sessions in their own
 * right (see `sources/codex.ts`), not sidecar transcripts, so there is no
 * Codex equivalent of this lookup.
 */
export async function getAgentSession(
  projectDirName: string,
  sessionId: string,
  agentId: string,
): Promise<ClaudeSessionAnalysis | undefined> {
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
async function sessionDataCached(ref: ClaudeSessionFileRef): Promise<SessionData> {
  const hit = sessionDataCache.get(ref.filePath);
  if (hit !== undefined && hit.mtimeMs === ref.mtimeMs) return hit.data;
  const transcript = await parseClaudeTranscriptFile(ref.filePath);
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
  ref: ClaudeSessionFileRef,
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

/**
 * The Claude Code source adapter — one cohesive object app.ts/sessions.ts
 * dispatch to instead of scattering `if (source === "claude-code")` checks.
 * `getDetail`/`getTimeline`/`getRecordDetail` are keyed by `ClaudeSessionKey`
 * ({project, id}); `getAgentSession` above is exported separately since
 * agent-detail lookups have no Codex counterpart and don't fit the shared
 * shape (see `sources/codex.ts`'s `codexAdapter` for its sibling).
 */
export const claudeAdapter = {
  source: "claude-code" as const,
  listItems: claudeListItems,
  getDetail: (key: ClaudeSessionKey): Promise<ClaudeSessionAnalysis | undefined> =>
    getSession(key.project, key.id),
  getTimeline: (key: ClaudeSessionKey, agentId?: string): Promise<TimelineEntry[] | undefined> =>
    getTimeline(key.project, key.id, agentId),
  getRecordDetail: (
    key: ClaudeSessionKey,
    line: number,
    agentId?: string,
  ): Promise<RecordDetail | undefined> =>
    getSessionRecordDetail(key.project, key.id, line, agentId),
};
