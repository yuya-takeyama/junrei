import { Hono } from "hono";

export function createApp() {
  const app = new Hono().get("/api/health", (c) =>
    c.json({ status: "ok", name: "junrei" } as const),
  );
  return app;
}

export type AppType = ReturnType<typeof createApp>;
