import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { AgentShell } from "./AgentShell.js";
import { App } from "./App.js";
import { Home } from "./Home.js";
import { Learnings } from "./Learnings.js";
import {
  CLAUDE_AGENT_ROUTE_PATH,
  CLAUDE_SESSION_ROUTE_PATH,
  CODEX_AGENT_ROUTE_PATH,
  CODEX_SESSION_ROUTE_PATH,
  LEARNINGS_ROUTE_PATH,
  legacyClaudeSessionRedirectTarget,
  legacySessionListRedirectTarget,
  SESSIONS_ROUTE_PATH,
  TRENDS_ROUTE_PATH,
} from "./router.js";
import { SessionList } from "./SessionList.js";
import { SessionShell } from "./SessionShell.js";
import { RailShell } from "./shell/RailShell.js";
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

/**
 * Index route (`/`): the Briefing home, UNLESS the URL carries a legacy
 * session-list query (`?source=`/`?page=`/`?day=`) — a bookmark from when the
 * list lived at `/`. Those redirect to `/sessions` with the query preserved
 * (see `legacySessionListRedirectTarget`), so an old link keeps working; a
 * bare (or Briefing-only) `/` renders the home.
 */
function HomeOrRedirect() {
  const location = useLocation();
  const target = legacySessionListRedirectTarget(location.search);
  if (target !== undefined) return <Navigate replace to={target} />;
  return <Home />;
}

// Pre-history-router bookmarks still carry `#/session/...[?record=N]` — the
// query lived INSIDE the hash back when `createHashRouter` owned routing.
// Rewrite that hash into a real path (+ search string) before
// `createBrowserRouter` below reads the location, so a legacy hash bookmark
// resolves through the normal route table (and, for project-scoped legacy
// shapes, the `CatchAll` redirect above) instead of landing on a bare `/`
// with a stray `#/...` fragment.
if (window.location.hash.startsWith("#/")) {
  window.history.replaceState(null, "", window.location.hash.slice(1));
}

// Browser (history) router — plain paths like `/session/claude-code/id/timeline`,
// no `#` prefix (see router.ts for the path shapes).
// SessionShell takes an explicit `source` prop per route rather than inferring it from params —
// the Codex route has no `:project` segment to sniff a sentinel from (see router.ts).
const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      // Pathless layout route — renders the left nav rail (RailShell) around
      // EVERY child below, including session/agent detail, so no screen in
      // the app can render outside the rail or wrap itself in it a second
      // time (see shell/RailShell.tsx, RailLayout.tsx).
      {
        element: <RailShell />,
        children: [
          { index: true, element: <HomeOrRedirect /> },
          { path: SESSIONS_ROUTE_PATH, element: <SessionList /> },
          { path: LEARNINGS_ROUTE_PATH, element: <Learnings /> },
          // Trends was folded into the Briefing home (PR3) — its bookmark redirects there.
          { path: TRENDS_ROUTE_PATH, element: <Navigate replace to="/" /> },
          // The agent routes' static "agent" segment outranks the session routes'
          // optional ":lens?" — react-router's route ranking scores static segments
          // higher than dynamic ones regardless of declaration order, so
          // `/session/claude-code/id/agent/x` always matches the agent route rather
          // than being parsed as CLAUDE_SESSION_ROUTE_PATH with lens="agent" (see router.test.ts).
          { path: CLAUDE_AGENT_ROUTE_PATH, element: <AgentShell source="claude-code" /> },
          { path: CODEX_AGENT_ROUTE_PATH, element: <AgentShell source="codex" /> },
          { path: CLAUDE_SESSION_ROUTE_PATH, element: <SessionShell source="claude-code" /> },
          { path: CODEX_SESSION_ROUTE_PATH, element: <SessionShell source="codex" /> },
          { path: "*", element: <CatchAll /> },
        ],
      },
    ],
  },
]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
