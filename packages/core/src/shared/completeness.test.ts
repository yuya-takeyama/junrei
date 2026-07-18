import { describe, expect, it } from "vitest";
import {
  buildSourceCompleteness,
  type CompletenessStatus,
  type SourceKind,
} from "./completeness.js";

const VALID_STATUSES: readonly CompletenessStatus[] = [
  "partial",
  "estimate",
  "absent",
  "not-recorded",
  "unknown",
];

describe("buildSourceCompleteness", () => {
  it("returns the claude-session-jsonl table verbatim, per the completeness study", () => {
    const result = buildSourceCompleteness(["claude-session-jsonl"]);
    expect(result.sources).toEqual([
      {
        source: "claude-session-jsonl",
        dimensions: {
          systemPrompt: {
            status: "absent",
            note: "system prompt is not recorded in session JSONL",
          },
          toolSchemas: {
            status: "absent",
            note: "tool definitions (action space) are not recorded",
          },
          generationParams: {
            status: "absent",
            note: "max_tokens/thinking/etc. are not recorded",
          },
          injectedContext: {
            status: "partial",
            note: "agent/skill listings recorded as attachments; CLAUDE.md/memory reminder content is not",
          },
          hiddenApiCalls: {
            status: "not-recorded",
            note: "auxiliary API calls are invisible; cost undercounts",
          },
          cost: { status: "estimate", note: "token counts x pricing table; see costIsComplete" },
          thinking: {
            status: "partial",
            note: "recorded per turn but not re-sent in later requests",
          },
          latency: { status: "absent", note: "per-request latency is not recorded" },
        },
      },
    ]);
  });

  it("returns the codex-session-jsonl table verbatim", () => {
    const result = buildSourceCompleteness(["codex-session-jsonl"]);
    expect(result.sources).toEqual([
      {
        source: "codex-session-jsonl",
        dimensions: {
          cost: { status: "estimate", note: "token counts x pricing table; see costIsComplete" },
          systemPrompt: {
            status: "unknown",
            note: "completeness not yet audited for Codex rollouts",
          },
          toolSchemas: {
            status: "unknown",
            note: "completeness not yet audited for Codex rollouts",
          },
          hiddenApiCalls: {
            status: "unknown",
            note: "completeness not yet audited for Codex rollouts",
          },
          latency: {
            status: "unknown",
            note: "completeness not yet audited for Codex rollouts",
          },
        },
      },
    ]);
  });

  it("every dimension's status is one of the declared vocabulary", () => {
    const result = buildSourceCompleteness(["claude-session-jsonl", "codex-session-jsonl"]);
    for (const entry of result.sources) {
      for (const dimension of Object.values(entry.dimensions)) {
        expect(VALID_STATUSES).toContain(dimension.status);
      }
    }
  });

  it("every note is present and reasonably short (~80 chars)", () => {
    const result = buildSourceCompleteness(["claude-session-jsonl", "codex-session-jsonl"]);
    for (const entry of result.sources) {
      for (const dimension of Object.values(entry.dimensions)) {
        expect(dimension.note).toBeDefined();
        expect(dimension.note?.length ?? 0).toBeLessThanOrEqual(90);
      }
    }
  });

  it("orders claude before codex regardless of input order", () => {
    const result = buildSourceCompleteness(["codex-session-jsonl", "claude-session-jsonl"]);
    expect(result.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "codex-session-jsonl",
    ]);
  });

  it("dedupes repeated kinds", () => {
    const result = buildSourceCompleteness([
      "claude-session-jsonl",
      "claude-session-jsonl",
      "codex-session-jsonl",
      "codex-session-jsonl",
    ]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "codex-session-jsonl",
    ]);
  });

  it("returns an empty sources array for an empty kinds list", () => {
    const result = buildSourceCompleteness([]);
    expect(result.sources).toEqual([]);
  });

  it("returns only the requested kind when a single kind is given twice among duplicates", () => {
    const kinds: SourceKind[] = ["codex-session-jsonl"];
    const result = buildSourceCompleteness(kinds);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.source).toBe("codex-session-jsonl");
  });
});
