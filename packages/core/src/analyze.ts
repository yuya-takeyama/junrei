import { basename, dirname } from "node:path";
import type {
  ContextPoint,
  ExplorationProfile,
  ModelUsageSummary,
  RepetitionFinding,
  TaskExecutionInfo,
  TokenTotals,
  ToolStat,
  UsageSummary,
} from "./metrics.js";
import {
  computeContextTimeline,
  computeExploration,
  computeRepetitions,
  computeTaskExecutions,
  computeToolStats,
  computeUsage,
} from "./metrics.js";
import { parseTranscriptFile } from "./parser.js";
import type { CompactionEvent } from "./session-data.js";
import { buildSessionData } from "./session-data.js";
import { listSubagentRefs } from "./subagents.js";

const PROMPT_PREVIEW_LIMIT = 500;

export interface SubagentNode {
  agentId: string;
  agentType?: string;
  description?: string;
  /** tool_use id of the Agent/Task call that spawned this agent. */
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
  promptPreview?: string;
  usage: UsageSummary;
  toolCallCount: number;
  toolErrorCount: number;
  startedAt?: string;
  endedAt?: string;
  children: SubagentNode[];
}

export interface SessionAnalysis {
  sessionId: string;
  filePath: string;
  projectDirName: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  userTurnCount: number;
  apiMessageCount: number;
  models: string[];
  /** Main transcript only. */
  usage: UsageSummary;
  /** Main + all subagents. */
  totalUsage: TokenTotals & { costUsd: number; costIsComplete: boolean };
  /** Per-model usage, main session + all subagents merged (recursively) by model id. */
  totalUsageByModel: ModelUsageSummary[];
  contextTimeline: ContextPoint[];
  compactions: CompactionEvent[];
  apiErrorCount: number;
  toolStats: ToolStat[];
  repetitions: RepetitionFinding[];
  exploration: ExplorationProfile;
  taskExecutions: TaskExecutionInfo[];
  subagents: SubagentNode[];
  subagentCount: number;
  firstUserPrompt?: string;
  /** Source line of the first user prompt (provenance for the Overview lens's "L<n>" ref). */
  firstUserPromptLine?: number;
  parseWarningCount: number;
}

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

  const { subagents, subagentCount, subagentTotals } = await analyzeSubagents(filePath);

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
    toolStats: computeToolStats(data),
    repetitions: computeRepetitions(data),
    exploration: computeExploration(data),
    taskExecutions: computeTaskExecutions(data),
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

async function analyzeSubagents(filePath: string): Promise<{
  subagents: SubagentNode[];
  subagentCount: number;
  subagentTotals: TokenTotals & { costUsd: number; costIsComplete: boolean };
}> {
  const subagentTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costIsComplete: true,
  };

  const refs = await listSubagentRefs(filePath);
  if (refs.length === 0) {
    return { subagents: [], subagentCount: 0, subagentTotals };
  }

  const nodes = new Map<string, SubagentNode>();
  /** toolUseId -> agentId of the transcript that issued that tool call. */
  const toolUseOwner = new Map<string, string>();

  for (const { agentId, jsonlPath, meta } of refs) {
    const transcript = await parseTranscriptFile(jsonlPath);
    const data = buildSessionData(transcript);
    const usage = computeUsage(data);
    for (const call of data.toolCalls) {
      toolUseOwner.set(call.toolUseId, agentId);
    }

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
  // call; everything else (spawned by the main transcript, or unmatched)
  // becomes a root node.
  const roots: SubagentNode[] = [];
  for (const node of nodes.values()) {
    const ownerAgentId =
      node.toolUseId !== undefined ? toolUseOwner.get(node.toolUseId) : undefined;
    const owner = ownerAgentId !== undefined ? nodes.get(ownerAgentId) : undefined;
    if (owner !== undefined && owner !== node) {
      owner.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const byStart = (a: SubagentNode, b: SubagentNode) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  for (const node of nodes.values()) node.children.sort(byStart);
  roots.sort(byStart);

  return { subagents: roots, subagentCount: nodes.size, subagentTotals };
}
