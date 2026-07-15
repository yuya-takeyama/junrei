import { basename, dirname } from "node:path";
import { computeDelegationSummary } from "../shared/delegation.js";
import type { FileAccessAgg, TokenTotals } from "../shared/metrics.js";
import { foldFileAccess, mergeFileAccess, mergeUsageByModel } from "../shared/metrics.js";
import { deriveRepoIdentity } from "../shared/repo.js";
import type { SessionAnalysisCore } from "../shared/session-analysis.js";
import type { SubagentNode, SubagentStatus } from "../shared/subagent-node.js";
import type {
  ClaudeTurnUsage,
  ExplorationProfile,
  RepetitionFinding,
  TaskExecutionInfo,
  ToolStat,
} from "./metrics.js";
import {
  backgroundStatus,
  computeContextTimeline,
  computeExploration,
  computeFileAccess,
  computeRepetitions,
  computeSkillInvocations,
  computeTaskExecutions,
  computeToolStats,
  computeTurnUsage,
  computeUsage,
} from "./metrics.js";
import { parseClaudeTranscriptFile } from "./parser.js";
import type {
  ApiErrorLogEntry,
  BackgroundLaunch,
  SessionData,
  TaskNotificationEvent,
  ToolCall,
} from "./session-data.js";
import {
  agentLaunchToolUseIds,
  asyncAgentLaunchToolUseIds,
  buildSessionData,
  toolResultLength,
} from "./session-data.js";
import { listSubagentRefs, type SubagentRef } from "./subagents.js";
import { listWorkflowRuns, type WorkflowPhase, type WorkflowRun } from "./workflows.js";

/** Sentinel owner id for nodes launched directly from the main transcript. */
const MAIN_OWNER = "main";

const PROMPT_PREVIEW_LIMIT = 500;
/** Cap for `SubagentNode.returnedPreview` — matches the parser's own tool-result capture cap. */
const RETURNED_PREVIEW_LIMIT = 2000;

/**
 * One Workflow-tool run's session-level summary — the run-state metadata
 * (`workflows/<runId>.json`, see `workflows.ts`) plus what only the main
 * transcript can supply (`toolUseId`/`launchLine`, resolved by matching the
 * runId against the `Workflow` tool_use's own `tool_result` text — see
 * `findWorkflowLaunch`). Deliberately carries NO usage/cost: those live only
 * on the member `SubagentNode`s (`workflowRunId`-tagged, flat among
 * `subagents`) to avoid double-counting — a run summary is a rollup INDEX,
 * not a second usage-bearing node. `agentCount` is the number of agent
 * transcripts actually discovered for this run (`listSubagentRefs`), which
 * can be less than the run state's own `agentCount` for a still-running or
 * partially-synced run.
 */
export interface ClaudeWorkflowRunSummary {
  runId: string;
  name?: string;
  status?: string;
  durationMs?: number;
  phases: WorkflowPhase[];
  agentCount: number;
  /** tool_use id of the `Workflow` call that launched this run, when it can be matched in the main transcript. */
  toolUseId?: string;
  /** Source line of that same tool_use. */
  launchLine?: number;
}

/**
 * Claude Code session analysis — `SessionAnalysisCore` plus everything that
 * only makes sense for a Claude Code transcript (subagent trees, per-tool
 * breakdowns, task executions, ...). See `../shared/session-analysis.ts` for
 * the shared-core rationale (incl. why `fileAccess`/`skillInvocations` live
 * there rather than here) and `CodexSessionAnalysis` for the other variant.
 */
export interface ClaudeSessionAnalysis extends SessionAnalysisCore {
  source: "claude-code";
  projectDirName: string;
  version?: string;
  apiMessageCount: number;
  apiErrorCount: number;
  /** Capped list backing apiErrorCount — see `ApiErrorLogEntry`. Main transcript only. */
  apiErrors: ApiErrorLogEntry[];
  /** Per-turn token composition, main transcript only — see `ClaudeTurnUsage`. */
  turnUsage: ClaudeTurnUsage[];
  toolStats: ToolStat[];
  repetitions: RepetitionFinding[];
  exploration: ExplorationProfile;
  taskExecutions: TaskExecutionInfo[];
  subagents: SubagentNode[];
  subagentCount: number;
  /** Every Workflow-tool run recorded for this session — see `ClaudeWorkflowRunSummary`. */
  workflowRuns: ClaudeWorkflowRunSummary[];
}

