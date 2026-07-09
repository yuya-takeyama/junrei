import type { SessionJson } from "../../api.js";
import { formatDuration } from "../../format.js";

interface Props {
  session: SessionJson;
}

const EM_DASH = "—";
const RECENT_LIMIT = 30;

function statusClass(status: SessionJson["taskExecutions"][number]["status"]): string | undefined {
  if (status === "failed") return "errtx";
  if (status === "stopped") return "mut";
  return undefined;
}

/**
 * Task executions panel (Files & skills lens, row 2 right, 430px fixed) —
 * see design-spec/15-files-skills.md. When there are more than 30
 * executions, keeps the 30 most recent (by `startLine`) and reports the rest
 * via a muted footer row, mirroring `ApiErrorsPanel`'s cap/count split.
 */
export function TaskExecutionsPanel({ session }: Props) {
  const all = [...session.taskExecutions].sort((a, b) => a.startLine - b.startLine);
  const hiddenCount = Math.max(0, all.length - RECENT_LIMIT);
  const shown = hiddenCount > 0 ? all.slice(all.length - RECENT_LIMIT) : all;

  return (
    <div
      className="pan"
      style={{ width: "430px", flex: "none", padding: "14px 0 6px", boxSizing: "border-box" }}
    >
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        Task executions · {all.length}
      </div>
      {shown.length === 0 ? (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no task executions recorded</span>
        </div>
      ) : (
        shown.map((task, i) => {
          const statusCls = statusClass(task.status);
          return (
            <div
              className="tstat"
              key={task.taskId}
              style={i === shown.length - 1 && hiddenCount === 0 ? { borderBottom: 0 } : undefined}
            >
              <span className="mono fs11 nowrap">{task.name}</span>
              <span className="mono fs10 mut">{task.background ? "bg" : "fg"}</span>
              <span className="num fs11 cellr">
                {task.durationMs !== undefined ? formatDuration(task.durationMs) : EM_DASH}
              </span>
              <span className={statusCls !== undefined ? `fs12 ${statusCls}` : "fs12"}>
                {task.status}
              </span>
            </div>
          );
        })
      )}
      {hiddenCount > 0 && (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">+{hiddenCount} more not shown</span>
        </div>
      )}
    </div>
  );
}
