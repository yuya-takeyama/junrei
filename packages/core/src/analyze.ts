import { basename, dirname } from "node:path";
import type {
  ExplorationProfile,
  FileAccessAgg,
  FileAccessEntry,
  ModelUsageSummary,
  RepetitionFinding,
  SkillInvocation,
  TaskExecutionInfo,
  TokenTotals,
  ToolStat,
  TurnUsage,
  UsageSummary,
} from "./metrics.js";
import {
  computeContextTimeline,
  computeExploration,
  computeFileAccess,
  computeRepetitions,
  computeSkillInvocations,
  computeTaskExecutions,
  computeToolStats,
  computeTurnUsage,
  computeUsage,
  foldFileAccess,
  mergeFileAccess,
} from "./metrics.js";
import { parseTranscriptFile } from "./parser.js";
import type { SessionAnalysisCore } from "./session-analysis.js";
import type { ApiErrorLogEntry, SessionData, ToolCall } from "./session-data.js";
import {
  agentLaunchToolUseIds,
  asyncAgentLaunchToolUseIds,
  buildSessionData,
  toolResultLength,
} from "./session-data.js";
import { listSubagentRefs } from "./subagents.js";

/** Sentinel owner id for nodes launched directly from the main transcript. */
const MAIN_OWNER = "main";

const PROMPT_PREVIEW_LIMIT = 500;
/** Cap for `SubagentNode.returnedPreview` — matches the parser's own tool-result capture cap. */
const RETURNED_PREVIEW_LIMIT = 2000;

export interface SubagentNode {
  agentId: string;
  agentType?: string;
  description?: string;
  /**
   * tool_use id of the Agent/Task call that spawned this agent — from the
   * sidecar's meta.json, or recovered from the parent-side
   * `toolUseResult.agentId` when meta.json lacks it (some Claude Code
   * versions write only agentType/description there).
   */
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
  promptPreview?: string;
  usage: UsageSummary;
  toolCallCount: number;
  toolErrorCount: number;
  startedAt?: string;
  endedAt?: string;
  /**
   * Length of the parent-side `tool_result` text for the launching
   * Agent/Task tool call — undefined while unresolved (no result yet, the
   * launching call couldn't be matched, or the launch was ASYNC — see
   * `asyncLaunch`). Mirrors `SubagentLaunchEntry.returnedChars` in
   * timeline.ts (same underlying `ToolCall.result`), computed here too so
   * the Orchestration lens doesn't need a second round-trip through the
   * timeline builder just to show "↩ return" tokens in the tree.
   */
  returnedChars?: number;
  /**
   * The parent-side `tool_result` text itself (truncated to 2000 chars),
   * for the "return to parent" panel — same resolution rules as
   * `returnedChars` (undefined while unresolved or for async launches; the
   * async launch-ack boilerplate must never surface here as if it were the
   * agent's real return).
   */
  returnedPreview?: string;
  /**
   * True when the launch was asynchronous (`status: "async_launched"`). The
   * parent-side tool_result for an async launch is only the launch-ack
   * boilerplate — the agent's real return arrives later as a
   * task-notification whose text isn't in the log — so `returnedChars` stays
   * undefined rather than measuring the ack.
   */
  asyncLaunch?: boolean;
  /** Source line of the launching tool_use, in whichever transcript issued it (main or a parent subagent). */
  launchLine?: number;
  /** Timestamp of the launching tool_use — only set when distinct from `startedAt` (the agent's own first record). */
  launchedAt?: string;
  /** "main" when launched directly from the main transcript, otherwise the parent subagent's `agentId`. */
  spawnedBy?: string;
  children: SubagentNode[];
}

/**
 * Claude Code session analysis — `SessionAnalysisCore` plus everything that
 * only makes sense for a Claude Code transcript (subagent trees, per-tool
 * breakdowns, skill invocations, ...). See `session-analysis.ts` for the
 * shared-core rationale and `CodexSessionAnalysis` for the other variant.
 */
