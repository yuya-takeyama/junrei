import type { SessionJson } from "../../api.js";
import { shortSubject } from "./fileTree.js";

interface Props {
  session: SessionJson;
}

const LINE_PREVIEW_LIMIT = 5;

/**
 * Repetition findings panel (Files & skills lens, row 1 right column,
 * bottom) — free-form list, not a grid, per design-spec/15-files-skills.md.
 * Presented as an observation, never a verdict.
 */
export function RepetitionFindingsPanel({ session }: Props) {
  const findings = session.repetitions;

  return (
    <div className="pan" style={{ padding: "14px 16px" }}>
      <div className="lbl mb8">Repetition findings · {findings.length}</div>
      {findings.length === 0 ? (
        <div className="mono fs11 mut mt8">no repetition findings</div>
      ) : (
        findings.map((finding, i) => {
          const shown = finding.lines.slice(0, LINE_PREVIEW_LIMIT);
          const lineList = `L${shown.join(", ")}${finding.lines.length > shown.length ? ", …" : ""}`;
          return (
            <div
              className="mono fs11 mt8"
              key={`${finding.kind}-${finding.tool}-${String(finding.lines[0])}`}
              style={i === findings.length - 1 ? { marginBottom: "2px" } : undefined}
            >
              <span className="rere">
                {finding.tool} {shortSubject(finding.subject)} ×{finding.count}
              </span>
              <span className="mut"> · {lineList}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
