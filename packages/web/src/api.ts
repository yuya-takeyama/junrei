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

type ClaudeSessionResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":id"]["$get"]
>;
type CodexSessionResponse = InferResponseType<(typeof client.api.sessions.codex)[":id"]["$get"]>;
type AnySessionResponseBody = ClaudeSessionResponse | CodexSessionResponse;

/**
 * The Bash tab v2 header strip's percentile chip data — see the server's
 * `bash-percentile.ts` for the computation and why it's a small SERVER
 * addition rather than a web-side one (the web layer never imports
 * `@junrei/core` directly — types cross via Hono-inferred JSON only, same
 * convention as every other type on this page). `NonNullable`'d because the
 * envelope field itself is only ever PRESENT when defined (the server spreads
 * it in conditionally — `...(bashPercentile !== undefined && {
 * bashPercentile })` — never sends an explicit `null`/`undefined`), so the
 * inferred field type is `T | undefined` at the optional-property level, and
 * this alias should describe the payload shape alone.
 */
export type SessionBashPercentileJson = NonNullable<
  Extract<ClaudeSessionResponse, { analysis: unknown }>["bashPercentile"]
>;

/**
 * `lastActivityAt`/`bashPercentile` live on the ENVELOPE (`{ analysis,
 * lastActivityAt, bashPercentile? }`), never inside the mtime-cached
 * `analysis` object itself (see the server's `getClaudeLastActivityAt`/
 * `getCodexLastActivityAt` and `bash-percentile.ts`) — intersected onto the
 * session JSON type here rather than left off, so every session-level
 * component (`isSessionLive`, the Orchestration tree's Status column, the
 * Bash lens's header strip, ...) can read `session.lastActivityAt`/
 * `session.bashPercentile` directly instead of threading the envelope
 * separately. `unwrapSessionResponse` below is what actually merges them
 * onto the returned object at runtime.
 */
export type SessionJson = Extract<ClaudeSessionResponse, { analysis: unknown }>["analysis"] & {
  // `| undefined` explicit (not just `?:`) — `exactOptionalPropertyTypes`
  // rejects assigning an explicit `undefined` value (the server's stat-failure
  // case) to a bare `?:` field. Same pattern as `format.ts`'s
  // `DelegationShareScope.costUsd`.
  lastActivityAt?: string | undefined;
  /** Absent when the repo doesn't yet have enough Bash-tracked sessions to rank against — see `bash-percentile.ts`'s gate. The Bash lens's header strip hides its percentile chip entirely in that case. */
  bashPercentile?: SessionBashPercentileJson | undefined;
};
export type CodexSessionJson = Extract<CodexSessionResponse, { analysis: unknown }>["analysis"] & {
  lastActivityAt?: string | undefined;
  bashPercentile?: SessionBashPercentileJson | undefined;
};
export type SubagentNodeJson = SessionJson["subagents"][number];
export type ModelUsageSummary = SessionJson["totalUsageByModel"][number];
/** One Workflow-tool run's session-level summary — Claude-only, see `ClaudeWorkflowRunSummary` in `@junrei/core`. */
export type WorkflowRunSummaryJson = SessionJson["workflowRuns"][number];
/** Bash-command analytics, both harnesses — see `BashStats` in `@junrei/core`'s `shared/bash-stats.ts` (`SessionAnalysisCore.bashStats`). */
export type BashStatsJson = SessionJson["bashStats"];
/** Cross-tool usage analytics, both harnesses — see `ToolUsageStats` in `@junrei/core`'s `shared/tool-usage-stats.ts` (`SessionAnalysisCore.toolUsageStats`). Backs the Tools lens's "All" sub-tab. Its `byThread` is type-identical to `BashStatsJson["byThread"]`, so the Bash lens's `WhoPaidPanel` renders against it unchanged. */
export type ToolUsageStatsJson = SessionJson["toolUsageStats"];

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
  return {
    ...body.analysis,
    lastActivityAt: body.lastActivityAt,
    bashPercentile: body.bashPercentile,
  };
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
      : await client.api.sessions["claude-code"][":id"].$get({ param: { id: ref.id } });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = (await res.json()) as AnySessionResponseBody;
  const analysis = unwrapSessionResponse(body);
  if (analysis === undefined) throw new Error("malformed session response");
  return analysis;
}

type ClaudeTimelineResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":id"]["timeline"]["$get"]
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
      : await client.api.sessions["claude-code"][":id"].timeline.$get({
          param: { id: ref.id },
          ...(agentId !== undefined && { query: { agent: agentId } }),
        });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = (await res.json()) as { entries: TimelineEntry[] };
  return body.entries;
}

type RecordResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":id"]["record"][":line"]["$get"]
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
      : await client.api.sessions["claude-code"][":id"].record[":line"].$get({
          param: { id: ref.id, line: String(line) },
          ...(agentId !== undefined && { query: { agent: agentId } }),
        });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return { detail: (await res.json()) as RecordDetail };
}

type AgentResponse = InferResponseType<
  (typeof client.api.sessions)["claude-code"][":id"]["agents"][":agentId"]["$get"]
>;
/**
 * A subagent's own analysis (`GET .../claude-code/:id/agents/:agentId`)
 * — deliberately the same `ClaudeSessionAnalysis` JSON shape as `SessionJson`
 * (just analyzed from the agent's sidecar transcript instead of the main
 * one), so every session-level component (ContextGrowthChart,
 * FirstPromptPanel, ...) is directly reusable for the agent detail shell (L3)
 * with no separate DTO. Claude-only — Codex sub-agents are full sessions,
 * fetched via `fetchSessionDetail` like any other Codex session.
 */
export type AgentJson = Extract<AgentResponse, { analysis: unknown }>["analysis"];

