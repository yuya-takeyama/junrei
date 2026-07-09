import type { ContextPoint, ModelUsageSummary, TokenTotals, UsageSummary } from "../metrics.js";
import { mergeFileAccess } from "../metrics.js";
import { estimateCostComponents } from "../pricing/pricing.js";
import { deriveRepoIdentity } from "../repo.js";
import type { SessionAnalysisCore } from "../session-analysis.js";
import type { CompactionEvent } from "../session-data.js";
import type { TokenUsage } from "../types.js";
import type { CodexSessionFileRef } from "./discovery.js";
import { computeCodexFileAccess, computeCodexSkillInvocations } from "./files-skills.js";
import type {
  CodexRecord,
  CodexSessionMetaRecord,
  CodexTokenUsageRaw,
  CodexTranscript,
} from "./parser.js";

export type { CodexRecord } from "./parser.js";

const PROMPT_PREVIEW_LIMIT = 500;

// Codex injects context (AGENTS.md, user/environment instructions) as
// role:"user" response_items; only real human input should count as a prompt.
const SYNTHETIC_USER_TEXT_PREFIXES = [
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<environment_context>",
  "<ENVIRONMENT_CONTEXT>",
];

/** Exported for reuse by `codex/timeline.ts`'s user-prompt fallback (same injected-context rule). */
export function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_USER_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Per-turn token composition & duration — Codex's analog of the Claude `TurnUsage`. */
export interface CodexTurnUsage {
  turnId?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Fresh (uncached) input tokens — `input_tokens - cached_input_tokens`, floored at 0. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
}

/**
 * One `collab_agent_spawn_end` event on this session's own rollout — this
 * session spawned a sub-agent thread. `orchestration.ts` matches these
 * against a candidate child's own `sessionId` (== the sub-agent's own
 * `session_meta.id`) to recover `toolUseId`/`launchLine`/`launchedAt` for the
 * `SubagentNode` it builds.
 */
export interface CodexSpawnedThread {
  /** The spawned sub-agent's own thread/session id. */
  threadId: string;
  callId?: string;
  nickname?: string;
  role?: string;
  /** Source line of the `collab_agent_spawn_end` event in this session's own rollout. */
  line: number;
  timestamp?: string;
}

/** Codex-only detail, not shared with the Claude Code variant — see `session-analysis.ts`. */
export interface CodexSessionExtras {
  originator?: string;
  cliVersion?: string;
  archived: boolean;
  parentThreadId?: string;
  forkedFromId?: string;
  agentRole?: string;
  agentNickname?: string;
  /**
   * True when `session_meta` marks this thread as a sub-agent — either
   * `source.subagent` was present in any variant, or a `parentThreadId` was
   * resolved (from either location) even without an explicit source marker.
   */
  isSubagent: boolean;
  /** `source.subagent.thread_spawn.depth`, when the wire payload carried one. */
  subagentDepth?: number;
  /** Every `collab_agent_spawn_end` this session's own rollout recorded — see `CodexSpawnedThread`. */
  spawnedThreadIds: CodexSpawnedThread[];
  /** Sum of `reasoning_output_tokens` across every `last_token_usage` delta. */
  reasoningOutputTokens: number;
  /** Latest `token_count` event's `rate_limits` snapshot, passed through as-is. */
  rateLimits?: unknown;
  turns: CodexTurnUsage[];
  /** `function_call` + `custom_tool_call` + `local_shell_call` response items. */
  toolCallCount: number;
  /** Best-effort — see the heuristics in `linkToolCalls` below. */
  toolErrorCount: number;
}

export interface CodexSessionAnalysis extends SessionAnalysisCore {
  source: "codex";
  codex: CodexSessionExtras;
}

interface ModelAccumulator {
  model: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function addUsage(acc: ModelAccumulator, delta: CodexTokenUsageRaw): void {
  acc.messageCount += 1;
  acc.inputTokens += Math.max(0, delta.inputTokens - delta.cachedInputTokens);
  acc.outputTokens += delta.outputTokens;
  acc.cacheReadTokens += delta.cachedInputTokens;
  // Codex reports no cache-write concept — every prompt token is either fresh or a cache hit.
  acc.cacheCreationTokens += 0;
}

function buildUsageSummary(accumulators: ReadonlyMap<string, ModelAccumulator>): UsageSummary {
  const byModel: ModelUsageSummary[] = [];
  const total: UsageSummary["total"] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    cacheWriteCostUsd: 0,
    costIsComplete: true,
  };
  for (const acc of accumulators.values()) {
    const usage: TokenUsage = {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
    };
    const cost = estimateCostComponents(acc.model, usage);
    byModel.push({
      model: acc.model,
      messageCount: acc.messageCount,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      ...(cost !== undefined && {
        costUsd: cost.totalCost,
        cacheWriteCostUsd: cost.cacheCreationCost,
      }),
    });
    total.inputTokens += acc.inputTokens;
    total.outputTokens += acc.outputTokens;
    total.cacheReadTokens += acc.cacheReadTokens;
    total.cacheCreationTokens += acc.cacheCreationTokens;
    if (cost !== undefined) {
      total.costUsd += cost.totalCost;
      total.cacheWriteCostUsd = (total.cacheWriteCostUsd ?? 0) + cost.cacheCreationCost;
    } else {
      total.costIsComplete = false;
    }
  }
  return { byModel, total };
}

