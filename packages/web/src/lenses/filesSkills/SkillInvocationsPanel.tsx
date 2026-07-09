import type { AnySessionJson } from "../../api.js";
import { formatTime } from "../../format.js";
import { formatInjectedSize } from "./skillInvocationFormat.js";

interface Props {
  session: AnySessionJson;
}

const EM_DASH = "—";

/**
 * Skill invocations panel (Files & skills lens, row 1 right column, top) —
 * see design-spec/15-files-skills.md. Reuses the `.tstat` grid shared with
 * the Context & cost lens's API-errors panel.
 */
export function SkillInvocationsPanel({ session }: Props) {
  const invocations = session.skillInvocations;

  return (
    <div className="pan" style={{ padding: "14px 0 6px" }}>
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        Skill invocations · {invocations.length}
      </div>
      {invocations.length === 0 ? (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no skill invocations</span>
        </div>
      ) : (
        invocations.map((inv, i) => {
          // injectedChars is the harness-injected SKILL.md body — the actual
          // context payload. resultChars (the ~44-char "Launching skill: …"
          // ACK) is deliberately not shown here: presenting it as the size
          // would read as "how much this skill cost", which it isn't.
          const injectedSize = formatInjectedSize(inv.injectedChars);
          return (
            <div
              className="tstat"
              key={`${inv.kind}-${String(inv.line)}`}
              style={i === invocations.length - 1 ? { borderBottom: 0 } : undefined}
            >
              <span className="mono fs11">{inv.name}</span>
              <span className="mono fs11 mut">
                {inv.userTurn !== undefined ? `t${inv.userTurn}` : EM_DASH}
              </span>
              <span className="mono fs11 mut">
                {inv.timestamp !== undefined ? formatTime(inv.timestamp) : EM_DASH}
              </span>
              <span className="fs12 nowrap">
                {inv.argsPreview ?? "(no args)"}
                {injectedSize !== undefined && (
                  <>
                    {" "}
                    · <span className="num">{injectedSize}</span>
                  </>
                )}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
