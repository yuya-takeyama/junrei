import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPTransport } from "@hono/mcp";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  computeTrends,
  createLearning,
  extractSessionId,
  type LearningStatus,
  type LearningVerification,
  updateLearning,
} from "@junrei/core";
import { type Context, Hono } from "hono";
import { resolveBashPercentile } from "./bash-percentile.js";
import { assembleEvaluationTrace } from "./evaluation-trace.js";
import {
  AmbiguousRepoError,
  buildRepoBriefing,
  buildSessionInsightFor,
  listLearningsForRepo,
  resolveLearningRepoRoot,
} from "./insight.js";
import { createMcpServer } from "./mcp.js";
import { getRepoOverview } from "./overview.js";
import {
  claudeAdapter,
  codexAdapter,
  getAgentSession,
  getClaudeLastActivityAt,
  getCodexLastActivityAt,
  getCodexSessionBashStatsMainOnly,
  listAllSessionsInBounds,
  listSessions,
  MAX_LIST_LIMIT,
  type SessionSourceFilter,
} from "./sessions.js";
import { appendOtelLine, resolveOtelDir } from "./sources/otel.js";
import {
  DEFAULT_TRENDS_TIMEZONE,
  isValidTimeZone,
  parseTrendsDays,
  TRENDS_DAY_MS,
} from "./trends-params.js";

export type { AnySessionListItem } from "./sessions.js";

const DEFAULT_LIST_LIMIT = 50;

// The built web SPA (`@junrei/web`'s `vite build` output) — a sibling
// package's `dist/`, resolved from this file's own location so it's correct
// regardless of the process's cwd. Absent in dev (the Vite dev server serves
// the SPA directly, see vite.config.ts) and in most test runs (nothing here
// builds `@junrei/web` first) — see the `webDistDir` guard below.
const DEFAULT_WEB_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

export type CreateAppOptions = {
  /**
   * Root directory of the built web SPA — override for tests (point at a
   * fixture dir with an `index.html`) rather than requiring a real
   * `vite build`. Defaults to `DEFAULT_WEB_DIST_DIR`.
   */
  webDistDir?: string;
};

function parseSourceFilter(raw: string | undefined): SessionSourceFilter | undefined {
  return raw === "claude-code" || raw === "codex" || raw === "all" ? raw : undefined;
}

/**
 * The opt-in OTLP http/json receiver (Goshuin Decision 7 — see
 * docs/milestones/goshuin.md, "E. OTel ingestion"): `POST /otlp/v1/logs` and
 * `POST /otlp/v1/metrics` both route here, sharing one handler since neither
 * behaves differently by signal — session-id extraction and storage both
 * operate on the raw parsed body regardless of whether it's a
 * ExportLogsServiceRequest or ExportMetricsServiceRequest (see
 * `@junrei/core`'s `extractSessionId`).
 *
 * `resolveOtelDir()` is re-read on every request (not cached at `createApp`
 * time) — the same "read env at call time" convention
 * `sources/reconstruction.ts`'s filesystem providers already use for
 * `JUNREI_TEMPLATES_DIR`, and what lets tests toggle `JUNREI_OTEL_DIR`
 * per-test around a single `createApp()` call. With no dir configured, this
 * calls `c.notFound()` — verified byte-for-byte identical to Hono's own
 * response for a route that was never registered at all (see
 * app.test.ts's parity tests), so keeping these two routes permanently in
 * the chain (rather than conditionally registering them) never changes
 * observable behavior when the feature is off, and keeps `AppType` (the
 * `hc<AppType>` RPC type the web package would use) stable regardless of
 * env.
 *
 * A body that isn't valid JSON is silently accepted (nothing is stored) —
 * Claude Code's own OTLP exporter must never see ingestion trouble as a
 * reason to stop exporting, so the response always mirrors the OTLP/HTTP
 * JSON success shape (`{}`, no `partial_success`) regardless of what could
 * be parsed/extracted. A record whose session id is missing or fails path
 * sanitization (see `sources/otel.ts`'s `sanitizeSessionId`) is still
 * stored, under `_unassigned.jsonl` — declared, never dropped.
 */
async function handleOtlpExport(c: Context): Promise<Response> {
  const otelDir = resolveOtelDir();
  if (otelDir === undefined) return c.notFound();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({});
  }
  await appendOtelLine(otelDir, extractSessionId(body), body);
  return c.json({});
}

