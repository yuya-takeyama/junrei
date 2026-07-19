/**
 * `findPatterns` — cross-session pattern search with three kinds:
 *  - `text`: a thin wrap of the existing full-text search (the server runs
 *    the index and passes the hits in; this reshapes them + adds `_meta`).
 *  - `delegation`: groups sessions by their delegation SHAPE (subagent-count
 *    bucket × model mix) and reports each shape's cost and return-size
 *    profile — "which way of delegating is cheap, which is expensive".
 *  - `waste`: rolls up waste findings across sessions by class — "what do we
 *    keep wasting money on".
 *
 * Pure over injected data (search hits / per-session summaries) — no I/O.
 */

import type { SessionSource } from "../shared/session-analysis.js";
import { buildMeta } from "./meta.js";
import type { Detail, InsightMeta, TruncatedField } from "./types.js";

export type PatternKind = "text" | "delegation" | "waste";

/** One full-text search hit, as the server's search produces it. */
export interface PatternTextHit {
  source: SessionSource;
  sessionId: string;
  title?: string;
  /** Matched field kind (user/assistant/tool_result/…). */
  field: string;
  /** A short excerpt around the match. */
  excerpt: string;
}

/** Per-session material for the `delegation`/`waste` aggregations. */
export interface PatternSessionInput {
  source: SessionSource;
  sessionId: string;
  subagentCount: number;
  /** Distinct models the delegation touched, e.g. `["opus", "haiku"]`. */
  delegationModels: string[];
  totalCostUsd: number;
  /** Sum of subagent return chars for the session, when known. */
  subagentReturnChars?: number;
  /** Waste findings' classes seen in this session (repeatable). */
  wasteClasses: string[];
}

export interface FindPatternsInput {
  kind: PatternKind;
  detail: Detail;
  query?: string;
  repo?: string;
  days?: number;
  /** Required when `kind === "text"`. */
  hits?: PatternTextHit[];
  /** Required when `kind` is `delegation` or `waste`. */
  sessions?: PatternSessionInput[];
}

export interface DelegationPattern {
  /** Human label, e.g. `"3-5 subagents · opus+haiku"`. */
  shape: string;
  subagentCountBucket: string;
  models: string[];
  sessionCount: number;
  avgCostUsd: number;
  avgSubagentReturnChars: number | null;
}

export interface WastePattern {
  class: string;
  sessionCount: number;
  occurrences: number;
}

export interface FindPatternsResult {
  kind: PatternKind;
  repo?: string;
  query?: string;
  textHits?: PatternTextHit[];
  delegationPatterns?: DelegationPattern[];
  wastePatterns?: WastePattern[];
  _meta: InsightMeta;
}

const CONCISE_LIMIT = 10;
const FULL_LIMIT = 100;

/** Coarse subagent-count bucket so near-identical shapes group together. */
function subagentBucket(count: number): string {
  if (count === 0) return "0 subagents";
  if (count <= 2) return "1-2 subagents";
  if (count <= 5) return "3-5 subagents";
  return "6+ subagents";
}

function delegationPatterns(sessions: readonly PatternSessionInput[]): DelegationPattern[] {
  interface Acc {
    subagentCountBucket: string;
    models: string[];
    sessionCount: number;
    costTotal: number;
    returnCharsTotal: number;
    returnKnownCount: number;
  }
  const groups = new Map<string, Acc>();
  for (const s of sessions) {
    const bucket = subagentBucket(s.subagentCount);
    const models = [...s.delegationModels].sort();
    const key = `${bucket}|${models.join("+")}`;
    const acc = groups.get(key) ?? {
      subagentCountBucket: bucket,
      models,
      sessionCount: 0,
      costTotal: 0,
      returnCharsTotal: 0,
      returnKnownCount: 0,
    };
    acc.sessionCount += 1;
    acc.costTotal += s.totalCostUsd;
    if (s.subagentReturnChars !== undefined) {
      acc.returnCharsTotal += s.subagentReturnChars;
      acc.returnKnownCount += 1;
    }
    groups.set(key, acc);
  }
  return [...groups.values()]
    .map((acc) => ({
      shape: `${acc.subagentCountBucket} · ${acc.models.length > 0 ? acc.models.join("+") : "no delegation"}`,
      subagentCountBucket: acc.subagentCountBucket,
      models: acc.models,
      sessionCount: acc.sessionCount,
      avgCostUsd: acc.costTotal / acc.sessionCount,
      avgSubagentReturnChars:
        acc.returnKnownCount > 0 ? Math.round(acc.returnCharsTotal / acc.returnKnownCount) : null,
    }))
    .sort((a, b) => b.avgCostUsd - a.avgCostUsd);
}