const ERROR_OUTPUT_PATTERN = /exited with code [1-9]/i;

/**
 * Whether a `function_call_output` / `custom_tool_call_output` text reads as
 * an error: a structured `{success:false}` flag, or output text matching
 * "exited with code <nonzero>". Exported so `codex/timeline.ts` applies the
 * exact same rule when linking a tool-call entry to its result, rather than
 * re-deriving the heuristic.
 */
export function isCodexToolOutputError(success: boolean | undefined, text: string): boolean {
  return success === false || ERROR_OUTPUT_PATTERN.test(text);
}

/**
 * Best-effort tool-call linkage: `function_call` / `custom_tool_call` /
 * `local_shell_call` response items opened by `call_id`, resolved by their
 * matching `*_output` response item or (for shell calls) `exec_command_end`
 * event. A call counts as errored on any of: a structured `{success:false}`
 * output, an output whose text matches "exited with code <nonzero>", or a
 * matching `exec_command_end` with a nonzero `exit_code` — whichever signal
 * arrives first wins, deduped by `call_id` so a call is never double-counted.
 */
function linkToolCalls(records: readonly CodexRecord[]): { callCount: number; errorCount: number } {
  const callIds = new Set<string>();
  const erroredCallIds = new Set<string>();

  for (const record of records) {
    if (record.type === "responseItem") {
      const item = record.item;
      switch (item.kind) {
        case "functionCall":
        case "customToolCall":
          callIds.add(item.callId);
          break;
        case "localShellCall":
          if (item.callId !== undefined) callIds.add(item.callId);
          break;
        case "functionCallOutput":
        case "customToolCallOutput":
          if (isCodexToolOutputError(item.success, item.text)) {
            erroredCallIds.add(item.callId);
          }
          break;
        default:
          break;
      }
    } else if (record.type === "eventMsg" && record.event.kind === "execCommandEnd") {
      if (record.event.exitCode !== undefined && record.event.exitCode !== 0) {
        erroredCallIds.add(record.event.callId);
      }
    }
  }

  let errorCount = 0;
  for (const callId of erroredCallIds) {
    if (callIds.has(callId)) errorCount += 1;
  }
  return { callCount: callIds.size, errorCount };
}

interface OpenTurn {
  usage: CodexTurnUsage;
  accumulator: ModelAccumulator;
}

