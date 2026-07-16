import { useMemo, useState } from "react";
import type { AnySessionJson } from "../../api.js";
import { formatTime } from "../../format.js";
import { fuzzyMatch, highlightSegments } from "./fuzzy.js";
import { formatInjectedSize } from "./skillInvocationFormat.js";

interface Props {
  session: AnySessionJson;
}

const EM_DASH = "—";

/** Renders `label` with `indices` (from `fuzzyMatch`) wrapped in `.fzy-hl` spans — same treatment as `FileAccessTree`'s `FuzzyLabel`, kept as its own tiny copy since sharing it across two component files would need a third module for one four-line render helper. */
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
 * Skill invocations panel (Files & skills lens, row 1 right column, top) —
 * see design-spec/15-files-skills.md. Reuses the `.tstat` grid shared with
 * the Context & cost lens's API-errors panel.
 *
 * The header's fuzzy filter (`fuzzyMatch` in fuzzy.ts, same case-insensitive
 * subsequence match `FileAccessTree` uses) matches against `name` only,
 * highlighting matched characters the same way.
 */
export function SkillInvocationsPanel({ session }: Props) {
  const [query, setQuery] = useState("");
  const invocations = session.skillInvocations;
  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed === "") return invocations.map((inv) => ({ inv, matchedIndices: undefined }));
    return invocations.flatMap((inv) => {
      const matchedIndices = fuzzyMatch(inv.name, trimmed);
      return matchedIndices === undefined ? [] : [{ inv, matchedIndices }];
    });
  }, [invocations, query]);

  return (
    <div className="pan" style={{ padding: "14px 0 6px" }}>
      <div className="fx ac jb gap8" style={{ padding: "0 16px 8px" }}>
        <span className="lbl">Skill invocations · {filtered.length}</span>
        <input
          className="chip"
          style={{ minWidth: "120px" }}
          type="text"
          placeholder="⌕ filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter skill invocations"
        />
      </div>
      {invocations.length === 0 ? (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no skill invocations</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="tstat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">no matching invocations</span>
        </div>
      ) : (
        filtered.map(({ inv, matchedIndices }, i) => {
          // injectedChars is the harness-injected SKILL.md body — the actual
          // context payload. resultChars (the ~44-char "Launching skill: …"
          // ACK) is deliberately not shown here: presenting it as the size
          // would read as "how much this skill cost", which it isn't.
          const injectedSize = formatInjectedSize(inv.injectedChars);
          return (
            <div
              className="tstat"
              key={`${inv.kind}-${String(inv.line)}`}
              style={i === filtered.length - 1 ? { borderBottom: 0 } : undefined}
            >
              <span className="mono fs11">
                <FuzzyLabel label={inv.name} indices={matchedIndices} />
              </span>
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
