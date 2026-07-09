import {
  analyzeSession,
  buildSessionData,
  buildTimeline,
  getRecordDetail,
  listSessionFiles,
  loadSubagentSessionData,
  parseTranscriptFile,
  type RecordDetail,
  resolveProjectsDirs,
  type SessionAnalysis,
  type SessionData,
  type SessionFileRef,
  type SubagentNode,
  type TimelineEntry,
} from "@junrei/core";

/** Per-model output-token totals (main session + all subagents, recursively). */
export interface ModelMixEntry {
  model: string;
  outputTokens: number;
}

export interface SessionListItem {
  sessionId: string;
  projectDirName: string;
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
  subagentCount: number;
  compactionCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  sizeBytes: number;
  /** Output-token share per model, main session + all subagents (for the L0 model-mix bar). */
  modelMix: ModelMixEntry[];
}

/**
 * Aggregate output tokens per model across the main transcript and every
 * subagent (recursively), so the session-list "model mix" bar reflects the
 * whole session, not just the top-level model.
 */
export function computeModelMix(analysis: SessionAnalysis): ModelMixEntry[] {
  const totals = new Map<string, number>();
  const addUsage = (byModel: readonly { model: string; outputTokens: number }[]) => {
    for (const m of byModel) {
      totals.set(m.model, (totals.get(m.model) ?? 0) + m.outputTokens);
    }
  };
  addUsage(analysis.usage.byModel);
  const visit = (nodes: readonly SubagentNode[]) => {
    for (const node of nodes) {
      addUsage(node.usage.byModel);
      visit(node.children);
    }
  };
  visit(analysis.subagents);
  return [...totals].map(([model, outputTokens]) => ({ model, outputTokens }));
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

function toListItem(analysis: SessionAnalysis, ref: SessionFileRef): SessionListItem {
  const toolCallCount = analysis.toolStats.reduce((sum, s) => sum + s.callCount, 0);
  const toolErrorCount = analysis.toolStats.reduce((sum, s) => sum + s.errorCount, 0);
  return {
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

export async function listSessions(limit: number): Promise<SessionListItem[]> {
  const dirs = await resolveProjectsDirs();
  const refs = (await listSessionFiles(dirs)).slice(0, limit);
  const items: SessionListItem[] = [];
  for (const ref of refs) {
    try {
      items.push(toListItem(await analyzeCached(ref), ref));
    } catch {
      // Unreadable session — skip rather than failing the whole list.
    }
  }
  return items;
}

async function findRef(
  projectDirName: string,
  sessionId: string,
): Promise<SessionFileRef | undefined> {
  const dirs = await resolveProjectsDirs();
  const refs = await listSessionFiles(dirs);
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
