import type { AnySessionJson } from "../../api.js";
import { formatTime } from "../../format.js";
import { buildFileTreeRows, REREAD_THRESHOLD } from "./fileTree.js";

interface Props {
  session: AnySessionJson;
}

const EM_DASH = "—";
const THREAD_LABEL: Record<AnySessionJson["fileAccess"][number]["threads"], string> = {
  main: "M",
  subagent: "S",
  both: "M+S",
};

/**
 * File access tree (Files & skills lens, row 1 left) — see
 * design-spec/15-files-skills.md's `.ftg` grid. Directory rows group files by
 * their (cwd-relative or `~`-shortened) parent directory; the re-read flag
 * (`.rere` on both the path and the read count) uses the DOCUMENTED >=3-reads
 * rule rather than the design spec's own inconsistent sample rendering.
 */
export function FileAccessTree({ session }: Props) {
  const rows = buildFileTreeRows(session.fileAccess, session.cwd);

  return (
    <div className="pan f1" style={{ minWidth: 0, padding: "6px 0" }}>
      <div className="ftg hdr">
        <span className="lbl">File access</span>
        <span className="lbl cellr">Reads</span>
        <span className="lbl cellr">Edits</span>
        <span className="lbl cellr">First</span>
        <span className="lbl cellr">Thread</span>
      </div>
      {rows.length === 0 ? (
        <div className="ftg" style={{ borderBottom: 0 }}>
          <span className="fs12 mut">no file access recorded</span>
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : (
        rows.map((row, i) => {
          const isLast = i === rows.length - 1 && !session.fileAccessTruncated;
          if (row.kind === "dir") {
            return (
              <div className="ftg" key={row.key} style={isLast ? { borderBottom: 0 } : undefined}>
                <span className="mono fs11 mut">{row.label}</span>
                <span />
                <span />
                <span />
                <span />
              </div>
            );
          }
          const { entry } = row;
          const reread = entry.reads >= REREAD_THRESHOLD;
          return (
            <div className="ftg" key={row.key} style={isLast ? { borderBottom: 0 } : undefined}>
              <span
                className={`mono fs11${reread ? " rere" : ""}`}
                style={row.indent ? { paddingLeft: "16px" } : undefined}
              >
                {row.label}
              </span>
              <span
                className={`num fs12 cellr${reread ? " rere" : entry.reads === 0 ? " mut" : ""}`}
              >
                {entry.reads}
              </span>
              <span className={`num fs12 cellr${entry.edits === 0 ? " mut" : ""}`}>
                {entry.edits}
              </span>
              <span className="num fs11 cellr mut">
                {entry.firstTouchTimestamp !== undefined
                  ? formatTime(entry.firstTouchTimestamp)
                  : EM_DASH}
              </span>
              <span className={`mono fs10 cellr ${entry.threads === "subagent" ? "amb" : "mut"}`}>
                {THREAD_LABEL[entry.threads]}
              </span>
            </div>
          );
        })
      )}
      {session.fileAccessTruncated && (
        <div className="ftg" style={{ borderBottom: 0 }}>
          <span className="fs12 mut">
            +{session.fileAccessOmittedCount ?? 0} more files not shown
          </span>
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
