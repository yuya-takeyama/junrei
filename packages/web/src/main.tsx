import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
import { AgentShell } from "./AgentShell.js";
import { App } from "./App.js";
import { AGENT_ROUTE_PATH, SESSION_ROUTE_PATH } from "./router.js";
import { SessionList } from "./SessionList.js";
import { SessionShell } from "./SessionShell.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root element not found");
}

// Hash-based router — matches the app's historical `#/...` URLs (see router.ts). The catch-all
// falls back to the session list, mirroring the old parseRoute()'s default for unknown hashes.
const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <SessionList /> },
      // AGENT_ROUTE_PATH's static "agent" segment outranks SESSION_ROUTE_PATH's
      // optional ":lens?" — react-router's route ranking scores static segments
      // higher than dynamic ones regardless of declaration order, so
      // `/session/p/id/agent/x` always matches this route rather than being
      // parsed as SESSION_ROUTE_PATH with lens="agent" (see router.test.ts).
      { path: AGENT_ROUTE_PATH, element: <AgentShell /> },
      { path: SESSION_ROUTE_PATH, element: <SessionShell /> },
      { path: "*", element: <SessionList /> },
    ],
  },
]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
