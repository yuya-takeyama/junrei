import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { createMcpServer } from "./mcp.js";
import {
  claudeAdapter,
  codexAdapter,
  getAgentSession,
  listSessions,
  type SessionSourceFilter,
} from "./sessions.js";

export type { AnySessionListItem } from "./sessions.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function parseSourceFilter(raw: string | undefined): SessionSourceFilter | undefined {
  return raw === "claude-code" || raw === "codex" || raw === "all" ? raw : undefined;
}

export function createApp() {
  return (
    new Hono()
      .all("/mcp", async (c) => {
        // Stateless: a fresh server + transport per request keeps the endpoint
        // usable by any number of clients with no session bookkeeping.
        const transport = new StreamableHTTPTransport();
        await createMcpServer().connect(transport);
        return transport.handleRequest(c);
      })
      .get("/api/health", (c) => c.json({ status: "ok", name: "junrei" } as const))
      .get("/api/sessions", async (c) => {
        const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
        const limit = Number.isInteger(rawLimit)
          ? Math.min(Math.max(rawLimit, 1), MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT;
        // Omitted `source` means "all" — see `listSessions`'s doc comment.
        const source = parseSourceFilter(c.req.query("source"));
        return c.json({ sessions: await listSessions(limit, source) });
      })
      // Source-prefixed routes, symmetric between the two harnesses: Claude
      // scopes by `{project, id}` (a munged project dir plus the session
      // UUID), Codex by `{id}` alone (Codex has no project-dir concept). The
      // two prefixes are disjoint path segments, so — unlike the old
      // unprefixed routes this replaces — there's no registration-order
      // collision to guard against.
      .get("/api/sessions/claude-code/:project/:id", async (c) => {
        const analysis = await claudeAdapter.getDetail({
          project: c.req.param("project"),
          id: c.req.param("id"),
        });
        if (analysis === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ analysis });
      })
      .get("/api/sessions/claude-code/:project/:id/timeline", async (c) => {
        const entries = await claudeAdapter.getTimeline(
          { project: c.req.param("project"), id: c.req.param("id") },
          c.req.query("agent"),
        );
        if (entries === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ entries });
      })
      .get("/api/sessions/claude-code/:project/:id/record/:line", async (c) => {
        const line = Number.parseInt(c.req.param("line"), 10);
        if (!Number.isInteger(line) || line < 1) {
          return c.json({ error: "record not found" } as const, 404);
        }
        const detail = await claudeAdapter.getRecordDetail(
          { project: c.req.param("project"), id: c.req.param("id") },
          line,
          c.req.query("agent"),
        );
        if (detail === undefined) {
          return c.json({ error: "record not found" } as const, 404);
        }
        return c.json(detail);
      })
      // Claude-only: Codex sub-agent threads are full sessions in their own
      // right (fetch them via the codex detail route above), not sidecar
      // transcripts scoped under a parent session.
      .get("/api/sessions/claude-code/:project/:id/agents/:agentId", async (c) => {
        const analysis = await getAgentSession(
          c.req.param("project"),
          c.req.param("id"),
          c.req.param("agentId"),
        );
        if (analysis === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ analysis });
      })
      .get("/api/sessions/codex/:id", async (c) => {
        const analysis = await codexAdapter.getDetail({ id: c.req.param("id") });
        if (analysis === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ analysis });
      })
      .get("/api/sessions/codex/:id/timeline", async (c) => {
        const entries = await codexAdapter.getTimeline({ id: c.req.param("id") });
        if (entries === undefined) {
          return c.json({ error: "session not found" } as const, 404);
        }
        return c.json({ entries });
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
  );
}

export type AppType = ReturnType<typeof createApp>;