/** Analyze one Codex rollout transcript (must already be `format: "current"` — see `parseCodexTranscriptFile`). */
export function analyzeCodexSession(
  ref: CodexSessionFileRef,
  transcript: CodexTranscript,
): CodexSessionAnalysis {
  let sessionMeta: CodexSessionMetaRecord | undefined;
  let title: string | undefined;
  const models: string[] = [];
  const modelAccumulators = new Map<string, ModelAccumulator>();
  const contextTimeline: ContextPoint[] = [];
  const compactions: CompactionEvent[] = [];
  const turns: CodexTurnUsage[] = [];
  const spawnedThreadIds: CodexSpawnedThread[] = [];

  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let firstUserPrompt: string | undefined;
  let firstUserPromptLine: number | undefined;
  let fallbackFirstUserPrompt: string | undefined;
  let fallbackFirstUserPromptLine: number | undefined;
  let eventUserMessageCount = 0;
  let fallbackUserMessageCount = 0;
  let reasoningOutputTokens = 0;
  let rateLimits: unknown;
  let previousCumulative: CodexTokenUsageRaw | undefined;

  let currentModel = "unknown";
  let openTurn: OpenTurn | undefined;

  const openTurnFor = (
    model: string,
    turnId: string | undefined,
    timestamp: string | undefined,
  ) => {
    let acc = modelAccumulators.get(model);
    if (acc === undefined) {
      acc = {
        model,
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      modelAccumulators.set(model, acc);
    }
    const usage: CodexTurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: 0,
      ...(turnId !== undefined && { turnId }),
      ...(model !== "unknown" && { model }),
      ...(timestamp !== undefined && { startedAt: timestamp }),
    };
    turns.push(usage);
    openTurn = { usage, accumulator: acc };
  };

  for (const record of transcript.records) {
    if (record.timestamp !== undefined) {
      firstTimestamp ??= record.timestamp;
      lastTimestamp = record.timestamp;
    }

    switch (record.type) {
      case "sessionMeta": {
        sessionMeta ??= record;
        break;
      }
      case "turnContext": {
        currentModel = record.model ?? currentModel;
        if (record.model !== undefined && !models.includes(record.model)) {
          models.push(record.model);
        }
        openTurnFor(currentModel, record.turnId, record.timestamp);
        break;
      }
      case "eventMsg": {
        const event = record.event;
        switch (event.kind) {
          case "tokenCount": {
            if (event.rateLimits !== undefined) rateLimits = event.rateLimits;
            if (event.info === undefined) break;
            // Codex re-emits token_count with an unchanged cumulative total
            // (rate-limit refreshes, turn boundaries); summing the repeated
            // last_token_usage would double-count those tokens.
            const cumulative = event.info.totalTokenUsage;
            if (
              previousCumulative !== undefined &&
              cumulative.totalTokens === previousCumulative.totalTokens &&
              cumulative.inputTokens === previousCumulative.inputTokens &&
              cumulative.cachedInputTokens === previousCumulative.cachedInputTokens &&
              cumulative.outputTokens === previousCumulative.outputTokens &&
              cumulative.reasoningOutputTokens === previousCumulative.reasoningOutputTokens
            ) {
              break;
            }
            previousCumulative = cumulative;
            const delta = event.info.lastTokenUsage;
            if (openTurn === undefined) openTurnFor(currentModel, undefined, record.timestamp);
            const active = openTurn as OpenTurn;
            addUsage(active.accumulator, delta);
            active.usage.inputTokens += Math.max(0, delta.inputTokens - delta.cachedInputTokens);
            active.usage.outputTokens += delta.outputTokens;
            active.usage.cacheReadTokens += delta.cachedInputTokens;
            active.usage.reasoningOutputTokens += delta.reasoningOutputTokens;
            reasoningOutputTokens += delta.reasoningOutputTokens;
            contextTimeline.push({
              messageId: `codex-L${String(record.line)}`,
              line: record.line,
              contextTokens: event.info.totalTokenUsage.totalTokens,
              outputTokens: delta.outputTokens,
              ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            });
            break;
          }
          case "userMessage": {
            eventUserMessageCount += 1;
            if (firstUserPrompt === undefined && event.text !== undefined) {
              firstUserPrompt = event.text.slice(0, PROMPT_PREVIEW_LIMIT);
              firstUserPromptLine = record.line;
            }
            break;
          }
          case "threadNameUpdated": {
            title = event.threadName;
            break;
          }
          case "collabSpawnEnd": {
            spawnedThreadIds.push({
              threadId: event.newThreadId,
              line: record.line,
              ...(event.callId !== undefined && { callId: event.callId }),
              ...(event.newAgentNickname !== undefined && { nickname: event.newAgentNickname }),
              ...(event.newAgentRole !== undefined && { role: event.newAgentRole }),
              ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            });
            break;
          }
          case "taskComplete": {
            if (openTurn !== undefined) {
              const active = openTurn;
              if (record.timestamp !== undefined) active.usage.endedAt = record.timestamp;
              if (event.durationMs !== undefined) {
                active.usage.durationMs = event.durationMs;
              } else if (
                active.usage.startedAt !== undefined &&
                active.usage.endedAt !== undefined
              ) {
                const delta = Date.parse(active.usage.endedAt) - Date.parse(active.usage.startedAt);
                if (Number.isFinite(delta) && delta >= 0) active.usage.durationMs = delta;
              }
              openTurn = undefined;
            }
            break;
          }
          default:
            break;
        }
        break;
      }
      case "responseItem": {
        const item = record.item;
        if (
          item.kind === "message" &&
          item.role === "user" &&
          item.text !== "" &&
          !isSyntheticUserText(item.text)
        ) {
          fallbackUserMessageCount += 1;
          if (fallbackFirstUserPrompt === undefined) {
            fallbackFirstUserPrompt = item.text.slice(0, PROMPT_PREVIEW_LIMIT);
            fallbackFirstUserPromptLine = record.line;
          }
        }
        break;
      }
      case "compacted": {
        compactions.push({
          line: record.line,
          ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
        });
        break;
      }
      default:
        break;
    }
  }

  const usage = buildUsageSummary(modelAccumulators);
  const { callCount: toolCallCount, errorCount: toolErrorCount } = linkToolCalls(
    transcript.records,
  );
  // This session's own file access, "merged" with an empty sub-agent map —
  // `mergeFileAccess` still does the useful work here (sorting + the
  // 500-path cap), and `threads` naturally comes out "main" since there's
  // nothing to fold in yet. `getCodexSession` (server) re-derives the real
  // merged view once it knows this session's descendant sub-agent threads —
  // see `mergeCodexFileAccess`.
  const { fileAccess, fileAccessTruncated, fileAccessOmittedCount } = mergeFileAccess(
    computeCodexFileAccess(transcript),
    new Map(),
  );
  const skillInvocations = computeCodexSkillInvocations(transcript);
  const userTurnCount =
    eventUserMessageCount > 0 ? eventUserMessageCount : fallbackUserMessageCount;
  if (firstUserPrompt === undefined) {
    firstUserPrompt = fallbackFirstUserPrompt;
    firstUserPromptLine = fallbackFirstUserPromptLine;
  }
  const startedAt = sessionMeta?.timestamp ?? firstTimestamp;
  const durationMs =
    firstTimestamp !== undefined && lastTimestamp !== undefined
      ? Date.parse(lastTimestamp) - Date.parse(firstTimestamp)
      : undefined;
  const totalUsage: TokenTotals & { costUsd: number; costIsComplete: boolean } = {
    inputTokens: usage.total.inputTokens,
    outputTokens: usage.total.outputTokens,
    cacheReadTokens: usage.total.cacheReadTokens,
    cacheCreationTokens: usage.total.cacheCreationTokens,
    costUsd: usage.total.costUsd,
    costIsComplete: usage.total.costIsComplete,
  };

  // A thread counts as a sub-agent when session_meta said so explicitly
  // (source.subagent, any variant) OR a parentThreadId was resolved from
  // either location — some schema versions may carry the latter without the
  // former.
  const isSubagent =
    sessionMeta?.isSubagentSource === true || sessionMeta?.parentThreadId !== undefined;
  const { repoRoot, worktreeName } = deriveRepoIdentity(sessionMeta?.cwd);

  const codex: CodexSessionExtras = {
    archived: ref.archived,
    isSubagent,
    spawnedThreadIds,
    reasoningOutputTokens,
    turns,
    toolCallCount,
    toolErrorCount,
    ...(sessionMeta?.originator !== undefined && { originator: sessionMeta.originator }),
    ...(sessionMeta?.cliVersion !== undefined && { cliVersion: sessionMeta.cliVersion }),
    ...(sessionMeta?.parentThreadId !== undefined && {
      parentThreadId: sessionMeta.parentThreadId,
    }),
    ...(sessionMeta?.subagentDepth !== undefined && {
      subagentDepth: sessionMeta.subagentDepth,
    }),
    ...(sessionMeta?.forkedFromId !== undefined && { forkedFromId: sessionMeta.forkedFromId }),
    ...(sessionMeta?.agentRole !== undefined && { agentRole: sessionMeta.agentRole }),
    ...(sessionMeta?.agentNickname !== undefined && { agentNickname: sessionMeta.agentNickname }),
    ...(rateLimits !== undefined && { rateLimits }),
  };

  return {
    source: "codex",
    sessionId: sessionMeta?.sessionId ?? ref.sessionId,
    filePath: transcript.filePath,
    userTurnCount,
    models,
    usage,
    totalUsage,
    totalUsageByModel: usage.byModel,
    contextTimeline,
    compactions,
    parseWarningCount: transcript.warnings.length,
    fileAccess,
    fileAccessTruncated,
    ...(fileAccessOmittedCount !== undefined && { fileAccessOmittedCount }),
    skillInvocations,
    codex,
    ...(sessionMeta?.cwd !== undefined && { cwd: sessionMeta.cwd }),
    ...(repoRoot !== undefined && { repoRoot }),
    ...(worktreeName !== undefined && { worktreeName }),
    ...(sessionMeta?.git?.branch !== undefined && { gitBranch: sessionMeta.git.branch }),
    ...(title !== undefined && { title }),
    ...(startedAt !== undefined && { startedAt }),
    ...(lastTimestamp !== undefined && { endedAt: lastTimestamp }),
    ...(durationMs !== undefined &&
      Number.isFinite(durationMs) &&
      durationMs >= 0 && { durationMs }),
    ...(firstUserPrompt !== undefined && { firstUserPrompt }),
    ...(firstUserPromptLine !== undefined && { firstUserPromptLine }),
  };
}
