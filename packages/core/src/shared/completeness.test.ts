import { describe, expect, it } from "vitest";
import {
  buildSourceCompleteness,
  type CompletenessStatus,
  type SourceKind,
} from "./completeness.js";

const VALID_STATUSES: readonly CompletenessStatus[] = [
  "partial",
  "estimate",
  "authoritative",
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

  it("returns the claude-otel table verbatim, per the completeness study's OTel section", () => {
    const result = buildSourceCompleteness(["claude-otel"]);
    expect(result.sources).toEqual([
      {
        source: "claude-otel",
        dimensions: {
          promptContent: {
            status: "absent",
            note: "no prompt/message text exported (unless OTEL_LOG_USER_PROMPTS=1)",
          },
          toolContent: {
            status: "absent",
            note: "tool arguments/results are not exported, only byte sizes",
          },
          systemPrompt: { status: "absent", note: "system prompt is not exported over OTel" },
          toolSchemas: {
            status: "absent",
            note: "tool definitions (action space) are not exported",
          },
          cost: {
            status: "authoritative",
            note: "billing-computed cost_usd, not a pricing-table estimate",
          },
          latency: {
            status: "partial",
            note: "api_request duration_ms, only when Claude Code exports it",
          },
          hiddenApiCalls: {
            status: "not-recorded",
            note: "the background task-state classifier is invisible in OTel too",
          },
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

  it("returns the claude-wire-capture table verbatim (content/latency authoritative)", () => {
    const result = buildSourceCompleteness(["claude-wire-capture"]);
    expect(result.sources).toEqual([
      {
        source: "claude-wire-capture",
        dimensions: {
          content: {
            status: "authoritative",
            note: "captured wire bytes; auth headers redacted at write",
          },
          coverage: {
            status: "partial",
            note: "only requests made while the capture proxy was active",
          },
          authHeaders: { status: "absent", note: "redacted at write time" },
          hiddenApiCalls: {
            status: "partial",
            note: "visible only when routed through the proxy",
          },
          latency: { status: "authoritative", note: "measured at the proxy" },
        },
      },
    ]);
  });

  it("every dimension's status is one of the declared vocabulary", () => {
    const result = buildSourceCompleteness([
      "claude-session-jsonl",
      "codex-session-jsonl",
      "claude-wire-capture",
    ]);
    for (const entry of result.sources) {
      for (const dimension of Object.values(entry.dimensions)) {
        expect(VALID_STATUSES).toContain(dimension.status);
      }
    }
  });

  it("every note is present and reasonably short (~80 chars)", () => {
    const result = buildSourceCompleteness([
      "claude-session-jsonl",
      "codex-session-jsonl",
      "claude-wire-capture",
    ]);
    for (const entry of result.sources) {
      for (const dimension of Object.values(entry.dimensions)) {
        expect(dimension.note).toBeDefined();
        expect(dimension.note?.length ?? 0).toBeLessThanOrEqual(90);
      }
    }
  });

  it("orders claude-session-jsonl, then claude-otel, then claude-wire-capture, then codex", () => {
    const result = buildSourceCompleteness([
      "codex-session-jsonl",
      "claude-wire-capture",
      "claude-otel",
      "claude-session-jsonl",
    ]);
    expect(result.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "claude-otel",
      "claude-wire-capture",
      "codex-session-jsonl",
    ]);
  });

  it("orders claude before codex regardless of input order", () => {
    const result = buildSourceCompleteness(["codex-session-jsonl", "claude-session-jsonl"]);
    expect(result.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "codex-session-jsonl",
    ]);
  });

  it("orders both claude entries (session-jsonl, otel) before codex, regardless of input order", () => {
    const result = buildSourceCompleteness([
      "codex-session-jsonl",
      "claude-otel",
      "claude-session-jsonl",
    ]);
    expect(result.sources.map((s) => s.source)).toEqual([
      "claude-session-jsonl",
      "claude-otel",
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
