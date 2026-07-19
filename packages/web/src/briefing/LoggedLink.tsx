import { Link } from "react-router";
import { LEARNINGS_ROUTE_PATH } from "../router.js";

/**
 * Post-write feedback for a "Log learning" button: once the POST succeeds the
 * button is replaced by this link. Logging is intentionally frictionless (no
 * confirm dialog — the agent-first path shouldn't nag), so the affordance the
 * link advertises IS the undo path: a mislog is reversed by Dismiss on the
 * Learnings board, which the tooltip spells out. It routes to `/learnings` so
 * the just-created open learning is one click away.
 */
export const LOGGED_UNDO_HINT =
  "Logged as an open learning. To undo, use Dismiss on the Learnings board.";

export function LoggedLink({ className }: { className?: string }) {
  return (
    <Link
      className={className ?? "linkc mono fs11 logged-link"}
      to={`/${LEARNINGS_ROUTE_PATH}`}
      title={LOGGED_UNDO_HINT}
    >
      Logged ✓ → View in Learnings
    </Link>
  );
}
