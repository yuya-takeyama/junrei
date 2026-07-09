import type { AnySessionJson } from "../../api.js";
import { formatTime } from "../../format.js";
import { buildFileTreeRows, type FileAccessEntryLike, REREAD_THRESHOLD } from "./fileTree.js";
import { formatInjectedSize } from "./skillInvocationFormat.js";

interface Props {
  session: AnySessionJson;
}

const EM_DASH = "—";
const THREAD_LABEL: Record<AnySessionJson["fileAccess"][number]["threads"], string> = {
  main: "M",
  subagent: "S",
  both: "M+S",
};

/** Hover detail for the `inj N` marker — counts only in the row itself (see `FileAccessTree`'s doc comment), the char total goes in the tooltip. */
function injectedTitle(entry: FileAccessEntryLike): string {
  const count = entry.injectedCount ?? 0;
  const noun = count === 1 ? "injection" : "injections";
  const size = formatInjectedSize(entry.injectedChars);
  return size !== undefined ? `${String(count)} ${noun}, ${size}` : `${String(count)} ${noun}`;
}

/**
 * File access tree (Files & skills lens, row 1 left) — see
 * design-spec/15-files-skills.md's `.ftg` grid. Directory rows group files by
 * their (cwd-relative or `~`-shortened) parent directory; the re-read flag
 * (`.rere` on both the path and the read count) uses the DOCUMENTED >=3-reads
 * rule rather than the design spec's own inconsistent sample rendering.
 *
 * A path with `injectedCount` — content pushed into context without a
 * Read/Edit call, e.g. CLAUDE.md/MEMORY.md system-reminders or a Skill's
 * `SKILL.md` — gets a muted `· inj N` marker next to its name; the Reads/Edits
 * cells stay numeric-only (already muted at 0 by the existing rule below), the
 * injected char count only surfaces in the marker's tooltip.
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
                {entry.injectedCount !== undefined && (
                  <span
                    className="fs10 mut"
                    style={{ marginLeft: "6px" }}
                    title={injectedTitle(entry)}
                  >
                    · inj {entry.injectedCount}
                  </span>
                )}
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