export interface SessionAnalysis extends SessionAnalysisCore {
  source: "claude-code";
  projectDirName: string;
  version?: string;
  apiMessageCount: number;
  apiErrorCount: number;
  /** Capped list backing apiErrorCount — see `ApiErrorLogEntry`. Main transcript only. */
  apiErrors: ApiErrorLogEntry[];
  /** Per-turn token composition, main transcript only — see `TurnUsage`. */
  turnUsage: TurnUsage[];
  toolStats: ToolStat[];
  repetitions: RepetitionFinding[];
  exploration: ExplorationProfile;
  taskExecutions: TaskExecutionInfo[];
  /** Per-file read/edit tally, main + every subagent merged — see `FileAccessEntry`. */
  fileAccess: FileAccessEntry[];
  /** True when the merged path count exceeded the cap (500) and entries were dropped. */
  fileAccessTruncated: boolean;
  /** Present only when `fileAccessTruncated` — number of distinct paths dropped by the cap. */
  fileAccessOmittedCount?: number;
  /** Skill/slash-command invocations, main transcript only — see `SkillInvocation`. */
  skillInvocations: SkillInvocation[];
  subagents: SubagentNode[];
  subagentCount: number;
}

/** Alias matching the `Claude*` naming used by the Codex counterpart — same type as `SessionAnalysis`. */
export type ClaudeSessionAnalysis = SessionAnalysis;

/**
 * Merge per-model usage summaries from the main transcript and every subagent
 * (recursively), keyed by model id — mirrors how `totalUsage` merges the
 * flat token/cost totals, but preserves the per-model breakdown so the
 * Overview lens's "cost by model" chart reflects delegated spend too.
 */
function mergeUsageByModel(
  main: readonly ModelUsageSummary[],
  subagents: readonly SubagentNode[],
): ModelUsageSummary[] {
  const totals = new Map<string, ModelUsageSummary>();
  const add = (entries: readonly ModelUsageSummary[]) => {
    for (const entry of entries) {
      const existing = totals.get(entry.model);
      if (existing === undefined) {
        totals.set(entry.model, { ...entry });
        continue;
      }
      existing.messageCount += entry.messageCount;
      existing.inputTokens += entry.inputTokens;
      existing.outputTokens += entry.outputTokens;
      existing.cacheReadTokens += entry.cacheReadTokens;
      existing.cacheCreationTokens += entry.cacheCreationTokens;
      if (entry.costUsd !== undefined) {
        existing.costUsd = (existing.costUsd ?? 0) + entry.costUsd;
      }
      if (entry.cacheWriteCostUsd !== undefined) {
        existing.cacheWriteCostUsd = (existing.cacheWriteCostUsd ?? 0) + entry.cacheWriteCostUsd;
      }
    }
  };
  add(main);
  const visit = (nodes: readonly SubagentNode[]) => {
    for (const node of nodes) {
      add(node.usage.byModel);
      visit(node.children);
    }
  };
  visit(subagents);
  return [...totals.values()];
}

/** Analyze one session file, including its subagent sidecar transcripts. */
export async function analyzeSession(filePath: string): Promise<SessionAnalysis> {
  const transcript = await parseTranscriptFile(filePath);
  const data = buildSessionData(transcript);
  const sessionId = basename(filePath, ".jsonl");
  const projectDirName = basename(dirname(filePath));

  const { subagents, subagentCount, subagentTotals, subagentFileAccess } = await analyzeSubagents(
    filePath,
    data,
  );
  const { fileAccess, fileAccessTruncated, fileAccessOmittedCount } = mergeFileAccess(
    computeFileAccess(data),
    subagentFileAccess,
  );

  const usage = computeUsage(data);
  const totalUsage = {
    inputTokens: usage.total.inputTokens + subagentTotals.inputTokens,
    outputTokens: usage.total.outputTokens + subagentTotals.outputTokens,
    cacheReadTokens: usage.total.cacheReadTokens + subagentTotals.cacheReadTokens,
    cacheCreationTokens: usage.total.cacheCreationTokens + subagentTotals.cacheCreationTokens,
    costUsd: usage.total.costUsd + subagentTotals.costUsd,
    costIsComplete: usage.total.costIsComplete && subagentTotals.costIsComplete,
  };

  const models = [
    ...new Set(data.apiMessages.map((m) => m.model).filter((m): m is string => m !== undefined)),
  ];
  const startedAt = data.firstTimestamp;
  const endedAt = data.lastTimestamp;
  const durationMs =
    startedAt !== undefined && endedAt !== undefined
      ? Date.parse(endedAt) - Date.parse(startedAt)
      : undefined;
  const firstUserPrompt = data.userPrompts[0]?.text.slice(0, PROMPT_PREVIEW_LIMIT);
  const firstUserPromptLine = data.userPrompts[0]?.line;

  return {
    source: "claude-code",
    sessionId,
    filePath,
    projectDirName,
    userTurnCount: data.userPrompts.length,
    apiMessageCount: data.apiMessages.length,
    models,
    usage,
    totalUsage,
    totalUsageByModel: mergeUsageByModel(usage.byModel, subagents),
    contextTimeline: computeContextTimeline(data),
    compactions: data.compactions,
    apiErrorCount: data.apiErrorCount,
    apiErrors: data.apiErrors,
    turnUsage: computeTurnUsage(data),
    toolStats: computeToolStats(data),
    repetitions: computeRepetitions(data),
    exploration: computeExploration(data),
    taskExecutions: computeTaskExecutions(data),
    fileAccess,
    fileAccessTruncated,
    ...(fileAccessOmittedCount !== undefined && { fileAccessOmittedCount }),
    skillInvocations: computeSkillInvocations(data),
    subagents,
    subagentCount,
    parseWarningCount: data.warningCount,
    ...(data.cwd !== undefined && { cwd: data.cwd }),
    ...(data.gitBranch !== undefined && { gitBranch: data.gitBranch }),
    ...(data.version !== undefined && { version: data.version }),
    ...(data.title !== undefined && { title: data.title }),
    ...(startedAt !== undefined && { startedAt }),
    ...(endedAt !== undefined && { endedAt }),
    ...(durationMs !== undefined && Number.isFinite(durationMs) && { durationMs }),
    ...(firstUserPrompt !== undefined && { firstUserPrompt }),
    ...(firstUserPromptLine !== undefined && { firstUserPromptLine }),
  };
}