function wastePatterns(sessions: readonly PatternSessionInput[]): WastePattern[] {
  interface Acc {
    sessions: Set<string>;
    occurrences: number;
  }
  const groups = new Map<string, Acc>();
  for (const s of sessions) {
    for (const cls of s.wasteClasses) {
      const acc = groups.get(cls) ?? { sessions: new Set<string>(), occurrences: 0 };
      acc.sessions.add(s.sessionId);
      acc.occurrences += 1;
      groups.set(cls, acc);
    }
  }
  return [...groups.entries()]
    .map(([cls, acc]) => ({
      class: cls,
      sessionCount: acc.sessions.size,
      occurrences: acc.occurrences,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

function noResultsNextSteps(kind: PatternKind): string[] {
  return [
    `No ${kind} patterns matched — widen the window (\`days\`) or drop the \`repo\`/\`query\` filter.`,
    "Call `briefing` for the current window's roll-up instead.",
  ];
}

/** Cross-session pattern search — see the module doc comment for the three kinds. */
export function findPatterns(input: FindPatternsInput): FindPatternsResult {
  const limit = input.detail === "concise" ? CONCISE_LIMIT : FULL_LIMIT;
  const common = {
    kind: input.kind,
    ...(input.repo !== undefined && { repo: input.repo }),
    ...(input.query !== undefined && { query: input.query }),
  };

  if (input.kind === "text") {
    const all = input.hits ?? [];
    const textHits = all.slice(0, limit);
    const payload = { ...common, textHits };
    const truncatedFields: TruncatedField[] =
      textHits.length < all.length
        ? [{ path: "textHits", shown: textHits.length, total: all.length }]
        : [];
    return {
      ...payload,
      _meta: buildMeta(payload, {
        ...(truncatedFields.length > 0 && { truncatedFields }),
        ...(all.length === 0 && { nextSteps: noResultsNextSteps("text") }),
      }),
    };
  }

  const sessions = input.sessions ?? [];
  if (input.kind === "delegation") {
    const all = delegationPatterns(sessions);
    const shown = all.slice(0, limit);
    const payload = { ...common, delegationPatterns: shown };
    const truncatedFields: TruncatedField[] =
      shown.length < all.length
        ? [{ path: "delegationPatterns", shown: shown.length, total: all.length }]
        : [];
    return {
      ...payload,
      _meta: buildMeta(payload, {
        ...(truncatedFields.length > 0 && { truncatedFields }),
        ...(all.length === 0 && { nextSteps: noResultsNextSteps("delegation") }),
      }),
    };
  }

  const all = wastePatterns(sessions);
  const shown = all.slice(0, limit);
  const payload = { ...common, wastePatterns: shown };
  const truncatedFields: TruncatedField[] =
    shown.length < all.length
      ? [{ path: "wastePatterns", shown: shown.length, total: all.length }]
      : [];
  return {
    ...payload,
    _meta: buildMeta(payload, {
      ...(truncatedFields.length > 0 && { truncatedFields }),
      ...(all.length === 0 && { nextSteps: noResultsNextSteps("waste") }),
    }),
  };
}
