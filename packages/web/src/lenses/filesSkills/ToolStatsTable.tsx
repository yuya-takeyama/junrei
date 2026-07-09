import type { SessionJson } from "../../api.js";

interface Props {
  session: SessionJson;
}

const EM_DASH = "—";

function categoriesText(categories: Partial<Record<string, number>>): string {
  const entries = Object.entries(categories).filter(
    (e): e is [string, number] => e[1] !== undefined,
  );
  if (entries.length === 0) return EM_DASH;
  return entries.map(([category, count]) => `${category} ×${count}`).join(", ");
}

/**
 * Tool stats table (Files & skills lens, row 2 left) — see
 * design-spec/15-files-skills.md. Rows sorted by call count descending
 * (already the order `computeToolStats` returns).
 */
export function ToolStatsTable({ session }: Props) {
  const stats = session.toolStats;

  return (
    <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }}>
      <div className="tstat hdr">
        <span className="lbl">Tool</span>
        <span className="lbl cellr">Calls</span>
        <span className="lbl cellr">Err</span>
        <span className="lbl">Error categories</span>
      </div>
      {stats.length === 0 ? (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no tool calls recorded</span>
        </div>
      ) : (
        stats.map((stat, i) => (
          <div
            className="tstat"
            key={stat.name}
            style={i === stats.length - 1 ? { borderBottom: 0 } : undefined}
          >
            <span className="mono fs11">{stat.name}</span>
            <span className="num fs12 cellr">{stat.callCount}</span>
            <span className={`num fs12 cellr${stat.errorCount > 0 ? " errtx" : " mut"}`}>
              {stat.errorCount}
            </span>
            <span className={`fs12${stat.errorCount > 0 ? "" : " mut"}`}>
              {categoriesText(stat.errorCategories)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
