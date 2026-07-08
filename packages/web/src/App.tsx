import { useEffect, useState } from "react";
import { SessionDetail } from "./SessionDetail.js";
import { SessionList } from "./SessionList.js";

type Route = { view: "list" } | { view: "session"; project: string; id: string };

function parseRoute(hash: string): Route {
  const match = /^#\/session\/([^/]+)\/([^/]+)$/.exec(hash);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return {
      view: "session",
      project: decodeURIComponent(match[1]),
      id: decodeURIComponent(match[2]),
    };
  }
  return { view: "list" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="layout">
      <header className="app-header">
        <h1>
          <a href="#/" style={{ color: "inherit" }}>
            Junrei
          </a>
        </h1>
        <span className="tagline">Agent Statistics Analyzer — quantitative session metrics</span>
      </header>
      {route.view === "list" ? (
        <SessionList />
      ) : (
        <SessionDetail project={route.project} id={route.id} />
      )}
    </div>
  );
}
