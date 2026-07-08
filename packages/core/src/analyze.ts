import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  BackgroundTaskInfo,
  ContextPoint,
  ExplorationProfile,
  RepetitionFinding,
  TokenTotals,
  ToolStat,
  UsageSummary,
} from "./metrics.js";
import {
  computeBackgroundTasks,
  computeContextTimeline,
  computeExploration,
  computeRepetitions,
  computeToolStats,
  computeUsage,
} from "./metrics.js";
import { parseTranscriptFile } from "./parser.js";
import type { CompactionEvent } from "./session-data.js";
import { buildSessionData } from "./session-data.js";

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
  contextTimeline: ContextPoint[];
  compactions: CompactionEvent[];
  apiErrorCount: number;
  toolStats: ToolStat[];
  repetitions: RepetitionFinding[];
  exploration: ExplorationProfile;
  backgroundTasks: BackgroundTaskInfo[];
  subagents: SubagentNode[];
  subagentCount: number;
  firstUserPrompt?: string;
  parseWarningCount: number;
}

interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

/** Analyze one session file, including its subagent sidecar transcripts. */
export async function analyzeSession(filePath: string): Promise<SessionAnalysis> {
  const transcript = await parseTranscriptFile(filePath);
  const data = buildSessionData(transcript);
  const sessionId = basename(filePath, ".jsonl");
  const projectDirName = basename(dirname(filePath));

  const { subagents, subagentCount, subagentTotals } = await analyzeSubagents(filePath, sessionId);

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

  return {
    sessionId,
    filePath,
    projectDirName,
    userTurnCount: data.userPrompts.length,
    apiMessageCount: data.apiMessages.length,
    models,
    usage,
    totalUsage,
    contextTimeline: computeContextTimeline(data),
    compactions: data.compactions,
    apiErrorCount: data.apiErrorCount,
    toolStats: computeToolStats(data),
    repetitions: computeRepetitions(data),
    exploration: computeExploration(data),
    backgroundTasks: computeBackgroundTasks(data),
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
  };
}

async function analyzeSubagents(
  filePath: string,
  sessionId: string,
): Promise<{
  subagents: SubagentNode[];
  subagentCount: number;
  subagentTotals: TokenTotals & { costUsd: number; costIsComplete: boolean };
}> {
  const subagentsDir = join(dirname(filePath), sessionId, "subagents");
  const subagentTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costIsComplete: true,
  };

  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return { subagents: [], subagentCount: 0, subagentTotals };
  }

  const nodes = new Map<string, SubagentNode>();
  /** toolUseId -> agentId of the transcript that issued that tool call. */
  const toolUseOwner = new Map<string, string>();

  for (const entry of entries) {
    const match = /^agent-(.+)\.jsonl$/.exec(entry);
    if (match === null || match[1] === undefined) continue;
    const agentId = match[1];

    let meta: SubagentMeta = {};
    try {
      meta = JSON.parse(
        await readFile(join(subagentsDir, `agent-${agentId}.meta.json`), "utf8"),
      ) as SubagentMeta;
    } catch {
      // Meta file is optional.
    }

    const transcript = await parseTranscriptFile(join(subagentsDir, entry));
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
