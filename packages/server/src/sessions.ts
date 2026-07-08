import {
  analyzeSession,
  listSessionFiles,
  resolveProjectsDirs,
  type SessionAnalysis,
  type SessionFileRef,
} from "@junrei/core";

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

export async function getSession(
  projectDirName: string,
  sessionId: string,
): Promise<SessionAnalysis | undefined> {
  const dirs = await resolveProjectsDirs();
  const refs = await listSessionFiles(dirs);
  const ref = refs.find((r) => r.projectDirName === projectDirName && r.sessionId === sessionId);
  if (ref === undefined) return undefined;
  try {
    return await analyzeCached(ref);
  } catch {
    return undefined;
  }
}
