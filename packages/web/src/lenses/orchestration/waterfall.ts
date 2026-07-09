import type { SessionJson } from "../../api.js";
import { classifyModel } from "../../modelClass.js";
import {
  displayName,
  flattenSubagents,
  nodeDurationMs,
  primaryModel,
  sessionSpan,
  totalTokensOf,
} from "./agentTree.js";

export interface WaterfallRow {
  key: string;
  label: string;
  kind: "main" | "agent" | "task";
  /** Set only for `kind: "agent"` — lets the view highlight/select this row. */
  agentId?: string;
  /** "f" | "s" | "h" | "mut" — undefined for background tasks (rendered muted, not model-hued). */
  colorClass?: string;
  /** Percent (0–100) of the session span. */
  left: number;
  width: number;
  opacity?: number;
  hasTiming: boolean;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
}

const MIN_WIDTH_PCT = 0.35;
const NO_TIMING_WIDTH_PCT = 0.6;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function pctOf(t: number, span: { start: number; end: number }): number {
  return ((t - span.start) / (span.end - span.start)) * 100;
}

function parseMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

interface TimedItem {
  key: string;
  label: string;
  kind: "agent" | "task";
  agentId?: string;
  colorClass?: string;
  startMs: number | undefined;
  endMs: number | undefined;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Build the waterfall's lane list: main (full span) first, then every
 * subagent and background task execution ordered chronologically by actual
 * start time (not tree structure — a waterfall reads as "when did things
 * really run", so doc-scanner can appear before test-writer even though the
 * tree lists them the other way round). Nested agents keep a "└ " label
 * prefix so the temporal reordering doesn't lose the "this was delegated
 * from a subagent" signal. Rows with no resolvable start/end render as a
 * small muted "no timing" marker pinned to the left edge, per
 * design-spec/13-orchestration.md's waterfall notes (undocumented edge case
 * — decided here rather than skipping the row, so every launched agent is
 * still visible for an audit).
 */
export function buildWaterfallRows(session: SessionJson): {
  rows: WaterfallRow[];
  span: { start: number; end: number } | undefined;
} {
  const span = sessionSpan(session);
  const rows: WaterfallRow[] = [];

  const mainModel = primaryModel(session.usage.byModel);
  rows.push({
    key: "main",
    label: "main",
    kind: "main",
    ...(mainModel !== undefined && { colorClass: classifyModel(mainModel) }),
    left: 0,
    width: 100,
    opacity: 0.55,
    hasTiming: true,
    tokens: totalTokensOf(session.usage.total),
    costUsd: session.usage.total.costUsd,
    ...(session.durationMs !== undefined && { durationMs: session.durationMs }),
  });

  const items: TimedItem[] = [];
  for (const row of flattenSubagents(session.subagents)) {
    const node = row.node;
    const durationMs = nodeDurationMs(node);
    items.push({
      key: `agent:${node.agentId}`,
      label: `${row.nested ? "└ " : ""}${displayName(node)}`,
      kind: "agent",
      agentId: node.agentId,
      ...(node.model !== undefined && { colorClass: classifyModel(node.model) }),
      startMs: parseMs(node.startedAt),
      endMs: parseMs(node.endedAt),
      tokens: totalTokensOf(node.usage.total),
      costUsd: node.usage.total.costUsd,
      ...(durationMs !== undefined && { durationMs }),
    });
  }
  // kind "agent" executions are the SAME runs as the subagent-tree lanes
  // above — including them again would draw every subagent twice. Only
  // non-agent background work (bash, preview-server) gets its own lane.
  for (const t of session.taskExecutions.filter((t) => t.background && t.kind !== "agent")) {
    items.push({
      key: `task:${t.taskId}`,
      label: `${t.name !== "" ? t.name : t.taskId} · bg task`,
      kind: "task",
      startMs: parseMs(t.startedAt),
      endMs: parseMs(t.completedAt),
      ...(t.durationMs !== undefined && { durationMs: t.durationMs }),
    });
  }

  items.sort((a, b) => {
    if (a.startMs === undefined && b.startMs === undefined) return 0;
    if (a.startMs === undefined) return 1;
    if (b.startMs === undefined) return -1;
    return a.startMs - b.startMs;
  });

  for (const item of items) {
    const hasTiming = span !== undefined && item.startMs !== undefined && item.endMs !== undefined;
    let left = 0;
    let width = NO_TIMING_WIDTH_PCT;
    if (hasTiming && span !== undefined && item.startMs !== undefined && item.endMs !== undefined) {
      left = clamp(pctOf(item.startMs, span), 0, 100);
      width = Math.max(MIN_WIDTH_PCT, clamp(pctOf(item.endMs, span) - left, 0, 100 - left));
    }
    rows.push({
      key: item.key,
      label: item.label,
      kind: item.kind,
      left,
      width,
      hasTiming,
      ...(item.agentId !== undefined && { agentId: item.agentId }),
      ...(item.colorClass !== undefined && { colorClass: item.colorClass }),
      ...(item.tokens !== undefined && { tokens: item.tokens }),
      ...(item.costUsd !== undefined && { costUsd: item.costUsd }),
      ...(item.durationMs !== undefined && { durationMs: item.durationMs }),
    });
  }

  return { rows, span };
}

/** 5 evenly-spaced time-axis labels across the session span, per the design spec. */
export function axisTicks(span: { start: number; end: number }): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => span.start + f * (span.end - span.start));
}