/** Analyze one session file, including its subagent sidecar transcripts. */
export async function analyzeClaudeSession(filePath: string): Promise<ClaudeSessionAnalysis> {
  const transcript = await parseClaudeTranscriptFile(filePath);
  const data = buildSessionData(transcript);
  const sessionId = basename(filePath, ".jsonl");
  const projectDirName = basename(dirname(filePath));

  const { subagents, subagentCount, subagentTotals, subagentFileAccess, workflowRuns } =
    await analyzeSubagents(filePath, data);
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
  const totalUsageByModel = mergeUsageByModel(usage.byModel, subagents);

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
  const { repoRoot, worktreeName } = deriveRepoIdentity(data.cwd);

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
    totalUsageByModel,
    delegation: computeDelegationSummary(usage, totalUsage, totalUsageByModel),
    contextTimeline: computeContextTimeline(data),
    compactions: data.compactions,
    apiErrorCount: data.apiErrorCount,
    apiErrors: data.apiErrors,
    turnUsage: computeTurnUsage(data),
    toolStats: computeToolStats(data),
    toolCallCount: data.toolCalls.length,
    toolErrorCount: data.toolCalls.filter((c) => c.result?.isError === true).length,
    repetitions: computeRepetitions(data),
    exploration: computeExploration(data),
    taskExecutions: computeTaskExecutions(data),
    fileAccess,
    fileAccessTruncated,
    ...(fileAccessOmittedCount !== undefined && { fileAccessOmittedCount }),
    skillInvocations: computeSkillInvocations(data),
    subagents,
    subagentCount,
    workflowRuns,
    parseWarningCount: data.warningCount,
    ...(data.cwd !== undefined && { cwd: data.cwd }),
    ...(repoRoot !== undefined && { repoRoot }),
    ...(worktreeName !== undefined && { worktreeName }),
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
  workflowRuns: ClaudeWorkflowRunSummary[];
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

  const [refs, workflowRuns] = await Promise.all([
    listSubagentRefs(filePath),
    listWorkflowRuns(filePath),
  ]);
  const workflowRunSummaries = buildWorkflowRunSummaries(workflowRuns, refs, mainData);
  const workflowRunsById = new Map(workflowRuns.map((r) => [r.runId, r]));

  if (refs.length === 0) {
    return {
      subagents: [],
      subagentCount: 0,
      subagentTotals,
      subagentFileAccess,
      workflowRuns: workflowRunSummaries,
    };
  }

  const nodes = new Map<string, SubagentNode>();
  /** toolUseId -> id ("main" or an agentId) of the transcript that issued that tool call. */
  const toolUseOwner = new Map<string, string>();
  /** owner id -> that transcript's own tool calls, keyed by toolUseId — lets us find the
   *  launching Agent/Task call's `result` (returnedChars/launchLine/launchedAt) the same
   *  way `buildClaudeTimeline` does, just across the whole subagent forest instead of one transcript. */
  const toolCallsByOwner = new Map<string, Map<string, ToolCall>>();
  /** tool_use ids whose result is only an async-launch ack, across every transcript. */
  const asyncLaunchIds = new Set<string>();
  /** agentId -> spawning tool_use id, recovered from parent-side `toolUseResult.agentId` —
   *  fallback linkage for sidecars whose meta.json lacks `toolUseId`. */
  const toolUseIdByAgentId = new Map<string, string>();
  /** owner id -> that transcript's own background launches — the async-launch half of
   *  `SubagentNode.status`'s evidence: joins a node's `toolUseId` to a `taskId`. */
  const backgroundLaunchesByOwner = new Map<string, readonly BackgroundLaunch[]>();
  /** owner id -> that transcript's own task-notifications — the OWNER's transcript is what
   *  receives a background task's completion notice, not the child's own sidecar, so status
   *  for an async launch is resolved from the SAME owner as the launch itself. */
  const taskNotificationsByOwner = new Map<string, readonly TaskNotificationEvent[]>();

  const registerOwner = (ownerId: string, data: SessionData) => {
    toolCallsByOwner.set(ownerId, new Map(data.toolCalls.map((c) => [c.toolUseId, c])));
    for (const call of data.toolCalls) toolUseOwner.set(call.toolUseId, ownerId);
    for (const id of asyncAgentLaunchToolUseIds(data)) asyncLaunchIds.add(id);
    for (const [agentId, toolUseId] of agentLaunchToolUseIds(data)) {
      if (!toolUseIdByAgentId.has(agentId)) toolUseIdByAgentId.set(agentId, toolUseId);
    }
    backgroundLaunchesByOwner.set(ownerId, data.backgroundLaunches);
    taskNotificationsByOwner.set(ownerId, data.taskNotifications);
  };
  registerOwner(MAIN_OWNER, mainData);

  for (const { agentId, jsonlPath, meta, workflowRunId } of refs) {
    const transcript = await parseClaudeTranscriptFile(jsonlPath);
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

    // Transcript's own `message.model` — NEVER the workflow run-state's
    // `workflowProgress[].model`, which can carry harness decorations (e.g.
    // `claude-opus-4-8[1m]`) the transcript's own field never does.
    const model = data.apiMessages.find((m) => m.model !== undefined)?.model;
    const promptPreview = data.userPrompts[0]?.text.slice(0, PROMPT_PREVIEW_LIMIT);
    const toolErrorCount = data.toolCalls.filter((c) => c.result?.isError === true).length;
    const workflowProgress =
      workflowRunId !== undefined
        ? workflowRunsById.get(workflowRunId)?.agents.get(agentId)
        : undefined;

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
      ...(workflowRunId !== undefined && { workflowRunId }),
      ...(workflowProgress?.label !== undefined && { workflowLabel: workflowProgress.label }),
      ...(workflowProgress?.phaseTitle !== undefined && {
        workflowPhase: workflowProgress.phaseTitle,
      }),
      ...(workflowProgress?.queuedAt !== undefined && {
        queuedAt: new Date(workflowProgress.queuedAt).toISOString(),
      }),
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
    Object.assign(
      node,
      launchLinkage(
        node,
        ownerId,
        toolCallsByOwner,
        asyncLaunchIds,
        backgroundLaunchesByOwner,
        taskNotificationsByOwner,
      ),
    );
    // Workflow agents have no per-agent Agent/Task tool_use of their own (one
    // `Workflow` call spawns the whole batch), so `launchLinkage` above always
    // leaves them "unresolved". Override from the run-state's own progress
    // entry instead — the ONLY evidence source that exists for these agents.
    if (node.workflowRunId !== undefined) {
      const progress = workflowRunsById.get(node.workflowRunId)?.agents.get(node.agentId);
      const resolved = resolveWorkflowAgentStatus(progress?.state);
      if (resolved !== undefined) node.status = resolved;
    }
  }
  const byStart = (a: SubagentNode, b: SubagentNode) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  for (const node of nodes.values()) node.children.sort(byStart);
  roots.sort(byStart);

  return {
    subagents: roots,
    subagentCount: nodes.size,
    subagentTotals,
    subagentFileAccess,
    workflowRuns: workflowRunSummaries,
  };
}

