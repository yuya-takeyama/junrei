import type { AppType } from "@junrei/server";
import type { InferResponseType } from "hono/client";
import { hc } from "hono/client";
import type { SessionRef } from "./router.js";

export const client = hc<AppType>("/");

export type { SessionRef } from "./router.js";

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

type RepoOverviewResponse = InferResponseType<typeof client.api.overview.$get>;

/** Repo-level rollup — see `@junrei/server`'s `overview.ts` for the exact aggregation. */
export type RepoOverview = Extract<RepoOverviewResponse, { overview: unknown }>["overview"];

/**
 * Fetch the repo-level rollup for one repo key (a `repoRoot` path, or one of
 * the fallback-bucket keys `repoFilterKey` assigns — see `overview.ts`'s doc
 * comment on the server for the exact accepted forms). Throws on a non-2xx
 * response — the session-list band this feeds treats any failure the same
 * way (log + omit the band), so there's no separate "not found" case to
 * distinguish here unlike `fetchRecordDetail`'s 404.
 */
export async function fetchRepoOverview(repo: string): Promise<RepoOverview> {
  const res = await client.api.overview.$get({ query: { repo } });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = await res.json();
  if (!("overview" in body)) throw new Error("malformed overview response");
  return body.overview;
}

type ClaudeSessionResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":project"][":id"]["$get"]
>;
type CodexSessionResponse = InferResponseType<(typeof client.api.sessions.codex)[":id"]["$get"]>;
type AnySessionResponseBody = ClaudeSessionResponse | CodexSessionResponse;

/**
 * `lastActivityAt` lives on the ENVELOPE (`{ analysis, lastActivityAt }`),
 * never inside the mtime-cached `analysis` object itself (see the server's
 * `getClaudeLastActivityAt`/`getCodexLastActivityAt`) — intersected onto the
 * session JSON type here rather than left off, so every session-level
 * component (`isSessionLive`, the Orchestration tree's Status column, ...)
 * can read `session.lastActivityAt` directly instead of threading the
 * envelope separately. `unwrapSessionResponse` below is what actually merges
 * it onto the returned object at runtime.
 */
export type SessionJson = Extract<ClaudeSessionResponse, { analysis: unknown }>["analysis"] & {
  // `| undefined` explicit (not just `?:`) — `exactOptionalPropertyTypes`
  // rejects assigning an explicit `undefined` value (the server's stat-failure
  // case) to a bare `?:` field. Same pattern as `format.ts`'s
  // `DelegationShareScope.costUsd`.
  lastActivityAt?: string | undefined;
};
export type CodexSessionJson = Extract<CodexSessionResponse, { analysis: unknown }>["analysis"] & {
  lastActivityAt?: string | undefined;
};
export type SubagentNodeJson = SessionJson["subagents"][number];
export type ModelUsageSummary = SessionJson["totalUsageByModel"][number];

/**
 * Either harness's full session analysis, discriminated on `source` — shared
 * lens components (Overview, ContextCost, ...) accept this union and narrow
 * on `session.source` wherever Claude-only data (subagents, api errors,
 * per-turn cache-write composition, ...) would otherwise be assumed present.
 */
export type AnySessionJson = SessionJson | CodexSessionJson;

/**
 * Unwraps the shared `{ analysis, lastActivityAt }` envelope both detail
 * routes return, merging `lastActivityAt` onto the returned session object
 * (see `SessionJson`'s doc comment for why it isn't already part of
 * `analysis`) — or `undefined` for the `{ error }` shape. In practice a
 * caller only ever sees `{ error }` alongside a non-2xx status (already
 * handled by the `res.ok` check before this runs), but keeping the unwrap as
 * its own pure function — rather than inlining a property-presence check at
 * the call site — makes it independently testable and defends against a body
 * that doesn't match the expected shape.
 */
export function unwrapSessionResponse(body: AnySessionResponseBody): AnySessionJson | undefined {
  if (!("analysis" in body)) return undefined;
  return { ...body.analysis, lastActivityAt: body.lastActivityAt };
}

/**
 * Fetch a session's full analysis for either source, dispatching to that
 * source's own route shape. Overloaded on `ref.source` so a caller that
 * already knows which source it's fetching (SessionShell's two routes,
 * AgentShell's Claude-only fetch) gets back the narrow analysis type without
 * an `as`-cast — only a caller holding a generic `SessionRef` (of unknown
 * source) sees the `AnySessionJson` union.
 */
