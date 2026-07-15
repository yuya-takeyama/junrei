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
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  durationMs?: number;
  phases: WorkflowPhase[];
  /** agentId -> that agent's `workflow_agent` progress entry. */
  agents: Map<string, WorkflowAgentProgress>;
}

/** Directory containing per-run state files for a main session file. */
export function workflowsDirFor(mainFilePath: string): string {
  const sessionId = basename(mainFilePath, ".jsonl");
  return join(dirname(mainFilePath), sessionId, "workflows");
}

/**
 * List every Workflow-tool run recorded for a session, parsed from
 * `workflows/*.json` (the `scripts/` subdirectory holds `.js` files and is
 * skipped by the `.json` filter alone). Missing directory -> `[]`; a
 * corrupt/unreadable/unusable individual file is skipped, never fatal.
 */
export async function listWorkflowRuns(mainFilePath: string): Promise<WorkflowRun[]> {
  const dir = workflowsDirFor(mainFilePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const runs: WorkflowRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8"));
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
