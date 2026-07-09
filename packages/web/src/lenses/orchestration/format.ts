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

/** "self/total" cost cell, e.g. "0.94/0.94", "17.29/23.41" — no $ sign, per the `.tn` grid spec. */
export function formatCostPair(self: number, total: number): string {
  return `${self.toFixed(2)}/${total.toFixed(2)}`;
}
