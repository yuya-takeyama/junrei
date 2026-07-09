import type { AnySessionJson, SubagentNodeJson } from "../../api.js";
import { classifyModel } from "../../modelClass.js";
import {
  displayName,
  primaryModel,
  subtreeCost,
  subtreeTokens,
  totalTokensOf,
} from "./agentTree.js";

export type FlameMetric = "cost" | "tokens";

export interface FlameBlock {
  key: string;
  label: string;
  /** Set for real (non-placeholder) subagent blocks — lets the view select/highlight. */
  agentId?: string;
  colorClass?: string;
  /** Percent of the root (session) total — the shared x-axis every row is a fraction of. */
  widthPct: number;
  value: number;
  /** The immediate parent's own value — denominator for "% of parent" in the hover tooltip. */
  parentValue: number;
  /** True for transparent filler blocks that only preserve x-alignment. */
  placeholder: boolean;
}

export interface FlameRows {
  total: number;
  row2: FlameBlock[];
  row3: FlameBlock[];
}

function metricOfNode(node: SubagentNodeJson, metric: FlameMetric): number {
  return metric === "cost" ? subtreeCost(node) : subtreeTokens(node);
}

function metricOfMain(session: AnySessionJson, metric: FlameMetric): number {
  return metric === "cost" ? session.usage.total.costUsd : totalTokensOf(session.usage.total);
}

function rootTotal(session: AnySessionJson, metric: FlameMetric): number {
  return metric === "cost" ? session.totalUsage.costUsd : totalTokensOf(session.totalUsage);
}

interface Row2Item {
  key: string;
  label: string;
  agentId?: string;
  colorClass?: string;
  value: number;
  node?: SubagentNodeJson;
}

/**
 * Build the flame chart's row 2 (main-self + top-level agents, widest→
 * narrowest) and row 3 (their immediate children, with transparent fillers
 * padding out each parent's slice so every row sums to exactly the root's
 * 100%-width span and stays x-aligned with row 2). Deeper nesting (depth 3+)
 * isn't shown — the design only specs 3 rows; see 13-orchestration.md.
 */
export function buildFlameRows(session: AnySessionJson, metric: FlameMetric): FlameRows {
  const total = rootTotal(session, metric);
  const mainModel = primaryModel(session.usage.byModel);

  const row2Items: Row2Item[] = [
    {
      key: "main-self",
      label: "main self",
      ...(mainModel !== undefined && { colorClass: classifyModel(mainModel) }),
      value: metricOfMain(session, metric),
    },
    ...session.subagents.map((node) => ({
      key: `agent:${node.agentId}`,
      label: displayName(node),
      agentId: node.agentId,
      ...(node.model !== undefined && { colorClass: classifyModel(node.model) }),
      value: metricOfNode(node, metric),
      node,
    })),
  ].sort((a, b) => b.value - a.value);

  const row2: FlameBlock[] = row2Items.map((item) => ({
    key: item.key,
    label: item.label,
    ...(item.agentId !== undefined && { agentId: item.agentId }),
    ...(item.colorClass !== undefined && { colorClass: item.colorClass }),
    widthPct: total > 0 ? (item.value / total) * 100 : 0,
    value: item.value,
    parentValue: total,
    placeholder: false,
  }));

  const row3: FlameBlock[] = [];
  for (const item of row2Items) {
    const parentWidthPct = total > 0 ? (item.value / total) * 100 : 0;
    const children = item.node?.children ?? [];
    let usedPct = 0;
    for (const child of children) {
      const value = metricOfNode(child, metric);
      const widthPct = total > 0 ? (value / total) * 100 : 0;
      usedPct += widthPct;
      row3.push({
        key: `child:${child.agentId}`,
        label: displayName(child),
        agentId: child.agentId,
        ...(child.model !== undefined && { colorClass: classifyModel(child.model) }),
        widthPct,
        value,
        parentValue: item.value,
        placeholder: false,
      });
    }
    const remainder = Math.max(0, parentWidthPct - usedPct);
    if (remainder > 0.01) {
      row3.push({
        key: `filler:${item.key}`,
        label: "",
        widthPct: remainder,
        value: 0,
        parentValue: item.value,
        placeholder: true,
      });
    }
  }

  return { total, row2, row3 };
}
