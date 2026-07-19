/**
 * `selectEvidence` — a thin, uniform facade over the existing per-kind
 * getters (record / tool_call / tool_calls / first_prompt / task_executions).
 * It doesn't re-implement any of them: the caller (the server, PR2) injects a
 * set of `fetchers` that wrap the real getters, and this function dispatches
 * on `select.type`, echoes provenance, and attaches the shared `_meta`
 * envelope — so every evidence kind comes back through ONE call shape.
 *
 * The Codex handling the spec calls for lives here too: when a selected kind
 * has no fetcher for the session's harness (e.g. `task_executions`, a
 * Claude-only concept), the result is a structured `notAvailable` with
 * `nextSteps`, never an error — the same "degrade, don't throw" contract the
 * rest of the insight layer follows.
 */

import type { SessionSource } from "../shared/session-analysis.js";
import { buildMeta } from "./meta.js";
import type { Detail, InsightMeta } from "./types.js";

export type EvidenceSelect =
  | { type: "record"; line: number }
  | { type: "tool_call"; toolUseId: string }
  | { type: "tool_calls"; toolName?: string; limit?: number }
  | { type: "first_prompt" }
  | { type: "task_executions" };

export interface SelectEvidenceInput {
  source: SessionSource;
  sessionId: string;
  select: EvidenceSelect;
  /** Restrict to one subagent's thread, when the underlying getter supports it. */
  agentId?: string;
  detail?: Detail;
}

/**
 * The injected getters. Each is optional: a harness that doesn't expose a
 * given kind simply omits its fetcher, and `selectEvidence` reports that kind
 * as `notAvailable` for that call rather than failing. Every fetcher returns
 * whatever shape the existing getter already returns — this facade does not
 * reshape the payload (spec: "結果形状は既存を踏襲"), only wraps it.
 */
export interface EvidenceFetchers {
  record?(args: {
    sessionId: string;
    line: number;
    agentId?: string;
    detail?: Detail;
  }): Promise<unknown>;
  toolCall?(args: {
    sessionId: string;
    toolUseId: string;
    agentId?: string;
    detail?: Detail;
  }): Promise<unknown>;
  toolCalls?(args: {
    sessionId: string;
    toolName?: string;
    limit?: number;
    agentId?: string;
    detail?: Detail;
  }): Promise<unknown>;
  firstPrompt?(args: { sessionId: string }): Promise<unknown>;
  taskExecutions?(args: { sessionId: string; agentId?: string }): Promise<unknown>;
}

export interface EvidenceResult {
  source: SessionSource;
  sessionId: string;
  kind: EvidenceSelect["type"];
  /** The underlying getter's own payload, unchanged — undefined when `notAvailable`. */
  data?: unknown;
  /** Set instead of `data` when this kind isn't available for the session's harness. */
  notAvailable?: true;
  _meta: InsightMeta;
}

function unavailable(input: SelectEvidenceInput): EvidenceResult {
  const kind = input.select.type;
  const payload = {
    source: input.source,
    sessionId: input.sessionId,
    kind,
    notAvailable: true as const,
  };
  return {
    ...payload,
    _meta: buildMeta(payload, {
      nextSteps: [
        `Evidence kind '${kind}' is not available for ${input.source} sessions.`,
        "Call selectEvidence with a supported kind (e.g. 'record' or 'first_prompt').",
      ],
    }),
  };
}

function present(input: SelectEvidenceInput, data: unknown): EvidenceResult {
  const kind = input.select.type;
  const payload = { source: input.source, sessionId: input.sessionId, kind, data };
  return { ...payload, _meta: buildMeta(payload) };
}

/**
 * Dispatch one evidence request to its injected fetcher. A missing fetcher
 * for the selected kind yields a `notAvailable` result (never a throw);
 * otherwise the fetcher's own payload is returned verbatim under `data`.
 */
export async function selectEvidence(
  input: SelectEvidenceInput,
  fetchers: EvidenceFetchers,
): Promise<EvidenceResult> {
  const { select, sessionId, agentId, detail } = input;
  const withAgent = agentId !== undefined ? { agentId } : {};
  const withDetail = detail !== undefined ? { detail } : {};

  switch (select.type) {
    case "record": {
      if (fetchers.record === undefined) return unavailable(input);
      return present(
        input,
        await fetchers.record({ sessionId, line: select.line, ...withAgent, ...withDetail }),
      );
    }
    case "tool_call": {
      if (fetchers.toolCall === undefined) return unavailable(input);
      return present(
        input,
        await fetchers.toolCall({
          sessionId,
          toolUseId: select.toolUseId,
          ...withAgent,
          ...withDetail,
        }),
      );
    }
    case "tool_calls": {
      if (fetchers.toolCalls === undefined) return unavailable(input);
      return present(
        input,
        await fetchers.toolCalls({
          sessionId,
          ...(select.toolName !== undefined && { toolName: select.toolName }),
          ...(select.limit !== undefined && { limit: select.limit }),
          ...withAgent,
          ...withDetail,
        }),
      );
    }
    case "first_prompt": {
      if (fetchers.firstPrompt === undefined) return unavailable(input);
      return present(input, await fetchers.firstPrompt({ sessionId }));
    }
    case "task_executions": {
      if (fetchers.taskExecutions === undefined) return unavailable(input);
      return present(input, await fetchers.taskExecutions({ sessionId, ...withAgent }));
    }
  }
}
