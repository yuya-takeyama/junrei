/**
 * Parsing for Claude Code's Workflow tool run-state files —
 * `<sessionDir>/workflows/<runId>.json` — the rich per-run metadata sitting
 * alongside (but structurally separate from) the agent transcripts under
 * `<sessionDir>/subagents/workflows/<runId>/` (see `subagents.ts`'s
 * `listSubagentRefs` for those).
 *
 * A run's state file carries far more than what's modeled here (`script`,
 * `scriptPath`, `logs`, `result`, `summary`, `totalTokens`,
 * `totalToolCalls`, ...) — only the fields `analyze.ts` actually needs are
 * extracted. `workflowProgress` mixes `workflow_phase` and `workflow_agent`
 * entries; only the latter are kept here (phase entries are redundant with
 * the run's own `phases` array, which additionally carries `detail`).
 *
 * Every parse step is tolerant by design: a missing `workflows/` dir yields
 * `[]`; one corrupt/malformed run-state file is skipped (not fatal to the
 * rest); a file lacking even `runId` is dropped as unusable. Never throws.
 *
 * Discovery goes through a `ClaudeSessionStore` (`store.ts`) rather than
 * `node:fs` directly, so it works the same whether `mainFilePath` is a local
 * path or an S3-backed store's URI — see `subagents.ts`'s doc comment for the
 * same rationale.
 */

import { dirname } from "node:path";
import { workflowsDirFor } from "./paths.js";
import { type ClaudeSessionStore, localClaudeSessionStore } from "./store.js";

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

/** One agent's entry from a run's `workflowProgress` array (`type: "workflow_agent"` only). */
export interface WorkflowAgentProgress {
  agentId: string;
  label?: string;
  phaseTitle?: string;
  phaseIndex?: number;
  /**
   * Model as recorded by the workflow harness — can carry decorations (e.g.
   * `claude-opus-4-8[1m]`) that the transcript's own `message.model` never
   * does. Kept for reference only; billing/model-badge fields elsewhere
   * ALWAYS prefer the transcript's own model (see `analyze.ts`).
   */
  model?: string;
  state?: string;
  /** Epoch ms — when this agent was queued to run (can precede `startedAt`). */
  queuedAt?: number;
  /** Epoch ms — when this agent actually started running. */
  startedAt?: number;
  promptPreview?: string;
}

/** One Workflow-tool run's state, as parsed from `workflows/<runId>.json`. */
export interface WorkflowRun {
  runId: string;
  /** Absolute path to the run-state file — provenance, and used for mtime checks (e.g. liveness). */
  filePath: string;
  workflowName?: string;
  status?: string;
  /**
   * Verbatim from the run-state file — equals `timestamp - startTime` of the
   * FINAL Workflow invocation recorded in this file (verified against a real
   * killed-and-resumed run: session 87da72a3-5ecf-4688-8ff8-3ff833be7013, run
   * wf_9bbab5e3-d95 "pr1-core-mcp"). When a run is killed/interrupted and
   * later resumed reusing the same runId, the harness OVERWRITES this file
   * and `startTime` resets to the resumed invocation's own start — so this
   * field then covers only the LAST execution segment, not the run's full
   * lifetime. It can be far shorter than the run's true member span (that
   * session: 275223ms/4m35s here vs. a single member spanning 22m14s, full
   * run span ~45m43s). This is NOT the wall-clock span of the run's agents —
   * consumers wanting that should derive it from the member subagents'
   * `startedAt`/`endedAt` instead (see `@junrei/web`'s
   * `agentTree.ts:memberSpanDurationMs`).
   */
  durationMs?: number;
  phases: WorkflowPhase[];
  /** agentId -> that agent's `workflow_agent` progress entry. */
  agents: Map<string, WorkflowAgentProgress>;
}

export { workflowsDirFor } from "./paths.js";

/**
 * List every Workflow-tool run recorded for a session, parsed from
 * `workflows/*.json` (the `scripts/` subdirectory holds `.js` files, and
 * anything not a DIRECT child of `workflows/` is skipped — both by checking
 * `dirname` against the workflows dir itself, not just the `.json` filter).
 * Missing directory -> `[]`; a corrupt/unreadable/unusable individual file is
 * skipped, never fatal.
 */
export async function listWorkflowRuns(
  mainFilePath: string,
  store: ClaudeSessionStore = localClaudeSessionStore,
): Promise<WorkflowRun[]> {
  const dir = workflowsDirFor(mainFilePath);
  const sidecarFiles = await store.listSidecarFiles(mainFilePath);

  const runs: WorkflowRun[] = [];
  for (const { path: filePath } of sidecarFiles) {
    if (dirname(filePath) !== dir || !filePath.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await store.readFile(filePath));
    } catch {
      continue;
    }
    const run = parseWorkflowRun(raw, filePath);
    if (run !== undefined) runs.push(run);
  }
  return runs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflowRun(raw: unknown, filePath: string): WorkflowRun | undefined {
  if (!isRecord(raw)) return undefined;
  const runId = typeof raw.runId === "string" ? raw.runId : undefined;
  if (runId === undefined) return undefined;

  const phases: WorkflowPhase[] = [];
  if (Array.isArray(raw.phases)) {
    for (const entry of raw.phases) {
      if (!isRecord(entry) || typeof entry.title !== "string") continue;
      phases.push({
        title: entry.title,
        ...(typeof entry.detail === "string" && { detail: entry.detail }),
      });
    }
  }

  const agents = new Map<string, WorkflowAgentProgress>();
  if (Array.isArray(raw.workflowProgress)) {
    for (const entry of raw.workflowProgress) {
      if (!isRecord(entry) || entry.type !== "workflow_agent") continue;
      const agentId = typeof entry.agentId === "string" ? entry.agentId : undefined;
      if (agentId === undefined) continue;
      agents.set(agentId, {
        agentId,
        ...(typeof entry.label === "string" && { label: entry.label }),
        ...(typeof entry.phaseTitle === "string" && { phaseTitle: entry.phaseTitle }),
        ...(typeof entry.phaseIndex === "number" && { phaseIndex: entry.phaseIndex }),
        ...(typeof entry.model === "string" && { model: entry.model }),
        ...(typeof entry.state === "string" && { state: entry.state }),
        ...(typeof entry.queuedAt === "number" && { queuedAt: entry.queuedAt }),
        ...(typeof entry.startedAt === "number" && { startedAt: entry.startedAt }),
        ...(typeof entry.promptPreview === "string" && { promptPreview: entry.promptPreview }),
      });
    }
  }

  return {
    runId,
    filePath,
    ...(typeof raw.workflowName === "string" && { workflowName: raw.workflowName }),
    ...(typeof raw.status === "string" && { status: raw.status }),
    ...(typeof raw.durationMs === "number" && { durationMs: raw.durationMs }),
    phases,
    agents,
  };
}
