import type { AppType } from "@junrei/server";
import type { InferResponseType } from "hono/client";
import { hc } from "hono/client";

export const client = hc<AppType>("/");

/**
 * JSON-serialized shapes as the API actually returns them (via Hono RPC
 * inference). `GET /api/sessions` returns a discriminated union
 * (`AnySessionListItem` server-side), so `SessionListItem` below is already a
 * union — `ClaudeSessionListItem`/`CodexSessionListItem` narrow it by
 * `source` for call sites that need one variant specifically (e.g. the
 * session-list row renderer).
 */
export type SessionListItem = InferResponseType<
  typeof client.api.sessions.$get
>["sessions"][number];
export type ClaudeSessionListItem = Extract<SessionListItem, { source: "claude-code" }>;
export type CodexSessionListItem = Extract<SessionListItem, { source: "codex" }>;
export type ModelMixEntry = SessionListItem["modelMix"][number];

type SessionResponse = InferResponseType<(typeof client.api.sessions)[":project"][":id"]["$get"]>;
export type SessionJson = Extract<SessionResponse, { sessionId: string }>;
export type SubagentNodeJson = SessionJson["subagents"][number];
export type ModelUsageSummary = SessionJson["totalUsageByModel"][number];

type CodexSessionResponse = InferResponseType<(typeof client.api.sessions.codex)[":id"]["$get"]>;
/** Unwraps the `{ analysis }` envelope `GET /api/sessions/codex/:id` returns (unlike the bare Claude detail route). */
export type CodexSessionJson = Extract<CodexSessionResponse, { analysis: unknown }>["analysis"];
/** The raw (still-wrapped) response body from `GET /api/sessions/codex/:id` — either shape the route can send. */
export type CodexSessionResponseBody = CodexSessionResponse;

/**
 * Unwraps the `{ analysis }` envelope from `GET /api/sessions/codex/:id`
 * (distinct from the Claude detail route, which returns the analysis JSON
 * bare — see `sessions.ts`/`app.ts` on the server) into the analysis itself,
 * or `undefined` for the `{ error }` shape. In practice the route only ever
 * sends `{ error }` alongside a non-2xx status (already handled by the
 * `res.ok` check before this runs), but keeping the unwrap as its own pure
 * function — rather than inlining a property-presence check at the call
 * site — makes it independently testable and defends against a body that
 * doesn't match the expected shape.
 */
export function unwrapCodexSessionResponse(
  body: CodexSessionResponseBody,
): CodexSessionJson | undefined {
  return "analysis" in body ? body.analysis : undefined;
}

/**
 * Either harness's full session analysis, discriminated on `source` — shared
 * lens components (Overview, ContextCost, ...) accept this union and narrow
 * on `session.source` wherever Claude-only data (subagents, api errors,
 * per-turn cache-write composition, ...) would otherwise be assumed present.
 */
export type AnySessionJson = SessionJson | CodexSessionJson;

/**
 * A subagent's own analysis (`GET .../agents/:agentId`) — deliberately the
 * same `SessionAnalysis` JSON shape as `SessionJson` (just analyzed from the
 * agent's sidecar transcript instead of the main one), so every session-level
 * component (ContextGrowthChart, FirstPromptPanel, ...) is directly reusable
 * for the agent detail shell (L3) with no separate DTO.
 */
type AgentResponse = InferResponseType<
  (typeof client.api.sessions)[":project"][":id"]["agents"][":agentId"]["$get"]
>;
export type AgentJson = Extract<AgentResponse, { sessionId: string }>;

type TimelineResponse = InferResponseType<
  (typeof client.api.sessions)[":project"][":id"]["timeline"]["$get"]
>;
export type TimelineEntry = Extract<TimelineResponse, { entries: unknown[] }>["entries"][number];

type RecordResponse = InferResponseType<
  (typeof client.api.sessions)[":project"][":id"]["record"][":line"]["$get"]
>;
/** Discriminated union of every record kind the slide-over (L3, screen 8) can render. */
export type RecordDetail = Exclude<RecordResponse, { error: string }>;
export type ToolCallRecordDetail = Extract<RecordDetail, { kind: "tool-call" }>;
export type SubagentLaunchRecordDetail = Extract<RecordDetail, { kind: "subagent-launch" }>;
