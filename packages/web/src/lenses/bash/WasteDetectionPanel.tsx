import { defaultDirFor, type SortColumnDef, type SortSpec, sortRows } from "../../tableSort.js";
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
import { SortableHeaderCell } from "./SortableHeaderCell.js";

export type FlatWasteSortKey = "command" | "resultChars" | "thread" | "line";

/** Column defs for `sortRows` — shared by both flat waste grids (large results, bash-as-read), since `FlatWasteRow` is one shape used for either (see `buildFlatWasteRows`'s doc comment in `bashLensFormat.ts`). `thread` compares the row's shortened display text, the same string every row shows. */
const FLAT_WASTE_COLUMNS: readonly SortColumnDef<FlatWasteRow, FlatWasteSortKey>[] = [
  { key: "command", type: "string", value: (r) => r.command },
  { key: "resultChars", type: "numeric", value: (r) => r.resultChars },
  { key: "thread", type: "string", value: (r) => r.thread.text },
  { key: "line", type: "numeric", value: (r) => r.line },
];

function flatWasteColumnType(key: FlatWasteSortKey): "numeric" | "string" {
  return FLAT_WASTE_COLUMNS.find((c) => c.key === key)?.type ?? "numeric";
}

/** `computeLargeResults`'s own order (`@junrei/core`'s `bash-stats.ts`) — result chars desc. */
export const DEFAULT_LARGE_RESULTS_SORT: SortSpec<FlatWasteSortKey> = {
  key: "resultChars",
  dir: "desc",
};

/**
 * `computeBashAsRead` has no explicit sort (`@junrei/core`'s `bash-stats.ts`)
 * — it emits calls in collection order (main thread first, then each
 * subagent, each internally chronological), which isn't itself one of this
 * table's sortable columns. Rather than inventing a stand-in for "roughly
 * the order it happened in", this defaults to resultChars-desc — same as
 * `DEFAULT_LARGE_RESULTS_SORT` and this panel's whole purpose (biggest waste
 * first): a Bash-as-Read call is waste in proportion to how much result text
 * it dumped in place of a cheap `Read`, so the worst offenders belong at the
 * top with no click required.
 */
export const DEFAULT_BASH_AS_READ_SORT: SortSpec<FlatWasteSortKey> = {
  key: "resultChars",
  dir: "desc",
};

