import type { AnySessionJson } from "../api.js";
import type { SessionRef } from "../router.js";
import { ContextGrowthChart } from "./ContextGrowthChart.js";
import { CostByModelChart } from "./CostByModelChart.js";
import { FirstPromptPanel } from "./FirstPromptPanel.js";

interface Props {
  session: AnySessionJson;
  sessionRef: SessionRef;
}

/**
 * Session overview (L1) — see design-spec/11-session-overview.md. Renders
 * the headline charts row (context growth, cost by model) plus the
 * first-prompt strip; the title block and stat strip are shell chrome
 * shared across every lens (see SessionShell.tsx / shell/StatStrip.tsx).
 *
 * Tool stats / exploration / repetitions / task executions / the subagent
 * tree that used to live on the legacy SessionDetail screen move to the
 * Files & skills and Orchestration lenses in later PRs — they intentionally
 * don't appear here.
 *
 * Reused as-is for Codex sessions (`session.source === "codex"`) — every
 * child component here already accepts `AnySessionJson` and narrows
 * internally wherever Claude-only data would otherwise be assumed.
 */
export function Overview({ session, sessionRef }: Props) {
  return (
    <>
      <ContextGrowthChart session={session} />
      <CostByModelChart session={session} />
      <FirstPromptPanel session={session} sessionRef={sessionRef} />
    </>
  );
}