export function createApp(options: CreateAppOptions = {}) {
  const webDistDir = options.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  // Only wire up static serving when a build actually exists — avoids
  // `serveStatic`'s "root path not found" console noise on every `createApp()`
  // call in dev/tests, where no build has run. The SPA-fallback catch-all
  // below is still registered unconditionally so the `/api/*` 404-shape
  // guarantee (see its comment) holds either way.
  const hasWebBuild = existsSync(webDistDir);

  const app = new Hono();
  // Constructed only when a build exists — `serveStatic` itself does an
  // `existsSync(root)` check at construction time and logs a warning when it
  // fails, which would otherwise fire on every build-less `createApp()` call
  // (i.e. most dev/test runs).
  const indexHtml = hasWebBuild ? serveStatic({ root: webDistDir, path: "index.html" }) : undefined;
  if (hasWebBuild) {
    // Real static assets (JS/CSS/etc, hashed filenames under /assets) —
    // served as-is with correct content types; falls through (calls `next()`)
    // for any path with no matching file, e.g. every API route and every
    // client-side SPA route below.
    app.use("*", serveStatic({ root: webDistDir }));
  }

  return (
    app
      .all("/mcp", async (c) => {
        // Stateless: a fresh server + transport per request keeps the endpoint
        // usable by any number of clients with no session bookkeeping.
        const transport = new StreamableHTTPTransport();
        await createMcpServer().connect(transport);
        return transport.handleRequest(c);
      })
      // Opt-in OTel receiver (Decision 7) — see `handleOtlpExport`'s doc
      // comment for why these two routes stay registered (404-internally)
      // rather than being added/omitted from the chain based on env.
      .post("/otlp/v1/logs", handleOtlpExport)
      .post("/otlp/v1/metrics", handleOtlpExport)
      .get("/api/health", (c) => c.json({ status: "ok", name: "junrei" } as const))
      .get("/api/sessions", async (c) => {
        const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
        const limit = Number.isInteger(rawLimit)
          ? Math.min(Math.max(rawLimit, 1), MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT;
        // Page start within the merged start-time-desc order; anything
        // non-numeric or negative falls back to the first page.
        const rawOffset = Number.parseInt(c.req.query("offset") ?? "", 10);
        const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
        // Omitted `source` means "all" — see `listSessions`'s doc comment.
        const source = parseSourceFilter(c.req.query("source"));
        // Optional session-START-time bounds (epoch ms, `sinceMs` inclusive /
        // `untilMs` exclusive — see `SessionListBounds`) driving the web's
        // date filter server-side: a non-integer or non-positive value is
        // treated the same as an absent one, same convention as `limit`/
        // `offset` above.
        const rawSinceMs = Number.parseInt(c.req.query("sinceMs") ?? "", 10);
        const sinceMs = Number.isInteger(rawSinceMs) && rawSinceMs > 0 ? rawSinceMs : undefined;
        const rawUntilMs = Number.parseInt(c.req.query("untilMs") ?? "", 10);
        const untilMs = Number.isInteger(rawUntilMs) && rawUntilMs > 0 ? rawUntilMs : undefined;
        return c.json(
          await listSessions(limit, source, offset, {
            ...(sinceMs !== undefined && { sinceMs }),
            ...(untilMs !== undefined && { untilMs }),
          }),
        );
      })
      // Repo-level ALL-TIME rollup (see `overview.ts`'s doc comment for the
      // exact `repo` key forms this accepts — a `repoRoot` path or one of
      // the fallback-bucket keys the web's `repoFilterKey` assigns).
      // `getRepoOverview` is the one listing+aggregation path this route and
      // the `get_repo_overview` MCP tool both call — see its doc comment.
      // The web's session-list band no longer fetches this route: it
      // computes a filter-aware rollup client-side (`computeFilteredOverview`).
      .get("/api/overview", async (c) => {
        const repo = c.req.query("repo");
        if (repo === undefined || repo === "") {
          return c.json({ error: "repo query param is required" } as const, 400);
        }
        return c.json({ overview: await getRepoOverview(repo) });
      })
      // Multi-day trend report (core aggregation + this route + the
      // `/trends` web screen; the `get_trends` MCP tool in mcp.ts mirrors
      // this same route, sharing its `days`/`tz` parsing via
      // ./trends-params.js so the two surfaces can't drift).
      // `days` is whitelisted (7/14/30) rather than an arbitrary integer so
      // the lookback fetch below stays a small, predictable number of
      // sessions; an out-of-whitelist value coerces to the default (same
      // convention `limit`/`offset`/`sinceMs`/`untilMs` use above), but an
      // invalid `tz` 400s outright — there's no sane default to fall back to
      // for "the caller asked for a time zone that doesn't exist".
      //
      // `computeTrends` now windows by CALENDAR day itself (current window =
      // the `days` local calendar days ending with today; previous = the
      // equal-length span right before it — see `@junrei/core`'s
      // `TrendsOptions`), so this route just needs to hand it a comfortable
      // SUPERSET of both windows, not the exact bounds. `2*days + 2` days of
      // margin covers the two full windows plus slop for `timeZone` being
      // ahead of UTC (a session that's "today" in a +N tz can be up to N
      // hours in the FUTURE relative to this server's own UTC `Date.now()`)
      // — cheap insurance against a boundary session going missing, at the
      // cost of `listAllSessionsInBounds` looking at a few extra days of
      // sessions `computeTrends` itself will just filter back out.
      .get("/api/trends", async (c) => {
        const days = parseTrendsDays(c.req.query("days"));
        const timeZone = c.req.query("tz") ?? DEFAULT_TRENDS_TIMEZONE;
        if (!isValidTimeZone(timeZone)) {
          return c.json({ error: "tz query param must be a valid IANA time zone" } as const, 400);
        }
        const rawRepo = c.req.query("repo");
        const repo = rawRepo === undefined || rawRepo === "" ? undefined : rawRepo;

        const nowMs = Date.now();
        const untilMs = nowMs;
        const sinceMs = nowMs - (2 * days + 2) * TRENDS_DAY_MS;

        const items = await listAllSessionsInBounds({ sinceMs, untilMs });
        return c.json(
          computeTrends(items, {
            nowMs,
            days,
            timeZone,
            ...(repo !== undefined && { repo }),
          }),
        );
      })
      // Conclusion-first repo briefing (the web's Home in PR3) — the same
      // `buildRepoBriefing` gather+build path the `briefing` MCP tool calls,
      // so the two surfaces can't drift. `days` is a plain integer here
      // (1..90); an out-of-range/NaN value falls back to the default inside
      // `buildRepoBriefing`.
      .get("/api/briefing", async (c) => {
        const rawRepo = c.req.query("repo");
        const repo = rawRepo === undefined || rawRepo === "" ? undefined : rawRepo;
        const rawDays = Number.parseInt(c.req.query("days") ?? "", 10);
        const days =
          Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 90 ? rawDays : undefined;
        const detail = c.req.query("detail") === "full" ? "full" : "concise";
        try {
          return c.json(
            await buildRepoBriefing({
              ...(repo !== undefined && { repo }),
              ...(days !== undefined && { days }),
              detail,
            }),
          );
        } catch (err) {
          // A bare `repo` name that matched several repo roots — hand back the
          // candidates so the caller can re-issue with an absolute repoRoot.
          if (err instanceof AmbiguousRepoError) {
            return c.json({ error: err.message, candidates: err.candidates } as const, 400);
          }
          throw err;
        }
      })
      // Repo-local learning ledger — GET lists (scanning every known repo root
      // when `repo` is omitted), POST is the SAME upsert `log_learning` runs
      // (the web's Accept/Dismiss/Log buttons in PR3). `repo` is a normalized
      // repo key: an absolute path pins one ledger, a fallback bucket key has
      // no on-disk ledger (empty result).
      .get("/api/learnings", async (c) => {
        const rawRepo = c.req.query("repo");
        const repo = rawRepo === undefined || rawRepo === "" ? undefined : rawRepo;
        const rawStatus = c.req.query("status");
        const status =
          rawStatus === "open" ||
          rawStatus === "applied" ||
          rawStatus === "verified" ||
          rawStatus === "rejected"
            ? (rawStatus as LearningStatus)
            : undefined;
        return c.json(
          await listLearningsForRepo({
            ...(repo !== undefined && { repo }),
            ...(status !== undefined && { status }),
          }),
        );
      })
      .post("/api/learnings", async (c) => {
        let body: {
          repoPath?: string;
          source?: "claude-code" | "codex";
          sessionId?: string;
          id?: string;
          finding?: string;
          change?: string;
          expectedEffect?: string;
          status?: LearningStatus;
          verification?: LearningVerification;
          proposedBy?: "agent" | "human";
        };
        try {
          body = (await c.req.json()) as typeof body;
        } catch {
          return c.json({ error: "request body must be JSON" } as const, 400);
        }
        const repoRoot = await resolveLearningRepoRoot({
          ...(body.repoPath !== undefined && { repoPath: body.repoPath }),
          ...(body.source !== undefined && { source: body.source }),
          ...(body.sessionId !== undefined && { sessionId: body.sessionId }),
        });
        if (repoRoot === undefined) {
          return c.json(
            {
              error: "could not resolve a repo root — pass repoPath, or source + sessionId",
            } as const,
            400,
          );
        }
        const sourceSessions =
          body.source !== undefined && body.sessionId !== undefined
            ? [{ source: body.source, sessionId: body.sessionId }]
            : [];
        if (body.id === undefined) {
          if (body.finding === undefined || body.change === undefined) {
            return c.json(
              { error: "creating a learning requires finding and change" } as const,
              400,
            );
          }
          const learning = await createLearning(repoRoot, {
            finding: body.finding,
            change: body.change,
            ...(body.expectedEffect !== undefined && { expectedEffect: body.expectedEffect }),
            ...(body.status !== undefined && { status: body.status }),
            ...(body.proposedBy !== undefined && { proposedBy: body.proposedBy }),
            ...(sourceSessions.length > 0 && { sourceSessions }),
          });
          return c.json({ learning, created: true });
        }
        try {
          const learning = await updateLearning(repoRoot, body.id, {
            ...(body.status !== undefined && { status: body.status }),
            ...(body.finding !== undefined && { finding: body.finding }),
            ...(body.change !== undefined && { change: body.change }),
            ...(body.expectedEffect !== undefined && { expectedEffect: body.expectedEffect }),
            ...(body.verification !== undefined && { verification: body.verification }),
            ...(sourceSessions.length > 0 && { sourceSessions }),
          });
          return c.json({ learning, created: false });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) } as const, 404);
        }
      })
      // Source-prefixed routes, symmetric between the two harnesses: both
      // Claude and Codex now scope by `{id}` alone (a bare session UUID) —
      // Claude used to require a munged project dir too, but session ids are
      // UUIDv4, so a bare id resolves unambiguously (see `findRefById` in
      // `sources/claude.ts`); the project dir is still resolved internally,
      // it's just no longer part of the URL. The two prefixes are disjoint
      // path segments, so — unlike the old unprefixed routes this replaces —
      // there's no registration-order collision to guard against.
      .get("/api/sessions/claude-code/:id", async (c) => {
        const id = c.req.param("id");
        // `lastActivityAt` is computed fresh per request (never baked into the
        // mtime-cached `analysis` object — see `getClaudeLastActivityAt`'s doc
        // comment) so it always reflects the CURRENT filesystem state, even
        // when `analysis` itself is served from cache.
        const [analysis, lastActivityAt] = await Promise.all([
          claudeAdapter.getDetail({ id }),
          getClaudeLastActivityAt(id),
        ]);
        if (analysis === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        // Claude's `bashStats` is ALREADY the main+every-subagent joint pass
        // at both list-item and detail time (no forest-override discrepancy
        // the way Codex has — see `bash-percentile.ts`'s doc comment), so
        // `analysis.bashStats.totals` is directly the right basis to rank.
        const bashPercentile = await resolveBashPercentile(analysis, {
          estUsd: analysis.bashStats.totals.estUsd,
          resultChars: analysis.bashStats.totals.resultChars,
        });
        return c.json({
          analysis,
          lastActivityAt,
          ...(bashPercentile !== undefined && { bashPercentile }),
        });
      })
      .get("/api/sessions/claude-code/:id/timeline", async (c) => {
        const entries = await claudeAdapter.getTimeline(
          { id: c.req.param("id") },
          c.req.query("agent"),
        );
        if (entries === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ entries });
      })
      .get("/api/sessions/claude-code/:id/record/:line", async (c) => {
        const line = Number.parseInt(c.req.param("line"), 10);
        if (!Number.isInteger(line) || line < 1) {
          return c.json({ error: "record not found" } as const, 404);
        }
        const detail = await claudeAdapter.getRecordDetail(
          { id: c.req.param("id") },
          line,
          c.req.query("agent"),
        );
        if (detail === undefined) {
          return c.json({ error: "record not found" } as const, 404);
        }
        return c.json(detail);
      })
      // Conclusion-first single-session insight (the Story tab's FROM-THIS-
      // SESSION callout in PR4) — `buildSessionInsightFor` loads the session's
      // forest-inclusive analysis and folds it into the same `SessionInsight`
      // shape the `analyze_session` MCP tool returns, so the web callout and the
      // agent tool can't drift. `detail=full` returns every waste/driver row;
      // the default `concise` trims to the headline set (the callout only shows
      // the top few). A session that doesn't resolve is a JSON-shaped 404.
      .get("/api/sessions/claude-code/:id/insight", async (c) => {
        const detail = c.req.query("detail") === "full" ? "full" : "concise";
        const insight = await buildSessionInsightFor({
          source: "claude-code",
          sessionId: c.req.param("id"),
          detail,
        });
        if (insight === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json(insight);
      })
      // Goshuin Phase F: the full, UNCAPPED evaluation-trace export (see
      // `evaluation-trace.ts`'s doc comment) — the MCP `export_evaluation_trace`
      // tool serves the same trace but capped/truncated for a chat context;
      // this route is for external eval pipelines that want everything at
      // once. Claude-only — Codex has no reconstruction/wire-capture side
      // channels to merge in, so no route is registered for it (a request
      // there falls through to the generic /api/* 404 below).
      .get("/api/sessions/claude-code/:id/evaluation-trace", async (c) => {
        const trace = await assembleEvaluationTrace(c.req.param("id"));
        if (trace === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json(trace);
      })
      // Claude-only: Codex sub-agent threads are full sessions in their own
      // right (fetch them via the codex detail route above), not sidecar
      // transcripts scoped under a parent session.
      .get("/api/sessions/claude-code/:id/agents/:agentId", async (c) => {
        const analysis = await getAgentSession(c.req.param("id"), c.req.param("agentId"));
        if (analysis === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ analysis });
      })
      .get("/api/sessions/codex/:id", async (c) => {
        const id = c.req.param("id");
        const [analysis, lastActivityAt] = await Promise.all([
          codexAdapter.getDetail({ id }),
          getCodexLastActivityAt(id),
        ]);
        if (analysis === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        // Percentile ranking needs THIS session's own main-thread-only
        // figure — the SAME basis every repo-distribution sample was itself
        // built from (see `bash-percentile.ts`'s doc comment) — never
        // `analysis.bashStats`, which `getDetail` (= `getCodexSession`)
        // OVERRIDES with a forest-inclusive joint recompute once a
        // sub-agent forest exists.
        const mainOnlyBashStats = await getCodexSessionBashStatsMainOnly(id);
        const bashPercentile =
          mainOnlyBashStats === undefined
            ? undefined
            : await resolveBashPercentile(analysis, {
                estUsd: mainOnlyBashStats.totals.estUsd,
                resultChars: mainOnlyBashStats.totals.resultChars,
              });
        return c.json({
          analysis,
          lastActivityAt,
          ...(bashPercentile !== undefined && { bashPercentile }),
        });
      })
      .get("/api/sessions/codex/:id/timeline", async (c) => {
        const entries = await codexAdapter.getTimeline({ id: c.req.param("id") });
        if (entries === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ entries });
      })
      // Codex counterpart of the Claude insight route above — same
      // `SessionInsight` shape (a Codex analysis carries its own subagent forest
      // and bash/tool stats, so the insight builder reads it identically), with
      // `repetitions`/`taskExecutions` reported as unavailable via the payload's
      // own `notAvailable` field rather than an error.
      .get("/api/sessions/codex/:id/insight", async (c) => {
        const detail = c.req.query("detail") === "full" ? "full" : "concise";
        const insight = await buildSessionInsightFor({
          source: "codex",
          sessionId: c.req.param("id"),
          detail,
        });
        if (insight === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json(insight);
      })
      .get("/api/sessions/codex/:id/record/:line", async (c) => {
        const line = Number.parseInt(c.req.param("line"), 10);
        if (!Number.isInteger(line) || line < 1) {
          return c.json({ error: "record not found" } as const, 404);
        }
        const detail = await codexAdapter.getRecordDetail({ id: c.req.param("id") }, line);
        if (detail === undefined) {
          return c.json({ error: "record not found" } as const, 404);
        }
        return c.json(detail);
      })
      // SPA fallback — the browser (history) router serves client-side paths
      // like `/session/claude-code/<id>/timeline` that don't correspond to
      // any file on disk, so a hard reload / deep link needs the server to
      // hand back `index.html` and let `createBrowserRouter` (see
      // web/src/main.tsx) resolve the route itself. Registered LAST, after
      // every real API route above, so those always win their exact match
      // first — this only runs for a path none of them claimed.
      //
      // An unmatched `/api/*` path (typo'd or removed endpoint) must NOT
      // fall through to the SPA shell — it gets the same JSON-shaped 404 the
      // rest of the API uses instead.
      .get("*", async (c) => {
        if (c.req.path.startsWith("/api")) {
          return c.json({ error: "not found" } as const, 404);
        }
        if (indexHtml === undefined) {
          // No build available (dev/most test runs — the Vite dev server
          // handles this case directly, see vite.config.ts) — same bare 404
          // Hono would return with no catch-all registered at all.
          return c.notFound();
        }
        return indexHtml(c, async () => undefined);
      })
  );
}

export type AppType = ReturnType<typeof createApp>;
