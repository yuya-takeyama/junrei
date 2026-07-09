import { Outlet } from "react-router";

/** Root layout — the router (see main.tsx) renders SessionList / SessionShell into this. */
export function App() {
  return (
    <div className="app">
      <Outlet />
    </div>
  );
}