async function analyzeSubagents(
  filePath: string,
  mainData: SessionData,
): Promise<{
  subagents: SubagentNode[];
  subagentCount: number;
  subagentTotals: TokenTotals & { costUsd: number; costIsComplete: boolean };
  /** Every subagent's file-access tallies, folded into one combined map. */
  subagentFileAccess: Map<string, FileAccessAgg>;
}> {
  const subagentTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costIsComplete: true,
  };
  const subagentFileAccess = new Map<string, FileAccessAgg>();

  const refs = await listSubagentRefs(filePath);
  if (refs.length === 0) {
    return { subagents: [], subagentCount: 0, subagentTotals, subagentFileAccess };
  }

  const nodes = new Map<string, SubagentNode>();
  /** toolUseId -> id ("main" or an agentId) of the transcript that issued that tool call. */
  const toolUseOwner = new Map<string, string>();
  /** owner id -> that transcript's own tool calls, keyed by toolUseId — lets us find the
   *  launching Agent/Task call's `result` (returnedChars/launchLine/launchedAt) the same
   *  way `buildTimeline` does, just across the whole subagent forest instead of one transcript. */
  const toolCallsByOwner = new Map<string, Map<string, ToolCall>>();
  /** tool_use ids whose result is only an async-launch ack, across every transcript. */
  const asyncLaunchIds = new Set<string>();
  /** agentId -> spawning tool_use id, recovered from parent-side `toolUseResult.agentId` —
   *  fallback linkage for sidecars whose meta.json lacks `toolUseId`. */
  const toolUseIdByAgentId = new Map<string, string>();

  const registerOwner = (ownerId: string, data: SessionData) => {
    toolCallsByOwner.set(ownerId, new Map(data.toolCalls.map((c) => [c.toolUseId, c])));
    for (const call of data.toolCalls) toolUseOwner.set(call.toolUseId, ownerId);
    for (const id of asyncAgentLaunchToolUseIds(data)) asyncLaunchIds.add(id);
    for (const [agentId, toolUseId] of agentLaunchToolUseIds(data)) {
      if (!toolUseIdByAgentId.has(agentId)) toolUseIdByAgentId.set(agentId, toolUseId);
    }
  };
  registerOwner(MAIN_OWNER, mainData);

  for (const { agentId, jsonlPath, meta } of refs) {
    const transcript = await parseTranscriptFile(jsonlPath);
    const data = buildSessionData(transcript);
    const usage = computeUsage(data);
    registerOwner(agentId, data);
    foldFileAccess(subagentFileAccess, computeFileAccess(data));

    subagentTotals.inputTokens += usage.total.inputTokens;
    subagentTotals.outputTokens += usage.total.outputTokens;
    subagentTotals.cacheReadTokens += usage.total.cacheReadTokens;
    subagentTotals.cacheCreationTokens += usage.total.cacheCreationTokens;
    subagentTotals.costUsd += usage.total.costUsd;
    if (!usage.total.costIsComplete) subagentTotals.costIsComplete = false;

    const model = data.apiMessages.find((m) => m.model !== undefined)?.model;
    const promptPreview = data.userPrompts[0]?.text.slice(0, PROMPT_PREVIEW_LIMIT);
    const toolErrorCount = data.toolCalls.filter((c) => c.result?.isError === true).length;

    nodes.set(agentId, {
      agentId,
      usage,
      toolCallCount: data.toolCalls.length,
      toolErrorCount,
      children: [],
      ...(meta.agentType !== undefined && { agentType: meta.agentType }),
      ...(meta.description !== undefined && { description: meta.description }),
      ...(meta.toolUseId !== undefined && { toolUseId: meta.toolUseId }),
      ...(meta.spawnDepth !== undefined && { spawnDepth: meta.spawnDepth }),
      ...(model !== undefined && { model }),
      ...(promptPreview !== undefined && { promptPreview }),
      ...(data.firstTimestamp !== undefined && { startedAt: data.firstTimestamp }),
      ...(data.lastTimestamp !== undefined && { endedAt: data.lastTimestamp }),
    });
  }

  // Attach children to the agent whose transcript issued their spawning tool
  // call; everything else (spawned directly by the main transcript, or
  // unmatched) becomes a root node, attributed to "main".
  const roots: SubagentNode[] = [];
  for (const node of nodes.values()) {
    if (node.toolUseId === undefined) {
      // Some Claude Code versions (observed on 2.1.138) write meta.json
      // without `toolUseId`; recover it from the spawning transcript's
      // `toolUseResult.agentId` so linkage below still resolves.
      const recovered = toolUseIdByAgentId.get(node.agentId);
      if (recovered !== undefined) node.toolUseId = recovered;
    }
    const ownerId = node.toolUseId !== undefined ? toolUseOwner.get(node.toolUseId) : undefined;
    const owner = ownerId !== undefined && ownerId !== MAIN_OWNER ? nodes.get(ownerId) : undefined;
    if (owner !== undefined && owner !== node) {
      owner.children.push(node);
    } else {
      roots.push(node);
    }
    Object.assign(node, launchLinkage(node, ownerId, toolCallsByOwner, asyncLaunchIds));
  }
  const byStart = (a: SubagentNode, b: SubagentNode) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  for (const node of nodes.values()) node.children.sort(byStart);
  roots.sort(byStart);

  return { subagents: roots, subagentCount: nodes.size, subagentTotals, subagentFileAccess };
}

