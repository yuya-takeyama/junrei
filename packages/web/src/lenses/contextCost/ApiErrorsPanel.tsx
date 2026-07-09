import type { SessionJson } from "../../api.js";
import { formatTime } from "../../format.js";

interface Props {
  session: SessionJson;
}

const EM_DASH = "—";

/**
 * API errors list (Context & cost lens, row 3, 420px fixed panel) — see
 * design-spec/14-context-cost.md's `.tstat` grid. Backed by `apiErrors`
 * (capped at 200 entries) while the header count uses the uncapped
 * `apiErrorCount`, matching the same cap/count split `StatStrip` already
 * relies on for its "Compact / err" cell.
 */
export function ApiErrorsPanel({ session }: Props) {
  const errors = session.apiErrors;
  const hiddenCount = session.apiErrorCount - errors.length;
  const lastIndex = errors.length - 1 + (hiddenCount > 0 ? 1 : 0);

  return (
    <div
      className="pan"
      style={{ width: "420px", flex: "none", padding: "14px 0 6px", boxSizing: "border-box" }}
    >
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        API errors · {session.apiErrorCount}
      </div>
      {errors.length === 0 ? (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no API errors</span>
        </div>
      ) : (
        <>
          {errors.map((err, i) => (
            <div
              className="tstat"
              key={err.line}
              style={i === lastIndex ? { borderBottom: 0 } : undefined}
            >
              <span className="mono fs11">
                {err.timestamp !== undefined ? formatTime(err.timestamp) : EM_DASH}
              </span>
              <span className="mono fs11 errtx">{err.status ?? EM_DASH}</span>
              <span className="mono fs11 mut">
                {err.retryAttempt !== undefined ? `×${err.retryAttempt}` : EM_DASH}
              </span>
              <span className="fs12 nowrap">{err.message ?? ""}</span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
              <span className="fs12 mut">+{hiddenCount} more not shown</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
