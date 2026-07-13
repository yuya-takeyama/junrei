import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { AgentShell } from "./AgentShell.js";
import { App } from "./App.js";
import {
  AGENT_ROUTE_PATH,
  CLAUDE_SESSION_ROUTE_PATH,
  CODEX_SESSION_ROUTE_PATH,
  legacyClaudeSessionRedirectTarget,
} from "./router.js";
import { SessionList } from "./SessionList.js";
import { SessionShell } from "./SessionShell.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root element not found");
}

/**
 * Catch-all route element: redirects a LONG-shape legacy Claude session URL
 * (still carrying the now-defunct `:project` segment — see
 * `legacyClaudeSessionRedirectTarget`'s doc comment) to its new project-less
 * path, or falls back to the session list for anything else — mirroring the
 * old parseRoute()'s default for unknown hashes.
 */
function CatchAll() {
  const location = useLocation();
  const target = legacyClaudeSessionRedirectTarget(location.pathname, location.search);
  if (target !== undefined) return <Navigate replace to={target} />;
  return <SessionList />;
}

// Hash-based router — matches the app's historical `#/...` URLs (see router.ts).
// SessionShell takes an explicit `source` prop per route rather than inferring it from params —
// the Codex route has no `:project` segment to sniff a sentinel from (see router.ts).
const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <SessionList /> },
      // AGENT_ROUTE_PATH's static "agent" segment outranks CLAUDE_SESSION_ROUTE_PATH's
      // optional ":lens?" — react-router's route ranking scores static segments
      // higher than dynamic ones regardless of declaration order, so
      // `/session/claude-code/id/agent/x` always matches this route rather than
      // being parsed as CLAUDE_SESSION_ROUTE_PATH with lens="agent" (see router.test.ts).
      { path: AGENT_ROUTE_PATH, element: <AgentShell /> },
      { path: CLAUDE_SESSION_ROUTE_PATH, element: <SessionShell source="claude-code" /> },
      { path: CODEX_SESSION_ROUTE_PATH, element: <SessionShell source="codex" /> },
      { path: "*", element: <CatchAll /> },
    ],
  },
]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
