/**
 * Compact duration format used only in the Orchestration lens's dense
 * tables/tooltips — e.g. "2h14m", "4m02s", "58s" (no spaces, seconds
 * zero-padded once minutes are shown). See design-spec/13-orchestration.md's
 * `.tn` sample row values. Distinct from the shared `formatDuration` in
 * ../../format.ts (used elsewhere with spaces, e.g. "2m 13s" in this lens's
 * own detail-panel `.kv` grid — the design mockup uses both styles
 * depending on density).
 */
export function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * "$X.XX" cost cell — always 2 decimals, unlike the shared `formatUsd` in
 * ../../format.ts (which drops to 0 decimals at $100+ for the L1 stat tiles).
 * The Orchestration lens's dense `.tn` table keeps 2 decimals at every
 * magnitude, matching what the retired `formatCostPair` rendered for its
 * self/total pair.
 */
export function formatCostCell(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Percent-of-session-total cost share cell, e.g. "34%", "<1%", "—" — the
 * `.tn` table's "%" column. `share` is the 0..1 fraction `costShare` (in
 * agentTree.ts) computes; `undefined` (no priced session total to divide by)
 * renders as "—". A nonzero share that rounds to 0% still reflects real
 * spend, not nothing — flooring it to a bare "0%" would read as "this agent
 * cost nothing", so it renders "<1%" instead.
 */
export function formatPctShare(share: number | undefined): string {
  if (share === undefined) return "—";
  const pct = share * 100;
  if (pct > 0 && Math.round(pct) === 0) return "<1%";
  return `${Math.round(pct)}%`;
}