export async function fetchSessionDetail(
  ref: Extract<SessionRef, { source: "claude-code" }>,
): Promise<SessionJson>;
export async function fetchSessionDetail(
  ref: Extract<SessionRef, { source: "codex" }>,
): Promise<CodexSessionJson>;
export async function fetchSessionDetail(ref: SessionRef): Promise<AnySessionJson>;
export async function fetchSessionDetail(ref: SessionRef): Promise<AnySessionJson> {
  const res =
    ref.source === "codex"
      ? await client.api.sessions.codex[":id"].$get({ param: { id: ref.id } })
      : await client.api.sessions["claude-code"][":project"][":id"].$get({
          param: { project: ref.project, id: ref.id },
        });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = (await res.json()) as AnySessionResponseBody;
  const analysis = unwrapSessionResponse(body);
  if (analysis === undefined) throw new Error("malformed session response");
  return analysis;
}

type ClaudeTimelineResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":project"][":id"]["timeline"]["$get"]
>;
export type TimelineEntry = Extract<
  ClaudeTimelineResponse,
  { entries: unknown[] }
>["entries"][number];

/** Fetch the full-transcript timeline (L2) for either source. `agentId` scopes a Claude fetch to one subagent. */
export async function fetchTimeline(ref: SessionRef, agentId?: string): Promise<TimelineEntry[]> {
  const res =
    ref.source === "codex"
      ? await client.api.sessions.codex[":id"].timeline.$get({ param: { id: ref.id } })
      : await client.api.sessions["claude-code"][":project"][":id"].timeline.$get({
          param: { project: ref.project, id: ref.id },
          ...(agentId !== undefined && { query: { agent: agentId } }),
        });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = (await res.json()) as { entries: TimelineEntry[] };
  return body.entries;
}

type RecordResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":project"][":id"]["record"][":line"]["$get"]
>;
/** Discriminated union of every record kind the slide-over (L3, screen 8) can render. */
export type RecordDetail = Exclude<RecordResponse, { error: string }>;
export type ToolCallRecordDetail = Extract<RecordDetail, { kind: "tool-call" }>;
export type SubagentLaunchRecordDetail = Extract<RecordDetail, { kind: "subagent-launch" }>;

/** `fetchRecordDetail`'s result — a 404 is a normal outcome (line has no record), surfaced distinctly rather than thrown. */
export type RecordFetchResult = { detail: RecordDetail } | { notFound: true };

/** Fetch full detail for one source line (L3 slide-over) for either source. `agentId` scopes a Claude fetch to one subagent. */
export async function fetchRecordDetail(
  ref: SessionRef,
  line: number,
  agentId?: string,
): Promise<RecordFetchResult> {
  const res =
    ref.source === "codex"
      ? await client.api.sessions.codex[":id"].record[":line"].$get({
          param: { id: ref.id, line: String(line) },
        })
      : await client.api.sessions["claude-code"][":project"][":id"].record[":line"].$get({
          param: { project: ref.project, id: ref.id, line: String(line) },
          ...(agentId !== undefined && { query: { agent: agentId } }),
        });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return { detail: (await res.json()) as RecordDetail };
}

type AgentResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":project"][":id"]["agents"][":agentId"]["$get"]
>;
/**
 * A subagent's own analysis (`GET .../claude-code/:project/:id/agents/:agentId`)
 * — deliberately the same `ClaudeSessionAnalysis` JSON shape as `SessionJson`
 * (just analyzed from the agent's sidecar transcript instead of the main
 * one), so every session-level component (ContextGrowthChart,
 * FirstPromptPanel, ...) is directly reusable for the agent detail shell (L3)
 * with no separate DTO. Claude-only — Codex sub-agents are full sessions,
 * fetched via `fetchSessionDetail` like any other Codex session.
 */
export type AgentJson = Extract<AgentResponse, { analysis: unknown }>["analysis"];

/** Fetch a subagent's own analysis. Claude-only — see `AgentJson`. */
export async function fetchAgentSession(
  project: string,
  id: string,
  agentId: string,
): Promise<AgentJson> {
  const res = await client.api.sessions["claude-code"][":project"][":id"].agents[":agentId"].$get({
    param: { project, id, agentId },
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = await res.json();
  if (!("analysis" in body)) throw new Error("malformed agent response");
  return body.analysis;
}
