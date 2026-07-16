import { useMemo, useState } from "react";
import type { AnySessionJson } from "../../api.js";
import { formatTime } from "../../format.js";
import {
  buildFileScopeSections,
  type FileAccessEntryLike,
  flattenSections,
  REREAD_THRESHOLD,
  TREE_CHEVRON_PX,
  TREE_INDENT_PX,
} from "./fileTree.js";
import { highlightSegments } from "./fuzzy.js";
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

const DIR_MARKER_TITLE =
  "directory — other listed paths lie beneath it; its reads are search/list commands (rg, grep, …) that took the whole directory as their root";

/** Renders `label` with `indices` (from `fuzzyMatch`, basename-local — see `localizeMatchIndices` in fileTree.ts) wrapped in `.fzy-hl` spans. */
function FuzzyLabel({ label, indices }: { label: string; indices: number[] | undefined }) {
  const segments = highlightSegments(label, indices);
  return (
    <>
      {segments.map((seg) =>
        seg.matched ? (
          <span className="fzy-hl" key={seg.start}>
            {seg.text}
          </span>
        ) : (
          <span key={seg.start}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * File access tree (Files & skills lens, row 1 left) — see
 * design-spec/15-files-skills.md's `.ftg` grid. Paths split into three scope
 * sections (Repository / Home / System — see `fileTree.ts`'s `scopeOf`),
 * each a compact ("VSCode compact folders") collapsible directory tree
 * rather than the old flat dir-header grouping; a directory row's Reads/
 * Edits cells are muted AGGREGATES over every descendant file, so a hot area
 * stays visible even collapsed. The re-read flag (`.rere` on both the path
 * and the read count) uses the DOCUMENTED >=3-reads rule rather than the
 * design spec's own inconsistent sample rendering.
 *
 * The header's fuzzy filter (`fuzzyMatch` in fuzzy.ts, case-insensitive
 * subsequence match against each file's scope-relative path) rebuilds every
 * section from only its matches while a query is active — directory
 * aggregates, section counts, and tree shape all narrow to the filtered set,
 * and collapse toggles go inert (everything force-expanded) since there's no
 * stable per-render collapse state to honor against a tree that's rebuilt on
 * every keystroke.
 *
 * A path with `injectedCount` — content pushed into context without a
 * Read/Edit call, e.g. CLAUDE.md/MEMORY.md system-reminders or a Skill's
 * `SKILL.md` — gets a muted `· inj N` marker next to its name; the Reads/Edits
 * cells stay numeric-only (already muted at 0 by the existing rule below), the
 * injected char count only surfaces in the marker's tooltip.
 *
 * A row proven to be a DIRECTORY (see `fileTree.ts`'s `isDirectory` proof) —
 * typically an rg/grep search root the shell-read heuristic counted whole —
 * renders with a trailing `/` and a muted `· dir` marker so it can't be
 * mistaken for a file named like one.
 */
export function FileAccessTree({ session }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const filtering = query.trim() !== "";

  const sections = useMemo(
    () => buildFileScopeSections(session.fileAccess, session.cwd, query),
    [session.fileAccess, session.cwd, query],
  );
  const rows = useMemo(
    () => flattenSections(sections, collapsed, filtering),
    [sections, collapsed, filtering],
  );
  const matchedTotal = useMemo(() => sections.reduce((sum, s) => sum + s.fileCount, 0), [sections]);

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="pan f1" style={{ minWidth: 0, padding: "10px 0 6px" }}>
      <div className="fx ac jb gap8" style={{ padding: "0 16px 8px" }}>
        <span className="lbl">File access · {matchedTotal}</span>
        <input
          className="chip"
          style={{ minWidth: "150px" }}
          type="text"
          placeholder="⌕ filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter files"
        />
      </div>
      <div className="ftg hdr">
        <span className="lbl">Path</span>
        <span className="lbl cellr">Reads</span>
        <span className="lbl cellr">Edits</span>
        <span className="lbl cellr">First</span>
        <span className="lbl cellr">Thread</span>
      </div>
      {session.fileAccess.length === 0 ? (
        <div className="ftg" style={{ borderBottom: 0 }}>
          <span className="fs12 mut">no file access recorded</span>
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : rows.length === 0 ? (
        <div className="ftg" style={{ borderBottom: 0 }}>
          <span className="fs12 mut">no matching files</span>
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : (
        rows.map((row, i) => {
          const isLast = i === rows.length - 1 && !session.fileAccessTruncated;
          const style = isLast ? { borderBottom: 0 } : undefined;

          if (row.kind === "section") {
            return (
              <div
                className="ftg"
                key={row.key}
                style={i > 0 ? { borderTop: "1px solid var(--bd)" } : undefined}
              >
                <span className="mono fs11 fw6">
                  {row.label}
                  <span className="mut" style={{ fontWeight: 400 }}>
                    {" "}
                    · {row.rootHint} · {row.fileCount} {row.fileCount === 1 ? "file" : "files"}
                  </span>
                </span>
                <span />
                <span />
                <span />
                <span />
              </div>
            );
          }

          if (row.kind === "dir") {
            return (
              <div className="ftg" key={row.key} style={style}>
                <span
                  className="mono fs11 mut"
                  style={{ paddingLeft: `${row.depth * TREE_INDENT_PX}px` }}
                >
                  {filtering ? (
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        width: "12px",
                        marginRight: "4px",
                        textAlign: "center",
                      }}
                    >
                      ▾
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="tree-toggle"
                      onClick={() => toggleCollapsed(row.key)}
                      aria-expanded={!row.collapsed}
                      aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.label}`}
                    >
                      {row.collapsed ? "▸" : "▾"}
                    </button>
                  )}
                  {row.label}
                </span>
                <span className="num fs12 cellr mut">{row.reads}</span>
                <span className="num fs12 cellr mut">{row.edits}</span>
                <span />
                <span />
              </div>
            );
          }

          const { entry } = row;
          const reread = entry.reads >= REREAD_THRESHOLD;
          return (
            <div className="ftg" key={row.key} style={style}>
              <span
                className={`mono fs11${reread ? " rere" : ""}`}
                style={{ paddingLeft: `${row.depth * TREE_INDENT_PX + TREE_CHEVRON_PX}px` }}
              >
                <FuzzyLabel
                  label={row.isDirectory ? `${row.name}/` : row.name}
                  indices={row.matchedIndices}
                />
                {row.isDirectory && (
                  <span className="fs10 mut" style={{ marginLeft: "6px" }} title={DIR_MARKER_TITLE}>
                    · dir
                  </span>
                )}
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
