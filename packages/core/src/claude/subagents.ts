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
 *
 * All discovery here goes through a `ClaudeSessionStore` (`store.ts`) rather
 * than touching `node:fs` directly, so it works identically whether
 * `mainFilePath` is a local absolute path or an S3-backed store's
 * `s3://bucket/key` URI (see `store.ts`'s doc comment) — the store's
 * `listSidecarFiles` sweep supplies the flat file list, and the path-shape
 * matching (regex on basename, directory nesting) below is unchanged from
 * when it ran directly against `readdir`.
 */

import { basename, dirname } from "node:path";
import { parseClaudeTranscriptFile } from "./parser.js";
import { joinPath, subagentsDirFor } from "./paths.js";
import { buildSessionData, type SessionData } from "./session-data.js";
import {
  type ClaudeSessionStore,
  type ClaudeSidecarFileRef,
  localClaudeSessionStore,
} from "./store.js";

export { subagentsDirFor } from "./paths.js";

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

/** `agent-<id>.jsonl` -> `<id>`, `undefined` if `name` doesn't match. */
function matchAgentFilename(name: string): string | undefined {
  return /^agent-(.+)\.jsonl$/.exec(name)?.[1];
}

/** Group a flat sidecar file list by directory, so agent+meta pairs in the same dir match without re-listing. */
function groupByDir(files: readonly ClaudeSidecarFileRef[]): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  for (const { path } of files) {
    const dir = dirname(path);
    const set = byDir.get(dir);
    if (set !== undefined) {
      set.add(basename(path));
    } else {
      byDir.set(dir, new Set([basename(path)]));
    }
  }
  return byDir;
}

/** One directory's `agent-<id>.jsonl` (+ optional `.meta.json` sibling) discovery, shared by both layouts. */
async function scanAgentDir(
  dir: string,
  namesInDir: ReadonlySet<string> | undefined,
  store: ClaudeSessionStore,
): Promise<Array<{ agentId: string; jsonlPath: string; meta: SubagentMeta }>> {
  if (namesInDir === undefined) return [];
  const refs: Array<{ agentId: string; jsonlPath: string; meta: SubagentMeta }> = [];
  for (const name of namesInDir) {
    const agentId = matchAgentFilename(name);
    if (agentId === undefined) continue;

    let meta: SubagentMeta = {};
    const metaName = `agent-${agentId}.meta.json`;
    if (namesInDir.has(metaName)) {
      try {
        meta = JSON.parse(await store.readFile(joinPath(dir, metaName))) as SubagentMeta;
      } catch {
        // Meta file is optional / can be malformed.
      }
    }
    refs.push({ agentId, jsonlPath: joinPath(dir, name), meta });
  }
  return refs;
}

/**
 * List every subagent sidecar transcript for a session, with parsed meta
 * (best-effort) — both classic top-level sidecars and Workflow-tool agents
 * nested one level deeper under `subagents/workflows/<runId>/` (tagged with
 * `workflowRunId`). Missing directories at any level yield `[]`, never throw.
 */
export async function listSubagentRefs(
  mainFilePath: string,
  store: ClaudeSessionStore = localClaudeSessionStore,
): Promise<SubagentRef[]> {
  const subagentsDir = subagentsDirFor(mainFilePath);
  const workflowsDir = joinPath(subagentsDir, "workflows");
  const sidecarFiles = await store.listSidecarFiles(mainFilePath);
  const byDir = groupByDir(sidecarFiles);

  const refs: SubagentRef[] = await scanAgentDir(subagentsDir, byDir.get(subagentsDir), store);

  // Run dirs are inferred from which directories actually contributed sidecar
  // files (dirname one level under workflowsDir) — filesystem-driven, same as
  // the original `readdir`-based scan, independent of whether a
  // `workflows/<runId>.json` state file exists for that run (see
  // `workflows.ts`).
  for (const dir of byDir.keys()) {
    if (dirname(dir) !== workflowsDir) continue;
    const runId = basename(dir);
    for (const ref of await scanAgentDir(dir, byDir.get(dir), store)) {
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
  store: ClaudeSessionStore = localClaudeSessionStore,
): Promise<SessionData | undefined> {
  const directPath = joinPath(subagentsDirFor(mainFilePath), `agent-${agentId}.jsonl`);
  try {
    const transcript = await parseClaudeTranscriptFile(directPath, store);
    return buildSessionData(transcript);
  } catch {
    // Not a classic top-level sidecar — fall through to the full scan below.
  }

  const ref = (await listSubagentRefs(mainFilePath, store)).find((r) => r.agentId === agentId);
  if (ref === undefined) return undefined;
  try {
    const transcript = await parseClaudeTranscriptFile(ref.jsonlPath, store);
    return buildSessionData(transcript);
  } catch {
    return undefined;
  }
}
