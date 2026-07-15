/**
 * Shared helpers for locating and loading subagent sidecar transcripts.
 *
 * A session's subagent transcripts live at
 * `<projectDir>/<mainSessionId>/subagents/agent-<agentId>.jsonl`, each with an
 * optional `agent-<agentId>.meta.json` sibling. This module centralizes that
 * discovery so both the quantitative analysis (`analyze.ts`) and the timeline
 * (`timeline.ts`) resolve subagents the same way.
 *
 * The Workflow tool spawns a second layout one level deeper:
 * `<projectDir>/<mainSessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl`
 * (+ `.meta.json` sibling, same shape as classic sidecars — always just
 * `{"agentType":"workflow-subagent","spawnDepth":1}` in practice, plus a
 * `journal.jsonl` resume log we deliberately never treat as an agent
 * transcript). `listSubagentRefs` below scans both layouts and tags workflow
 * refs with `workflowRunId` so `analyze.ts` can enrich them from the run's
 * own state file (`claude/workflows.ts`).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseClaudeTranscriptFile } from "./parser.js";
import { buildSessionData, type SessionData } from "./session-data.js";

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  /** tool_use id of the Agent/Task call that spawned this agent. */
  toolUseId?: string;
  spawnDepth?: number;
}

export interface SubagentRef {
  agentId: string;
  jsonlPath: string;
  /** Best-effort — missing or malformed meta files yield `{}`, never throw. */
  meta: SubagentMeta;
  /** Set when this ref was discovered under `subagents/workflows/<runId>/` — the Workflow-tool layout. */
  workflowRunId?: string;
}

/** Directory containing per-agent sidecar transcripts for a main session file. */
export function subagentsDirFor(mainFilePath: string): string {
  const sessionId = basename(mainFilePath, ".jsonl");
  return join(dirname(mainFilePath), sessionId, "subagents");
}

/** One level of `agent-<id>.jsonl` (+ optional `.meta.json` sibling) discovery, shared by both layouts. */
async function scanAgentDir(
  dir: string,
): Promise<Array<{ agentId: string; jsonlPath: string; meta: SubagentMeta }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const refs: Array<{ agentId: string; jsonlPath: string; meta: SubagentMeta }> = [];
  for (const entry of entries) {
    const match = /^agent-(.+)\.jsonl$/.exec(entry);
    if (match === null || match[1] === undefined) continue;
    const agentId = match[1];

    let meta: SubagentMeta = {};
    try {
      meta = JSON.parse(
        await readFile(join(dir, `agent-${agentId}.meta.json`), "utf8"),
      ) as SubagentMeta;
    } catch {
      // Meta file is optional.
    }
    refs.push({ agentId, jsonlPath: join(dir, entry), meta });
  }
  return refs;
}

/**
 * List every subagent sidecar transcript for a session, with parsed meta
 * (best-effort) — both classic top-level sidecars and Workflow-tool agents
 * nested one level deeper under `subagents/workflows/<runId>/` (tagged with
 * `workflowRunId`). Missing directories at any level yield `[]`, never throw.
 */
export async function listSubagentRefs(mainFilePath: string): Promise<SubagentRef[]> {
  const subagentsDir = subagentsDirFor(mainFilePath);
  const refs: SubagentRef[] = await scanAgentDir(subagentsDir);

  const workflowsDir = join(subagentsDir, "workflows");
  let runIds: string[];
  try {
    runIds = await readdir(workflowsDir);
  } catch {
    return refs;
  }

  for (const runId of runIds) {
    const runDir = join(workflowsDir, runId);
    try {
      if (!(await stat(runDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const ref of await scanAgentDir(runDir)) {
      refs.push({ ...ref, workflowRunId: runId });
    }
  }
  return refs;
}

/**
 * Parse + structure one subagent's transcript by agent id. `undefined` if it
 * can't be read. Tries the classic top-level sidecar path directly first
 * (the common case, no directory scan needed); falls back to a full
 * `listSubagentRefs` scan — which also covers `subagents/workflows/<runId>/`
 * — only when that direct path doesn't exist, so Workflow-tool agents
 * resolve too without paying the scan cost for ordinary sidecars.
 */
export async function loadSubagentSessionData(
  mainFilePath: string,
  agentId: string,
): Promise<SessionData | undefined> {
  const directPath = join(subagentsDirFor(mainFilePath), `agent-${agentId}.jsonl`);
  try {
    const transcript = await parseClaudeTranscriptFile(directPath);
    return buildSessionData(transcript);
  } catch {
    // Not a classic top-level sidecar — fall through to the full scan below.
  }

  const ref = (await listSubagentRefs(mainFilePath)).find((r) => r.agentId === agentId);
  if (ref === undefined) return undefined;
  try {
    const transcript = await parseClaudeTranscriptFile(ref.jsonlPath);
    return buildSessionData(transcript);
  } catch {
    return undefined;
  }
}
