import { useEffect, useState } from "react";
import { parseRoute, type Route } from "./router.js";
import { SessionList } from "./SessionList.js";
import { SessionShell } from "./SessionShell.js";

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="app">
      {route.view === "list" ? (
        <SessionList />
      ) : (
        <SessionShell
          project={route.project}
          id={route.id}
          lens={route.lens}
          {...(route.record !== undefined && { record: route.record })}
        />
      )}
    </div>
  );
}
