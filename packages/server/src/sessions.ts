import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeCodexSession,
  analyzeSession,
  buildCodexTimeline,
  buildSessionData,
  buildTimeline,
  type CodexSessionAnalysis,
  type CodexSessionFileRef,
  type CodexTranscript,
  getCodexRecordDetail,
  getRecordDetail,
  listCodexSessionFiles,
  listSessionFiles,
  loadSubagentSessionData,
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
 * `projectDirName` and `subagentCount` are conceptually Claude-only (Codex
 * has no project-dir munging and no subagent tree), but @junrei/web's
 * session-list UI (out of scope for this PR — see docs/roadmap.md) reads
 * both unconditionally without narrowing on `source`. Rather than making
 * them optional (which would force `string | undefined` through
 * `formatProject`/`sessionPath` call sites the web package isn't touched to
 * fix), `CodexSessionListItem` below fills sentinel values: `projectDirName:
 * "codex"` (the same literal segment the detail route uses, so it never
 * collides with a real munged Claude dir) and `subagentCount: 0`. PR3 (web
 * UI) should switch to branching on `source` and can drop this shim then.
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
  /** Sentinel — Codex CLI sessions have no subagent concept. */
  subagentCount: 0;
  /** True when the rollout file lives under `archived_sessions/` rather than `sessions/YYYY/MM/DD/`. */
  archived: boolean;
}

/** Either harness's list item, discriminated on `source`. */
export type AnySessionListItem = ClaudeSessionListItem | CodexSessionListItem;

/** Back-compat alias — pre-Codex call sites imported this name directly. */
export type SessionListItem = AnySessionListItem;

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

/** Codex has no subagent tree, so its "model mix" is just its own per-model usage. */
function codexModelMix(analysis: CodexSessionAnalysis): ModelMixEntry[] {
  return analysis.usage.byModel.map((m) => ({ model: m.model, outputTokens: m.outputTokens }));
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

function toCodexListItem(
  analysis: CodexSessionAnalysis,
  ref: CodexSessionFileRef,
): CodexSessionListItem {
  return {
    source: "codex",
    sessionId: analysis.sessionId,
    projectDirName: "codex",
    subagentCount: 0,
    archived: ref.archived,
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
    compactionCount: analysis.compactions.length,
    toolCallCount: analysis.codex.toolCallCount,
    toolErrorCount: analysis.codex.toolErrorCount,
    sizeBytes: ref.sizeBytes,
    modelMix: codexModelMix(analysis),
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

async function codexListItems(): Promise<{ item: CodexSessionListItem; mtimeMs: number }[]> {
  const refs = await listCodexRefs();
  const out: { item: CodexSessionListItem; mtimeMs: number }[] = [];
  for (const ref of refs) {
    try {
      const analysis = await analyzeCodexCached(ref);
      if (analysis === undefined) continue; // legacy/empty format — not listable.
      out.push({ item: toCodexListItem(analysis, ref), mtimeMs: ref.mtimeMs });
    } catch {
      // Unreadable session — skip rather than failing the whole list.
    }
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
 * Codex session detail, by session id alone (Codex has no project-dir
 * concept to scope by). Returns `undefined` for an unknown id *or* a
 * legacy/empty-format transcript — both surface as a 404 in `app.ts`.
 */
export async function getCodexSession(
  sessionId: string,
): Promise<CodexSessionAnalysis | undefined> {
  const ref = await findCodexRef(sessionId);
  if (ref === undefined) return undefined;
  try {
    return await analyzeCodexCached(ref);
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