/**
 * Build the session-level `ClaudeWorkflowRunSummary` list from every parsed
 * run-state file, cross-referenced against the discovered agent refs (for
 * `agentCount`) and the main transcript (for `toolUseId`/`launchLine`).
 * Independent of whether any agents were actually discovered for a run — a
 * run-state file with zero matching sidecars still gets a summary entry,
 * just with `agentCount: 0`.
 */
function buildWorkflowRunSummaries(
  workflowRuns: readonly WorkflowRun[],
  refs: readonly SubagentRef[],
  mainData: SessionData,
): ClaudeWorkflowRunSummary[] {
  if (workflowRuns.length === 0) return [];

  const agentCountByRunId = new Map<string, number>();
  for (const ref of refs) {
    if (ref.workflowRunId === undefined) continue;
    agentCountByRunId.set(ref.workflowRunId, (agentCountByRunId.get(ref.workflowRunId) ?? 0) + 1);
  }

  return workflowRuns.map((run) => {
    const launch = findWorkflowLaunch(mainData, run.runId);
    return {
      runId: run.runId,
      ...(run.workflowName !== undefined && { name: run.workflowName }),
      ...(run.status !== undefined && { status: run.status }),
      ...(run.durationMs !== undefined && { durationMs: run.durationMs }),
      phases: run.phases,
      agentCount: agentCountByRunId.get(run.runId) ?? 0,
      ...(launch !== undefined && { toolUseId: launch.toolUseId, launchLine: launch.line }),
    };
  });
}

/**
 * Find the `Workflow` tool_use in the MAIN transcript whose parent-side
 * `tool_result` text mentions this run id. This is the only place a runId
 * round-trips back to a specific tool_use: workflow agents' meta.json never
 * carries a `toolUseId` (unlike classic Agent/Task launches), and a session
 * can invoke `Workflow` more than once (e.g. resuming after editing the
 * script), so matching is done PER RUN ID rather than assuming a single
 * `Workflow` call exists.
 */
function findWorkflowLaunch(
  mainData: SessionData,
  runId: string,
): { toolUseId: string; line: number } | undefined {
  const call = mainData.toolCalls.find(
    (c) => c.name === "Workflow" && c.result?.text.includes(runId) === true,
  );
  return call === undefined ? undefined : { toolUseId: call.toolUseId, line: call.line };
}

/**
 * Map a workflow run-state `workflow_agent` progress entry's `state` to
 * `SubagentStatus` — the only status evidence that exists for a
 * Workflow-spawned agent (see the override site in `analyzeSubagents`
 * above). `"done"` -> completed; anything error/failure/cancellation-shaped
 * -> failed; every other value (queued, running, ...) -> `undefined`, which
 * leaves the node's existing "unresolved" status untouched rather than
 * guessing.
 */
