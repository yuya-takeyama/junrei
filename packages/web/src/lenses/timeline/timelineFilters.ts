import type { TimelineEntry } from "../../api.js";

/**
 * The four fixed detail-dial stops. "turns" is the turn-grouped Timeline
 * spine's all-collapsed default (Claude Code main transcript only — see
 * `turnGroups.ts` and docs/roadmap.md's "Unified Timeline" phase 1); for kind
 * filtering it behaves exactly like "full" (see `kindAllowedByDial` below) —
 * collapsing rows is a per-turn expand/override state Timeline.tsx tracks
 * separately, not a kind restriction. The flat (Codex / subagent) rendering
 * path never offers this stop.
 */
export type DetailDial = "turns" | "user-only" | "minimal" | "full";

export const DIAL_STOPS: readonly DetailDial[] = ["turns", "user-only", "minimal", "full"];

/** One toggle per filter chip; chips further narrow whatever the dial already allows. */
export interface ChipState {
  user: boolean;
  assistant: boolean;
  thinking: boolean;
  tool: boolean;
  subagent: boolean;
  error: boolean;
  compaction: boolean;
}

export const DEFAULT_CHIPS: ChipState = {
  user: true,
  assistant: true,
  thinking: true,
  tool: true,
  subagent: true,
  error: true,
  compaction: true,
};

/**
 * Chip click state machine, with S = the set of enabled chips and k = the
 * clicked chip:
 *
 *   1. S = all enabled        -> { k }         start a focused selection
 *   2. k not in S             -> S + { k }     add to the selection
 *   3. k in S and |S| >= 2    -> S - { k }     remove from the selection
 *   4. S = { k }              -> all enabled   reset to the default view
 *
 * Rule 4 exists because an all-disabled timeline is meaningless; deselecting
 * the last chip reads as "clear the filter", so it restores the default
 * all-enabled state instead. This also makes the all-disabled state
 * unreachable.
 */
export function toggleChip(chips: ChipState, key: keyof ChipState): ChipState {
  if (Object.values(chips).every(Boolean)) {
    return {
      user: key === "user",
      assistant: key === "assistant",
      thinking: key === "thinking",
      tool: key === "tool",
      subagent: key === "subagent",
      error: key === "error",
      compaction: key === "compaction",
    };
  }

  const next = { ...chips, [key]: !chips[key] };
  if (!Object.values(next).some(Boolean)) return { ...DEFAULT_CHIPS };
  return next;
}

/**
 * Kinds included at the "minimal" dial stop — narrative-only: user turns,
 * assistant prose, subagent launches, and compaction breaks. Tool calls and
 * thinking are hidden. "user-only" further restricts to just `user`; "full"
 * and "turns" both lift every kind-level restriction (chips still apply) —
 * "turns" only differs from "full" in Timeline.tsx's per-turn expand state,
 * never in which kinds are allowed through once a turn IS expanded.
 */
const MINIMAL_KINDS = new Set<TimelineEntry["kind"]>([
  "user",
  "assistant-text",
  "subagent-launch",
  "compaction",
]);

function kindAllowedByDial(kind: TimelineEntry["kind"], dial: DetailDial): boolean {
  if (dial === "user-only") return kind === "user";
  if (dial === "minimal") return MINIMAL_KINDS.has(kind);
  return true;
}

/**
 * Chip visibility per entry. Only 7 chips exist (user/assistant/thinking/
 * tool/subagent/error/compaction), so kinds without a dedicated chip join
 * the nearest domain: `task-notification` is the completion signal of a
 * tool-launched background task. Every kind belongs to exactly one chip,
 * so focusing a single chip never leaks other kinds. A `tool-call` in
 * error status belongs to the "error" chip's domain, not "tool"'s, so
 * toggling "tool" off still leaves failed calls visible until "error" is
 * also off.
 */
export function chipAllows(entry: TimelineEntry, chips: ChipState): boolean {
  switch (entry.kind) {
    case "user":
      return chips.user;
    case "assistant-text":
      return chips.assistant;
    case "thinking":
      return chips.thinking;
    case "tool-call":
      return entry.status === "error" ? chips.error : chips.tool;
    case "task-notification":
      return chips.tool;
    case "subagent-launch":
      return chips.subagent;
    case "compaction":
      return chips.compaction;
    case "api-error":
      return chips.error;
    default:
      return true;
  }
}

export function isEntryVisible(entry: TimelineEntry, dial: DetailDial, chips: ChipState): boolean {
  return kindAllowedByDial(entry.kind, dial) && chipAllows(entry, chips);
}

export interface ChipCounts {
  user: number;
  assistant: number;
  thinking: number;
  tool: number;
  subagent: number;
  error: number;
  compaction: number;
}

/**
 * Live per-chip counts — computed over the *whole* session regardless of the
 * current dial/chip state, so the chip row always reads as "how many of
 * these exist in this session", not "how many currently pass the filter".
 * Buckets mirror `chipAllows` exactly, so a chip's count is the number of
 * entries it controls.
 */
export function computeChipCounts(entries: readonly TimelineEntry[]): ChipCounts {
  const counts: ChipCounts = {
    user: 0,
    assistant: 0,
    thinking: 0,
    tool: 0,
    subagent: 0,
    error: 0,
    compaction: 0,
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        counts.user += 1;
        break;
      case "assistant-text":
        counts.assistant += 1;
        break;
      case "thinking":
        counts.thinking += 1;
        break;
      case "tool-call":
        if (entry.status === "error") counts.error += 1;
        else counts.tool += 1;
        break;
      case "task-notification":
        counts.tool += 1;
        break;
      case "subagent-launch":
        counts.subagent += 1;
        break;
      case "compaction":
        counts.compaction += 1;
        break;
      case "api-error":
        counts.error += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

/** Whether an entry should read as an "error" location for the mini-map. */
export function isErrorEntry(entry: TimelineEntry): boolean {
  return entry.kind === "api-error" || (entry.kind === "tool-call" && entry.status === "error");
}

/** Whether an entry should read as an amber marker (turn/boundary) for the mini-map. */
export function isMarkerEntry(entry: TimelineEntry): boolean {
  return entry.kind === "user" || entry.kind === "compaction";
}
