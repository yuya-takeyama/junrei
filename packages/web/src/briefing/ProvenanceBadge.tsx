/**
 * Provenance badge (Pattern C) — the small "where did this panel's data come
 * from" tag shown at the top-right of each data panel on the Briefing home and
 * Learnings board. It names the originating MCP/REST call (e.g. `briefing()`)
 * and the response's own `_meta.approxTokens` context-cost estimate, so a
 * reader can see at a glance that every number on the panel traces to one
 * server call (and roughly what that call costs to hold in context).
 *
 * `approxTokens` is optional — panels fed by `POST`/list endpoints with no
 * `_meta` envelope render just the call name.
 */
export function ProvenanceBadge({
  call,
  approxTokens,
}: {
  call: string;
  approxTokens?: number | undefined;
}) {
  return (
    <span
      className="prov-badge mono"
      title={`Source: ${call}${approxTokens !== undefined ? ` · ~${String(approxTokens)} tokens in context` : ""}`}
    >
      <span className="prov-call">{call}</span>
      {approxTokens !== undefined && (
        <span className="prov-tok">~{formatApproxTokens(approxTokens)}t</span>
      )}
    </span>
  );
}

/** Compact token count for the badge — `1.2k` past a thousand, exact below. */
function formatApproxTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