function resolveWorkflowAgentStatus(state: string | undefined): SubagentStatus | undefined {
  if (state === undefined) return undefined;
  if (state === "done") return "completed";
  if (/error|fail|cancel/i.test(state)) return "failed";
  return undefined;
}

/**
 * `SubagentNode.status`, resolved from the SAME launch evidence
 * `launchLinkage` already located for this node (same owner transcript, same
 * toolUseId) — see `SubagentStatus`'s doc comment for what counts as
 * evidence. Nested subagents (spawned by another subagent) get this right
 * for free: `spawnedBy`/`toolCallsByOwner` already resolve to whichever
 * transcript actually issued the launch, so `backgroundLaunchesByOwner`/
 * `taskNotificationsByOwner` looked up by that same `spawnedBy` key are the
 * correct per-transcript data, not always the main transcript's.
 *
 *  - No `toolUseId` at all -> "unresolved" (nothing to look up).
 *  - Async launch: join `toolUseId` -> that owner's matching `BackgroundLaunch`
 *    -> its `taskId` -> the LAST task-notification for that taskId in the
 *    SAME owner's transcript (the owner is who receives the notification,
 *    never the child's own sidecar) -> `backgroundStatus` (shared with
 *    `computeTaskExecutions`). No matching launch or notification ->
 *    "unresolved".
 *  - Sync launch: the launching call's `result` present -> `isError` picks
 *    completed/failed; absent -> "unresolved".
 */
function resolveNodeStatus(
  toolUseId: string | undefined,
  asyncLaunch: boolean,
  launchCall: ToolCall | undefined,
  spawnedBy: string,
  backgroundLaunchesByOwner: ReadonlyMap<string, readonly BackgroundLaunch[]>,
  taskNotificationsByOwner: ReadonlyMap<string, readonly TaskNotificationEvent[]>,
): SubagentStatus {
  if (toolUseId === undefined) return "unresolved";
  if (asyncLaunch) {
    const launch = backgroundLaunchesByOwner
      .get(spawnedBy)
      ?.find((candidate) => candidate.toolUseId === toolUseId);
    if (launch === undefined) return "unresolved";
    // Last notification for that taskId wins (an agent can notify more than
    // once) — same rule `computeTaskExecutions` applies.
    let lastNotification: TaskNotificationEvent | undefined;
    for (const notification of taskNotificationsByOwner.get(spawnedBy) ?? []) {
      if (notification.taskId === launch.taskId) lastNotification = notification;
    }
    const status = backgroundStatus(lastNotification);
    return status === "completed" || status === "failed" ? status : "unresolved";
  }
  if (launchCall?.result === undefined) return "unresolved";
  return launchCall.result.isError ? "failed" : "completed";
}

/**
 * Resolve a node's launch-side metadata (returnedChars/asyncLaunch/launchLine/
 * launchedAt/spawnedBy/status) from the launching Agent/Task tool call, found
 * in whichever transcript owns it (main, or a parent subagent). Falls back to
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
  backgroundLaunchesByOwner: ReadonlyMap<string, readonly BackgroundLaunch[]>,
  taskNotificationsByOwner: ReadonlyMap<string, readonly TaskNotificationEvent[]>,
): Pick<
  SubagentNode,
  | "returnedChars"
  | "returnedPreview"
  | "asyncLaunch"
  | "launchLine"
  | "launchedAt"
  | "spawnedBy"
  | "status"
> {
  const spawnedBy = ownerId ?? MAIN_OWNER;
  const asyncLaunch = node.toolUseId !== undefined && asyncLaunchIds.has(node.toolUseId);
  const launchCall =
    node.toolUseId !== undefined ? toolCallsByOwner.get(spawnedBy)?.get(node.toolUseId) : undefined;
  const status = resolveNodeStatus(
    node.toolUseId,
    asyncLaunch,
    launchCall,
    spawnedBy,
    backgroundLaunchesByOwner,
    taskNotificationsByOwner,
  );
  if (launchCall === undefined) {
    return { spawnedBy, status, ...(asyncLaunch && { asyncLaunch }) };
  }
  const returnedChars = asyncLaunch ? undefined : toolResultLength(launchCall);
  const returnedPreview = asyncLaunch
    ? undefined
    : launchCall.result?.text.slice(0, RETURNED_PREVIEW_LIMIT);
  return {
    spawnedBy,
    status,
    launchLine: launchCall.line,
    ...(asyncLaunch && { asyncLaunch }),
    ...(returnedChars !== undefined && { returnedChars }),
    ...(returnedPreview !== undefined && { returnedPreview }),
    ...(launchCall.timestamp !== undefined &&
      launchCall.timestamp !== node.startedAt && { launchedAt: launchCall.timestamp }),
  };
}