/**
 * Resolve a node's launch-side metadata (returnedChars/asyncLaunch/launchLine/
 * launchedAt/spawnedBy) from the launching Agent/Task tool call, found in
 * whichever transcript owns it (main, or a parent subagent). Falls back to
 * `spawnedBy: "main"` when the owner or launching call can't be resolved —
 * the node still renders as a root in the tree either way. For async
 * launches, `returnedChars` is deliberately left undefined: the launch's
 * tool_result is only the ack boilerplate, not the agent's return.
 */
function launchLinkage(
  node: SubagentNode,
  ownerId: string | undefined,
  toolCallsByOwner: ReadonlyMap<string, ReadonlyMap<string, ToolCall>>,
  asyncLaunchIds: ReadonlySet<string>,
): Pick<
  SubagentNode,
  "returnedChars" | "returnedPreview" | "asyncLaunch" | "launchLine" | "launchedAt" | "spawnedBy"
> {
  const spawnedBy = ownerId ?? MAIN_OWNER;
  const asyncLaunch = node.toolUseId !== undefined && asyncLaunchIds.has(node.toolUseId);
  const launchCall =
    node.toolUseId !== undefined ? toolCallsByOwner.get(spawnedBy)?.get(node.toolUseId) : undefined;
  if (launchCall === undefined) {
    return { spawnedBy, ...(asyncLaunch && { asyncLaunch }) };
  }
  const returnedChars = asyncLaunch ? undefined : toolResultLength(launchCall);
  const returnedPreview = asyncLaunch
    ? undefined
    : launchCall.result?.text.slice(0, RETURNED_PREVIEW_LIMIT);
  return {
    spawnedBy,
    launchLine: launchCall.line,
    ...(asyncLaunch && { asyncLaunch }),
    ...(returnedChars !== undefined && { returnedChars }),
    ...(returnedPreview !== undefined && { returnedPreview }),
    ...(launchCall.timestamp !== undefined &&
      launchCall.timestamp !== node.startedAt && { launchedAt: launchCall.timestamp }),
  };
}
