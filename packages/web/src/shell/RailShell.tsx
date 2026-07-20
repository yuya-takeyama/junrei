import { Outlet, useLocation } from "react-router";
import { activeNavKey } from "../router.js";
import { RailLayout } from "./RailLayout.js";

/**
 * Layout route (see main.tsx) that renders the left nav rail around EVERY
 * screen — the three L0 pages and every deep route (session/agent detail
 * included) — by wrapping the matched child route's `<Outlet />` in
 * `RailLayout`. Derives the active nav item from the current pathname via
 * `activeNavKey` (router.ts) rather than a prop each page passes, so a page
 * can't drift out of sync with its own URL.
 */
export function RailShell() {
  const location = useLocation();
  const active = activeNavKey(location.pathname);
  return (
    <RailLayout active={active}>
      <Outlet />
    </RailLayout>
  );
}
