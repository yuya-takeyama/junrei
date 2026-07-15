import type { ReactNode } from "react";
import { formatDuration, formatTime, formatTokens, formatUsd } from "../../format.js";
import type { TurnGroup } from "./turnGroups.js";

const EM_DASH = "—";

export function joinClasses(...parts: ReadonlyArray<string | false | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p !== false).join(" ");
}

/**
 * One numeric column of the turn-grouped spine's `.trg` table — the single
 * source for that column's header label, grid width, and cell content across
 * both `TurnGroupHeaderRow` and `TurnRow`, so the two never drift apart (see
 * `turn-spine-abstraction.md`'s review checklist: "grep for duplicated grid
 * templates / column label lists"). `present` is presence-driven off the
 * groups themselves rather than the session's source, per the same contract:
 * a Claude-only or Codex-only field simply never shows up in a group, so the
 * column that reads it stays hidden without a `source === ` branch anywhere.
 */
export interface TurnColumn {
  key: string;
  label: string;
  width: string;
  /** Formatted cell content for one group. */
  render(group: TurnGroup): ReactNode;
  /**
   * Cell class. Most columns are a fixed "stat"/"stat mut"; C·Write and Cost
   * additionally amber-tint on the session's outlier turn — a row-level flag
   * (`isOutlierTurn`, computed in Timeline.tsx from the whole turn set) that
   * no single group carries, so it's threaded in as a second argument rather
   * than folded into `TurnGroup` itself.
   */
  className(group: TurnGroup, isOutlier: boolean): string;
  /** Whether this column shows at all, given every group in the current view. Default: always. */
  present?(groups: readonly TurnGroup[]): boolean;
}

const STAT = () => "stat";
const STAT_MUT = () => "stat mut";

const TURN_COLUMNS: readonly TurnColumn[] = [
  {
    key: "started",
    label: "Started",
    width: "66px",
    render: (g) => (g.startedAt !== undefined ? formatTime(g.startedAt) : EM_DASH),
    className: STAT_MUT,
  },
  {
    key: "dur",
    label: "Dur",
    width: "58px",
    render: (g) => (g.durationMs !== undefined ? formatDuration(g.durationMs) : EM_DASH),
    className: STAT,
  },
  {
    key: "steps",
    label: "Steps",
    width: "44px",
    render: (g) => (g.stepCount !== undefined ? String(g.stepCount) : EM_DASH),
    className: STAT,
    present: (groups) => groups.some((g) => g.stepCount !== undefined),
  },
  {
    key: "input",
    label: "Input",
    width: "68px",
    render: (g) => formatTokens(g.inputTokens),
    className: STAT_MUT,
  },
  {
    key: "cread",
    label: "C·Read",
    width: "74px",
    render: (g) => formatTokens(g.cacheReadTokens),
    className: STAT_MUT,
  },
  {
    key: "cwrite",
    label: "C·Write",
    width: "68px",
    render: (g) =>
      g.cacheCreationTokens !== undefined ? formatTokens(g.cacheCreationTokens) : EM_DASH,
    className: (_g, isOutlier) => (isOutlier ? "stat amb" : "stat"),
    present: (groups) => groups.some((g) => g.cacheCreationTokens !== undefined),
  },
  {
    key: "output",
    label: "Output",
    width: "68px",
    render: (g) => formatTokens(g.outputTokens),
    className: STAT,
  },
  {
    key: "reasoning",
    label: "Reasoning",
    width: "82px",
    render: (g) => (g.reasoningTokens !== undefined ? formatTokens(g.reasoningTokens) : EM_DASH),
    // Zero-reasoning turns read as muted — matches the old (pre-unification)
    // Codex Turns table, which dimmed the cell rather than showing a bare 0.
    className: (g) => (g.reasoningTokens === 0 ? "stat mut" : "stat"),
    present: (groups) => groups.some((g) => g.reasoningTokens !== undefined),
  },
  {
    key: "cost",
    label: "Cost",
    width: "66px",
    render: (g) =>
      g.costUsd === undefined ? EM_DASH : `${g.costIncomplete ? "≈ " : ""}${formatUsd(g.costUsd)}`,
    className: (g, isOutlier) =>
      joinClasses(
        "stat",
        isOutlier && "amb",
        g.costUsd !== undefined && g.costIncomplete && "approx",
      ),
    present: (groups) => groups.some((g) => g.costUsd !== undefined),
  },
  {
    key: "deleg",
    label: "Deleg",
    width: "74px",
    // No outlier tint — `isOutlier` reflects the turn's OWN cost share, not
    // its delegated spend, so tinting this cell off that flag would be
    // misleading.
    render: (g) =>
      g.delegatedCostUsd === undefined
        ? EM_DASH
        : `${g.delegatedCostIncomplete ? "≈ " : ""}${formatUsd(g.delegatedCostUsd)}`,
    className: (g) => joinClasses("stat", g.delegatedCostIncomplete === true && "approx"),
    present: (groups) => groups.some((g) => g.delegatedCostUsd !== undefined),
  },
];

/** The columns that actually show for a given set of groups, in display order. */
export function visibleTurnColumns(groups: readonly TurnGroup[]): TurnColumn[] {
  return TURN_COLUMNS.filter((col) => col.present === undefined || col.present(groups));
}

/**
 * Grid template for the `.trg` table — `#` and `Model · Prompt` are always
 * present (hand-written, not descriptor-driven; see `TurnRow.tsx`), followed
 * by one track per visible numeric column. Computed once per render from
 * `visibleTurnColumns`'s result and passed down as an inline style so it's
 * never recomputed per row (see `turn-spine-abstraction.md`).
 */
export function turnGridTemplate(columns: readonly TurnColumn[]): string {
  return `46px minmax(0, 1fr) ${columns.map((c) => c.width).join(" ")}`;
}
