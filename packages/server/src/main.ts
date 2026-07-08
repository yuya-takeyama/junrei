import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { resolvePort } from "./port.js";

const app = createApp();
const port = await resolvePort(process.env);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`junrei server listening on http://localhost:${info.port}`);
});
