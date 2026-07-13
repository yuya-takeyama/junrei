export type NodeStatus = "run" | "done" | "fail" | undefined;

/**
 * Small dot + fixed-width label — shared by the Tree view's Status column
 * (TreeView.tsx) and the agent detail panel's Status row (DetailPanel.tsx)
 * so both render the exact same status look. `status` is already the
 * display-ready value from `nodeStatus`/the main row's own `sessionLive`
 * ternary (agentTree.ts) — this component only renders it, it doesn't derive
 * anything.
 */
export function StatusCell({ status }: { status: NodeStatus }) {
  if (status === undefined) return <span className="mut fs11">—</span>;
  return (
    <span className={`st st-${status} mono fs11`}>
      <span className="st-dot" />
      {status}
    </span>
  );
}