/** Fetch a subagent's own analysis. Claude-only — see `AgentJson`. */
export async function fetchAgentSession(id: string, agentId: string): Promise<AgentJson> {
  const res = await client.api.sessions["claude-code"][":id"].agents[":agentId"].$get({
    param: { id, agentId },
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = await res.json();
  if (!("analysis" in body)) throw new Error("malformed agent response");
  return body.analysis;
}

/**
 * The conclusion-first repo briefing (`GET /api/briefing`) — the Briefing
 * home's sole data source (PR3). Typed via `InferResponseType` so the KPI
 * strip / waste / wins / learnings / dailyCosts all read the wire shape the
 * server actually serves (`buildRepoBriefing` -> `buildBriefing` in
 * `@junrei/core`), never a hand-maintained DTO. `BriefingWaste`/`BriefingWin`
 * narrow the sections' own row types for the presentational components.
 */
// The route also has a 400 branch (an ambiguous bare `repo`) — narrow to the
// success shape so the section row types below resolve off `Briefing` cleanly.
export type Briefing = Extract<
  InferResponseType<typeof client.api.briefing.$get>,
  { summary: unknown }
>;
export type BriefingWaste = Briefing["waste"][number];
export type BriefingWin = Briefing["wins"][number];
export type BriefingLearningRef = Briefing["learnings"]["recent"][number];
export type BriefingTopSession = Briefing["topSessions"][number];

/**
 * Fetch the repo briefing. `repo` scopes it (an absolute repoRoot / bucket
 * key from the repo selector, or a bare name the server resolves); `days` is
 * the masthead's period toggle (1/7/30). A 400 (an ambiguous bare `repo`)
 * still throws here — the home only ever sends resolved keys from its
 * selector, so this path is defensive.
 */
export async function fetchBriefing(params: { repo?: string; days: number }): Promise<Briefing> {
  const res = await client.api.briefing.$get({
    query: {
      days: String(params.days),
      ...(params.repo !== undefined && { repo: params.repo }),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return (await res.json()) as Briefing;
}

/**
 * The conclusion-first single-session insight (`GET
 * /api/sessions/<source>/:id/insight`) — the Story tab's FROM-THIS-SESSION
 * callout's data source (PR4). Typed via `InferResponseType` off the Claude
 * route (the two source routes serve the identical `SessionInsight` shape), so
 * the callout reads the wire shape the server actually serves
 * (`buildSessionInsightFor` → `buildSessionInsight` in `@junrei/core`), never a
 * hand-maintained DTO. Narrowed to the success shape (the route also has a 404
 * `{ error }` branch).
 */
export type SessionInsight = Extract<
  InferResponseType<(typeof client.api.sessions)["claude-code"][":id"]["insight"]["$get"]>,
  { summary: unknown }
>;
export type SessionInsightRecommendation = SessionInsight["recommendations"][number];
export type SessionInsightWaste = SessionInsight["waste"][number];

/**
 * Fetch one session's insight, dispatching to that source's own route. Returns
 * `undefined` for a 404 (the session's analysis didn't resolve) so the callout
 * can render nothing rather than an error banner — it's an enhancement over the
 * Timeline below it, not a load the Story tab depends on.
 */
export async function fetchSessionInsight(
  ref: SessionRef,
  detail?: "full",
): Promise<SessionInsight | undefined> {
  // Conditional spread (not an inline `query` prop) so TS doesn't excess-check
  // it against the validator-less route type — the same shape `fetchTimeline`
  // uses for its `agent` query. `detail: 'full'` opts into the `whatIf[]` field.
  const res =
    ref.source === "codex"
      ? await client.api.sessions.codex[":id"].insight.$get({
          param: { id: ref.id },
          ...(detail !== undefined && { query: { detail } }),
        })
      : await client.api.sessions["claude-code"][":id"].insight.$get({
          param: { id: ref.id },
          ...(detail !== undefined && { query: { detail } }),
        });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return (await res.json()) as SessionInsight;
}

type LearningsResponse = InferResponseType<typeof client.api.learnings.$get>;
/** One repo-local learning as the ledger serves it (`@junrei/core`'s `Learning`). Backs the Learnings loop board. */
export type Learning = LearningsResponse["learnings"][number];

/** Fetch the repo-local learning ledger (`GET /api/learnings`). `repo` scopes it to one ledger; omit for every known repo. */
export async function fetchLearnings(
  repo?: string,
): Promise<{ learnings: Learning[]; warnings: string[] }> {
  const res = await client.api.learnings.$get({
    query: { ...(repo !== undefined && { repo }) },
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = (await res.json()) as { learnings: Learning[]; warnings: string[] };
  return body;
}

/**
 * The Learnings board's write path (`POST /api/learnings`) — the SAME upsert
 * `log_learning` runs. Three call shapes the board uses:
 *  - Accept an open learning -> `{ repoPath, id, status: "applied" }`
 *  - Dismiss an open learning -> `{ repoPath, id, status: "rejected" }`
 *  - Log a waste finding      -> `{ source, sessionId, finding, change, proposedBy: "agent" }`
 * `repoPath` (an existing learning's own `repo`) or `source`+`sessionId` (a
 * waste item's provenance) lets the server resolve the ledger's repo root.
 */
export interface PostLearningInput {
  repoPath?: string;
  source?: SessionRef["source"];
  sessionId?: string;
  id?: string;
  finding?: string;
  change?: string;
  expectedEffect?: string;
  status?: Learning["status"];
  proposedBy?: Learning["proposedBy"];
}

export async function postLearning(input: PostLearningInput): Promise<Learning> {
  const res = await client.api.learnings.$post({ json: input });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as { learning: Learning };
  return body.learning;
}
