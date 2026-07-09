import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
import { App } from "./App.js";
import { SESSION_ROUTE_PATH } from "./router.js";
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