interface Props {
  waste: BashWasteJson;
  largeResultsSortSpec: SortSpec<FlatWasteSortKey>;
  onLargeResultsSortChange: (spec: SortSpec<FlatWasteSortKey>) => void;
  bashAsReadSortSpec: SortSpec<FlatWasteSortKey>;
  onBashAsReadSortChange: (spec: SortSpec<FlatWasteSortKey>) => void;
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

/**
 * Flat per-call `.bflat` grid shared by the large-results and bash-as-read
 * subsections — sortable via the shared `FLAT_WASTE_COLUMNS`, each
 * subsection with its own `sortSpec`/`onSortChange` (see `Props` above), so
 * the two grids sort independently of each other.
 *
 * `rows` arrives ALREADY sorted+capped — the caller sorts the subsection's
 * full row set and only then caps to `FLAT_LIST_LIMIT` (see
 * `LargeResultsSubsection`/`BashAsReadSubsection`), rather than capping
 * first and sorting the display-only slice: capping first would mean a
 * non-default sort only ever reorders whichever rows happened to win the
 * *old* sort's top-`FLAT_LIST_LIMIT` cut, not the true top-N under the
 * newly chosen column. This component only renders — it doesn't call
 * `sortRows` itself.
 */
function FlatWasteList({
  rows,
  hiddenCount,
  emptyText,
  sortSpec,
  onSortChange,
}: {
  rows: readonly FlatWasteRow[];
  hiddenCount: number;
  emptyText: string;
  sortSpec: SortSpec<FlatWasteSortKey>;
  onSortChange: (spec: SortSpec<FlatWasteSortKey>) => void;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: "0 16px" }}>
        <EmptySubsection text={emptyText} />
      </div>
    );
  }

  const header = (key: FlatWasteSortKey, label: string, align?: "right") => (
    <SortableHeaderCell
      label={label}
      columnKey={key}
      defaultDir={defaultDirFor(flatWasteColumnType(key))}
      sortSpec={sortSpec}
      onSortChange={onSortChange}
      {...(align !== undefined && { align })}
    />
  );

  return (
    // `role="table"`/`role="row"` restore the ancestry a `<th aria-sort>` needs to
    // keep its implicit columnheader role (and thus expose `aria-sort` to AT) — see
    // `SortableHeaderCell.tsx`'s doc comment. `.bflat` isn't one shared grid but a
    // per-row `display:grid` repeated on every row `<div>` (header + data alike), so
    // this wrapping `<div role="table">` replaces the old bare fragment, giving the
    // rows a real table ancestor without pulling the subsection's `.lbl` title (a
    // sibling in the caller, not a row) into the same role="table" container. No
    // `<table>`/`<tr>` fits this CSS-grid-of-`<div>`s layout, so Biome's
    // semantic-elements preference is deliberately overridden below — a
    // narrowly-scoped exception, not a rule to relax repo-wide.
    // biome-ignore lint/a11y/useSemanticElements: no <table> fits this CSS-grid-of-divs layout; role="table" is the closest available semantics
    <div role="table">
      {/* biome-ignore lint/a11y/useSemanticElements: no <tr> fits this CSS-grid-of-divs row; role="row" is the closest available semantics (see role="table" comment above) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: a static (non-interactive) row, not an ARIA grid/treegrid row — doesn't belong in the tab sequence */}
      <div className="bflat hdr" role="row">
        {header("command", "Command")}
        {header("resultChars", "Result chars", "right")}
        {header("thread", "Thread", "right")}
        {header("line", "Line", "right")}
      </div>
      {rows.map((row, i) => (
        // biome-ignore lint/a11y/useSemanticElements: same as the header row above
        // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
        <div
          className="bflat"
          role="row"
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
        // biome-ignore lint/a11y/useSemanticElements: same as the header row above
        // biome-ignore lint/a11y/useFocusableInteractive: same as the header row above
        <div className="bflat" role="row" style={{ borderBottom: 0, gridTemplateColumns: "1fr" }}>
          <span className="fs12 mut">+{hiddenCount} more not shown</span>
        </div>
      )}
    </div>
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

function LargeResultsSubsection({
  results,
  sortSpec,
  onSortChange,
}: {
  results: readonly BashLargeResultJson[];
  sortSpec: SortSpec<FlatWasteSortKey>;
  onSortChange: (spec: SortSpec<FlatWasteSortKey>) => void;
}) {
  const sorted = sortRows(buildFlatWasteRows(results), sortSpec, FLAT_WASTE_COLUMNS);
  const { shown, hiddenCount } = capList(sorted, FLAT_LIST_LIMIT);
  return (
    <div className="pan" style={{ padding: "14px 0 6px" }}>
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        Large results · {results.length}
      </div>
      <FlatWasteList
        rows={shown}
        hiddenCount={hiddenCount}
        emptyText="no unusually large results"
        sortSpec={sortSpec}
        onSortChange={onSortChange}
      />
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

function BashAsReadSubsection({
  calls,
  sortSpec,
  onSortChange,
}: {
  calls: readonly BashAsReadCallJson[];
  sortSpec: SortSpec<FlatWasteSortKey>;
  onSortChange: (spec: SortSpec<FlatWasteSortKey>) => void;
}) {
  const sorted = sortRows(buildFlatWasteRows(calls), sortSpec, FLAT_WASTE_COLUMNS);
  const { shown, hiddenCount } = capList(sorted, FLAT_LIST_LIMIT);
  return (
    <div className="pan" style={{ padding: "14px 0 6px" }}>
      <div className="lbl" style={{ padding: "0 16px 8px" }}>
        Bash-as-Read · {calls.length}
      </div>
      <FlatWasteList
        rows={shown}
        hiddenCount={hiddenCount}
        emptyText="no Bash calls standing in for Read"
        sortSpec={sortSpec}
        onSortChange={onSortChange}
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
 *
 * The two flat-grid subsections (large results, bash-as-read) are sortable
 * by every column — near-duplicates and rerun-after-error stay unsorted,
 * their free-form pattern/count/occurrences shape (`WasteGroupList`) has no
 * natural per-column grid to sort. Sort state for the two flat grids is
 * owned by `Bash.tsx`, same as the other two Bash tables — this component
 * stays a pure function component, no `useState` here.
 */
export function WasteDetectionPanel({
  waste,
  largeResultsSortSpec,
  onLargeResultsSortChange,
  bashAsReadSortSpec,
  onBashAsReadSortChange,
}: Props) {
  return (
    <div className="col gap12 mt16">
      <NearDuplicatesSubsection groups={waste.nearDuplicates} />
      <LargeResultsSubsection
        results={waste.largeResults}
        sortSpec={largeResultsSortSpec}
        onSortChange={onLargeResultsSortChange}
      />
      <RerunAfterErrorSubsection groups={waste.rerunAfterError} />
      <BashAsReadSubsection
        calls={waste.bashAsRead}
        sortSpec={bashAsReadSortSpec}
        onSortChange={onBashAsReadSortChange}
      />
    </div>
  );
}
