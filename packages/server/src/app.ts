import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { createMcpServer } from "./mcp.js";
import { getSession, listSessions } from "./sessions.js";

export type { SessionListItem } from "./sessions.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export function createApp() {
  return new Hono()
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
      return c.json({ sessions: await listSessions(limit) });
    })
    .get("/api/sessions/:project/:id", async (c) => {
      const analysis = await getSession(c.req.param("project"), c.req.param("id"));
      if (analysis === undefined) {
        return c.json({ error: "session not found" } as const, 404);
      }
      return c.json(analysis);
    });
}

export type AppType = ReturnType<typeof createApp>;
