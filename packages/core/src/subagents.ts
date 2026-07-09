/**
 * Shared helpers for locating and loading subagent sidecar transcripts.
 *
 * A session's subagent transcripts live at
 * `<projectDir>/<mainSessionId>/subagents/agent-<agentId>.jsonl`, each with an
 * optional `agent-<agentId>.meta.json` sibling. This module centralizes that
 * discovery so both the quantitative analysis (`analyze.ts`) and the timeline
 * (`timeline.ts`) resolve subagents the same way.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseTranscriptFile } from "./parser.js";
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
}

/** Directory containing per-agent sidecar transcripts for a main session file. */
export function subagentsDirFor(mainFilePath: string): string {
  const sessionId = basename(mainFilePath, ".jsonl");
  return join(dirname(mainFilePath), sessionId, "subagents");
}

/** List every subagent sidecar transcript for a session, with parsed meta (best-effort). */
export async function listSubagentRefs(mainFilePath: string): Promise<SubagentRef[]> {
  const subagentsDir = subagentsDirFor(mainFilePath);
  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return [];
  }

  const refs: SubagentRef[] = [];
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
    refs.push({ agentId, jsonlPath: join(subagentsDir, entry), meta });
  }
  return refs;
}

/** Parse + structure one subagent's transcript by agent id. `undefined` if it can't be read. */
export async function loadSubagentSessionData(
  mainFilePath: string,
  agentId: string,
): Promise<SessionData | undefined> {
  const jsonlPath = join(subagentsDirFor(mainFilePath), `agent-${agentId}.jsonl`);
  try {
    const transcript = await parseTranscriptFile(jsonlPath);
    return buildSessionData(transcript);
  } catch {
    return undefined;
  }
}
