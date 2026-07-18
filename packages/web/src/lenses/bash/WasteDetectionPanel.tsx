import {
  type BashAsReadCallJson,
  type BashLargeResultJson,
  type BashNearDuplicateGroupJson,
  type BashRerunAfterErrorJson,
  type BashWasteJson,
  buildFlatWasteRows,
  buildNearDuplicateRows,
  buildRerunAfterErrorRows,
  capList,
  type FlatWasteRow,
  type WasteGroupRow,
} from "./bashLensFormat.js";

interface Props {
  waste: BashWasteJson;
}

/** Client-side cap for each subsection's primary list — none of the four `BashWaste` arrays are pre-capped by `@junrei/core` (unlike e.g. `apiErrors`, capped server-side at 200), so this panel caps for display the same way `TaskExecutionsPanel` does, with a "+N more not shown" footer reporting the true count either way. */
const GROUP_LIMIT = 10;
const FLAT_LIST_LIMIT = 20;
/** Occurrences shown inline per near-duplicate/rerun-after-error group — mirrors `RepetitionFindingsPanel`'s `LINE_PREVIEW_LIMIT`. */
const OCCURRENCE_LIMIT = 5;

function MoreFooter({ hiddenCount }: { hiddenCount: number }) {
  if (hiddenCount <= 0) return null;
  return <div className="mono fs11 mut mt8">+{hiddenCount} more not shown</div>;
}

function EmptySubsection({ text }: { text: string }) {
  return <div className="mono fs11 mut mt8">{text}</div>;
}

/** Free-form pattern+count+occurrences list shared by the near-duplicates and rerun-after-error subsections — mirrors `RepetitionFindingsPanel`'s own layout for the same shape, rather than forcing it into a grid. */
function WasteGroupList({
  rows,
  hiddenCount,
  emptyText,
}: {
  rows: readonly WasteGroupRow[];
  hiddenCount: number;
  emptyText: string;
}) {
  if (rows.length === 0) return <EmptySubsection text={emptyText} />;
  return (
    <>
      {rows.map((row) => (
        <div className="mono fs11 mt8" key={row.key}>
          <span className="rere">{row.pattern}</span>
          <span className="mut"> ×{row.count}</span>
          {row.examplesText !== undefined && (
            <div className="fs10 mut mt8">e.g. {row.examplesText}</div>
          )}
          <div className="fs10 mut mt8">{row.occurrencesText}</div>
        </div>
      ))}
      <MoreFooter hiddenCount={hiddenCount} />
    </>
  );
}

/** Flat per-call `.bflat` grid shared by the large-results and bash-as-read subsections. */
function FlatWasteList({
  rows,
  hiddenCount,
  emptyText,
}: {
  rows: readonly FlatWasteRow[];
  hiddenCount: number;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: "0 16px" }}>
        <EmptySubsection text={emptyText} />
      </div>
    );
  }
  return (
    <>
      <div className="bflat hdr">
        <span className="lbl">Command</span>
        <span className="lbl cellr">Result chars</span>
        <span className="lbl cellr">Thread</span>
        <span className="lbl cellr">Line</span>
      </div>
      {rows.map((row, i) => (
        <div
          className="bflat"
          key={row.key}
          style={i === rows.length - 1 && hiddenCount === 0 ? { borderBottom: 0 } : undefined}
        >
          <span className="mono fs11 nowrap" title={row.command}>
            {row.command}
          </span>
          <span className="num fs12 cellr">{row.resultCharsText}</span>
          <span className={`mono fs10 cellr ${row.thread.isMain ? "mut" : "amb"}`}>
            {row.thread.text}
          </span>
          <span className="num fs11 cellr mut">L{row.line}</span>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="bflat" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">+{hiddenCount} more not shown</span>
        </div>
      )}
    </>
  );
}

function NearDuplicatesSubsection({ groups }: { groups: readonly BashNearDuplicateGroupJson[] }) {
  const { shown, hiddenCount } = capList(groups, GROUP_LIMIT);
  const rows = buildNearDuplicateRows(shown, OCCURRENCE_LIMIT);
  return (
    <div className="pan" style={{ padding: "14px 16px" }}>
      <div className="lbl">Near-duplicate commands · {groups.length}</div>
      <WasteGroupList
        rows={rows}
        hiddenCount={hiddenCount}
        emptyText="no near-duplicate commands found"
      />
    </div>
  );
}

function LargeResultsSubsection({ results }: { results: readonly BashLargeResultJson[] }) {
  const { shown, hiddenCount } = capList(results, FLAT_LIST_LIMIT);
  const rows = buildFlatWasteRows(shown);
  return (
    <div className="pan" style={{ padding: "14px 0 6px" }}>
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        Large results · {results.length}
      </div>
      <FlatWasteList rows={rows} hiddenCount={hiddenCount} emptyText="no unusually large results" />
    </div>
  );
}

function RerunAfterErrorSubsection({ groups }: { groups: readonly BashRerunAfterErrorJson[] }) {
  const { shown, hiddenCount } = capList(groups, GROUP_LIMIT);
  const rows = buildRerunAfterErrorRows(shown, OCCURRENCE_LIMIT);
  return (
    <div className="pan" style={{ padding: "14px 16px" }}>
      <div className="lbl">Rerun after error · {groups.length}</div>
      <WasteGroupList
        rows={rows}
        hiddenCount={hiddenCount}
        emptyText="no reruns after an error found"
      />
    </div>
  );
}

function BashAsReadSubsection({ calls }: { calls: readonly BashAsReadCallJson[] }) {
  const { shown, hiddenCount } = capList(calls, FLAT_LIST_LIMIT);
  const rows = buildFlatWasteRows(shown);
  return (
    <div className="pan" style={{ padding: "14px 0 6px" }}>
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        Bash-as-Read · {calls.length}
      </div>
      <FlatWasteList
        rows={rows}
        hiddenCount={hiddenCount}
        emptyText="no Bash calls standing in for Read"
      />
    </div>
  );
}

/**
 * Waste detection (Bash lens panel 3) — four subsections over
 * `BashStats.waste`, quantitative only (counts + line-number occurrences, no
 * advice/hint prose — an explicit scope decision, see `bash-stats.ts`'s
 * `BashWaste` doc comment in `@junrei/core`). None of the four arrays are
 * pre-capped server-side, so every subsection caps its own list for display
 * while still reporting the true count in its header and a "+N more not
 * shown" footer when capped — see `GROUP_LIMIT`/`FLAT_LIST_LIMIT` above. Row
 * data for each subsection is precomputed by `bashLensFormat.ts`'s builders.
 */
export function WasteDetectionPanel({ waste }: Props) {
  return (
    <div className="col gap12 mt16">
      <NearDuplicatesSubsection groups={waste.nearDuplicates} />
      <LargeResultsSubsection results={waste.largeResults} />
      <RerunAfterErrorSubsection groups={waste.rerunAfterError} />
      <BashAsReadSubsection calls={waste.bashAsRead} />
    </div>
  );
}
