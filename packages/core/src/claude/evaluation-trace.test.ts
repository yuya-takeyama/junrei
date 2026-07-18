import { describe, expect, it } from "vitest";
import type { SubagentNode } from "../shared/subagent-node.js";
import type {
  EvaluationTraceHiddenCall,
  EvaluationTraceInputs,
  EvaluationTraceReconstructionSummary,
} from "./evaluation-trace.js";
import { buildEvaluationTrace, EVALUATION_TRACE_SCHEMA } from "./evaluation-trace.js";
import type { SessionData } from "./session-data.js";

// All fixtures synthetic — invented ids, prompts, and timestamps.

const T1 = "2026-07-18T00:00:00.000Z";
const T2 = "2026-07-18T00:00:05.000Z";
const T3 = "2026-07-18T00:00:06.000Z";
const T4 = "2026-07-18T00:00:07.000Z";
const T5 = "2026-07-18T00:00:08.000Z";
const T6 = "2026-07-18T00:00:09.000Z";

/**
 * A small synthetic session: one main-loop request (req_1) with a text block,
 * a Bash tool call, and a subagent launch (Agent tool), followed by a
 * compaction, an api error, and a second request (req_2) with a closing text
 * block — enough surface to exercise every event kind `buildEvaluationTrace`
 * emits from `SessionData` alone.
 */
function fixtureData(): SessionData {
  return {
    filePath: "/fake/session.jsonl",
    records: [
      { type: "user", line: 1, timestamp: T1, promptText: "Fix the bug", toolResults: [] },
      {
        type: "assistant",
        line: 2,
        timestamp: T2,
        requestId: "req_1",
        messageId: "m1",
        model: "claude-x",
        blocks: [{ kind: "text", text: "Let me look" }],
      },
      {
        type: "assistant",
        line: 3,
        timestamp: T2,
        requestId: "req_1",
        messageId: "m1",
        model: "claude-x",
        blocks: [{ kind: "tool_use", toolUseId: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        type: "user",
        line: 4,
        timestamp: T3,
        toolResults: [{ toolUseId: "tu_1", isError: false, text: "file.txt", fullTextLength: 8 }],
      },
      {
        type: "assistant",
        line: 5,
        timestamp: T3,
        requestId: "req_1",
        messageId: "m1",
        model: "claude-x",
        blocks: [
          {
            kind: "tool_use",
            toolUseId: "tu_2",
            name: "Agent",
            input: {
              prompt: "investigate the bug",
              description: "investigator",
              subagent_type: "general",
            },
          },
        ],
      },
      {
        type: "user",
        line: 6,
        timestamp: T4,
        toolResults: [
          { toolUseId: "tu_2", isError: false, text: "launch ack", fullTextLength: 10 },
        ],
      },
      {
        type: "system",
        subtype: "compact_boundary",
        line: 7,
        timestamp: T4,
        trigger: "auto",
        preTokens: 1000,
        postTokens: 200,
      },
      {
        type: "system",
        subtype: "api_error",
        line: 8,
        timestamp: T5,
        status: 529,
        message: "overloaded",
      },
      {
        type: "assistant",
        line: 9,
        timestamp: T6,
        requestId: "req_2",
        messageId: "m2",
        model: "claude-x",
        stopReason: "end_turn",
        blocks: [{ kind: "text", text: "All done" }],
      },
    ],
    apiMessages: [
      { messageId: "m1", model: "claude-x", line: 2, timestamp: T2, usage: usage(100, 50) },
      { messageId: "m2", model: "claude-x", line: 9, timestamp: T6, usage: usage(20, 10) },
    ],
    toolCalls: [
      {
        toolUseId: "tu_1",
        name: "Bash",
        input: { command: "ls" },
        messageId: "m1",
        line: 3,
        timestamp: T2,
        result: { isError: false, text: "file.txt", line: 4, timestamp: T3, fullTextLength: 8 },
      },
      {
        toolUseId: "tu_2",
        name: "Agent",
        input: {
          prompt: "investigate the bug",
          description: "investigator",
          subagent_type: "general",
        },
        messageId: "m1",
        line: 5,
        timestamp: T3,
        result: { isError: false, text: "launch ack", line: 6, timestamp: T4, fullTextLength: 10 },
      },
    ],
    userPrompts: [{ text: "Fix the bug", line: 1, timestamp: T1 }],
    compactions: [{ line: 7, timestamp: T4, trigger: "auto", preTokens: 1000, postTokens: 200 }],
    backgroundLaunches: [],
    taskNotifications: [{ taskId: "task_1", status: "completed", line: 6, timestamp: T4 }],
    apiErrorCount: 1,
    apiErrors: [{ line: 8, timestamp: T5, status: 529, message: "overloaded" }],
    cwd: "/proj",
    version: "9.9.9",
    firstTimestamp: T1,
    lastTimestamp: T6,
    warningCount: 0,
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function fixtureSubagent(): SubagentNode {
  return {
    agentId: "agent_1",
    agentType: "general",
    description: "investigator",
    toolUseId: "tu_2",
    model: "claude-x",
    usage: {
      byModel: [],
      total: {
        inputTokens: 30,
        outputTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
        costIsComplete: true,
      },
    },
    toolCallCount: 2,
    toolErrorCount: 0,
    startedAt: T3,
    endedAt: T4,
    status: "completed",
    children: [],
  };
}

function baseInputs(): EvaluationTraceInputs {
  return {
    session: { sessionId: "sess_1", cwd: "/proj", cliVersion: "9.9.9", startedAt: T1, endedAt: T6 },
    data: fixtureData(),
    subagents: [fixtureSubagent()],
  };
}

function eventNames(trace: ReturnType<typeof buildEvaluationTrace>): string[] {
  return trace.events.map((e) => e.name);
}

describe("buildEvaluationTrace", () => {
  it("emits the envelope with schema, session, and log-only sourceCompleteness", () => {
    const trace = buildEvaluationTrace(baseInputs());
    expect(trace.schema).toBe(EVALUATION_TRACE_SCHEMA);
    expect(trace.session).toEqual({
      sessionId: "sess_1",
      cwd: "/proj",
      cliVersion: "9.9.9",
      startedAt: T1,
      endedAt: T6,
    });
    expect(trace.sourceCompleteness.sources.map((s) => s.source)).toEqual(["claude-session-jsonl"]);
    expect(trace.enrichment.otel).toMatchObject({ consulted: false, available: false });
    expect(trace.enrichment.captures).toMatchObject({ consulted: false, available: false });
  });

  it("emits one event per user message, assistant text block, tool call/result, subagent launch, task notification, compaction, api error, and request", () => {
    const trace = buildEvaluationTrace(baseInputs());
    const names = eventNames(trace);
    expect(names).toContain("gen_ai.user.message");
    expect(names.filter((n) => n === "gen_ai.assistant.message")).toHaveLength(2);
    expect(names).toContain("gen_ai.tool.call");
    expect(names).toContain("gen_ai.tool.result");
    expect(names).toContain("junrei.subagent_launch");
    expect(names).toContain("junrei.task_notification");
    expect(names).toContain("junrei.compaction");
    expect(names).toContain("junrei.api_error");
    expect(names.filter((n) => n === "gen_ai.request")).toHaveLength(2);
    // The subagent launch tool call must NOT also produce a generic tool.call/result pair.
    const subagentCallAttrs = trace.events.find(
      (e) => e.name === "junrei.subagent_launch",
    )?.attributes;
    expect(subagentCallAttrs?.toolUseId).toBe("tu_2");
    const toolCallEvents = trace.events.filter((e) => e.name === "gen_ai.tool.call");
    expect(toolCallEvents.map((e) => e.attributes.toolUseId)).toEqual(["tu_1"]);
  });

  it("carries full recovered result text and subagent usage on the subagent_launch event", () => {
    const trace = buildEvaluationTrace(baseInputs());
    const launch = trace.events.find((e) => e.name === "junrei.subagent_launch");
    expect(launch?.attributes).toMatchObject({
      agentId: "agent_1",
      agentType: "general",
      prompt: "investigate the bug",
      returnedText: "launch ack",
      outputTokens: 15,
      costUsd: 0.001,
      status: "completed",
    });
  });

  it("uses recoveredResults over the (possibly capped) SessionData result text", () => {
    const inputs = baseInputs();
    inputs.recoveredResults = {
      tu_1: { text: "file.txt (full)", fullTextLength: 16 },
    };
    const trace = buildEvaluationTrace(inputs);
    const result = trace.events.find((e) => e.name === "gen_ai.tool.result");
    expect(result?.attributes).toMatchObject({ text: "file.txt (full)" });
  });

  it("stamps provenance (line and/or requestId) on every single event", () => {
    const trace = buildEvaluationTrace(baseInputs());
    for (const event of trace.events) {
      expect(event.provenance.line !== undefined || event.provenance.requestId !== undefined).toBe(
        true,
      );
    }
  });

  it("orders events by source line, request enrichment landing at its message's own line", () => {
    const trace = buildEvaluationTrace(baseInputs());
    const lines = trace.events
      .map((e) => e.provenance.line)
      .filter((l): l is number => l !== undefined);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
    // The req_1 enrichment event sits at line 2 (its ApiMessage's first-occurrence line).
    const req1Event = trace.events.find(
      (e) => e.name === "gen_ai.request" && e.provenance.requestId === "req_1",
    );
    expect(req1Event?.provenance.line).toBe(2);
  });

  it("computes a pricing-estimate cost per request from the log's own usage", () => {
    const trace = buildEvaluationTrace(baseInputs());
    const req1 = trace.events.find(
      (e) => e.name === "gen_ai.request" && e.provenance.requestId === "req_1",
    );
    expect(req1?.attributes.pricingEstimate).toBeDefined();
    const pricing = req1?.attributes.pricingEstimate as {
      costUsd: number;
      costIsComplete: boolean;
    };
    // No pricing entry for the synthetic "claude-x" model — a declared, non-crashing $0/incomplete.
    expect(pricing.costIsComplete).toBe(false);
  });

  it("declares an unattempted injected-context recovery, and includes events when provided", () => {
    const withoutInjected = buildEvaluationTrace(baseInputs());
    expect(withoutInjected.limitations.some((l) => l.includes("injected-context"))).toBe(true);
    expect(eventNames(withoutInjected)).not.toContain("junrei.injected_context");

    const inputs = baseInputs();
    inputs.injectedContext = [
      { line: 1, kind: "agent-listing", text: "<system-reminder>...</system-reminder>" },
    ];
    const withInjected = buildEvaluationTrace(inputs);
    expect(withInjected.limitations.some((l) => l.includes("injected-context"))).toBe(false);
    expect(eventNames(withInjected)).toContain("junrei.injected_context");
  });

  it("declares reconstruction summaries as unattempted by default, and includes them per-request when provided", () => {
    const withoutRecon = buildEvaluationTrace(baseInputs());
    expect(withoutRecon.limitations.some((l) => l.includes("reconstruction summaries"))).toBe(true);

    const summary: EvaluationTraceReconstructionSummary = {
      requestId: "req_1",
      targetLine: 5,
      confidenceCounts: { exact: 4, template: 2, "disk-contingent": 1, unknown: 1 },
      appliedRules: ["cache-control-strip"],
      limitations: ["subagent (sidechain) requests are not supported"],
    };
    const inputs = baseInputs();
    inputs.reconstructionSummaries = [summary];
    const trace = buildEvaluationTrace(inputs);
    expect(trace.limitations.some((l) => l.includes("reconstruction summaries"))).toBe(false);
    const req1 = trace.events.find(
      (e) => e.name === "gen_ai.request" && e.provenance.requestId === "req_1",
    );
    expect(req1?.attributes.reconstruction).toMatchObject({
      confidenceCounts: summary.confidenceCounts,
      appliedRules: summary.appliedRules,
    });
    // req_2 got no summary — its event must not fabricate one.
    const req2 = trace.events.find(
      (e) => e.name === "gen_ai.request" && e.provenance.requestId === "req_2",
    );
    expect(req2?.attributes.reconstruction).toBeUndefined();
  });

  describe("with OTel", () => {
    it("adds claude-otel to sourceCompleteness, echoes the session-level aggregate, and declares the no-per-request-join limitation — never a silent per-request otel field", () => {
      const inputs = baseInputs();
      inputs.otel = {
        consulted: true,
        available: true,
        costUsd: 1.23,
        costSource: "api_request_events",
        apiRequestCount: 5,
      };
      const trace = buildEvaluationTrace(inputs);
      expect(trace.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
        "claude-otel",
      ]);
      expect(trace.enrichment.otel).toMatchObject({
        consulted: true,
        available: true,
        costUsd: 1.23,
        apiRequestCount: 5,
      });
      expect(trace.limitations.some((l) => l.includes("no request-id join key"))).toBe(true);
      for (const event of trace.events) {
        if (event.name === "gen_ai.request") expect(event.attributes.otel).toBeUndefined();
      }
    });

    it("declares otel consulted-but-unavailable explicitly rather than omitting it", () => {
      const inputs = baseInputs();
      inputs.otel = {
        consulted: true,
        available: false,
        note: "no OTel data recorded for this session",
      };
      const trace = buildEvaluationTrace(inputs);
      expect(trace.enrichment.otel).toMatchObject({ consulted: true, available: false });
      expect(trace.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
      ]);
    });
  });

  describe("with wire capture, including a hidden call", () => {
    function inputsWithCapture(): EvaluationTraceInputs {
      const inputs = baseInputs();
      inputs.captures = { consulted: true, available: true };
      inputs.requestCaptures = [{ requestId: "req_1", latencyMs: 842, isSubagent: false }];
      const hidden: EvaluationTraceHiddenCall = {
        requestId: "req_hidden",
        model: "claude-x",
        path: "/v1/messages",
        latencyMs: 120,
        isSubagent: true,
        startedAt: T4,
      };
      inputs.hiddenCalls = [hidden];
      return inputs;
    }

    it("adds claude-wire-capture to sourceCompleteness and joins measured latency onto the matching request", () => {
      const trace = buildEvaluationTrace(inputsWithCapture());
      expect(trace.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
        "claude-wire-capture",
      ]);
      const req1 = trace.events.find(
        (e) => e.name === "gen_ai.request" && e.provenance.requestId === "req_1",
      );
      expect(req1?.attributes.capture).toEqual({ latencyMs: 842, isSubagent: false });
    });

    it("emits a junrei.hidden_api_call event with requestId-only provenance (no log line) and counts it in enrichment", () => {
      const trace = buildEvaluationTrace(inputsWithCapture());
      const hidden = trace.events.find((e) => e.name === "junrei.hidden_api_call");
      expect(hidden).toBeDefined();
      expect(hidden?.provenance).toEqual({ requestId: "req_hidden" });
      expect(hidden?.attributes).toMatchObject({
        requestId: "req_hidden",
        model: "claude-x",
        isSubagent: true,
      });
      expect(trace.enrichment.captures).toMatchObject({
        consulted: true,
        available: true,
        hiddenCallCount: 1,
      });
    });

    it("interpolates the hidden call's position between the log lines its timestamp falls between", () => {
      const trace = buildEvaluationTrace(inputsWithCapture());
      const names = eventNames(trace);
      const hiddenIdx = names.indexOf("junrei.hidden_api_call");
      // T4 falls between line 5's T3 and line 7's T4/line 9's T6 — the hidden
      // call (also T4) must land after the line-6 events and no later than
      // the compaction/api-error/closing-turn events that follow it in time.
      const line5Idx = trace.events.findIndex((e) => e.provenance.line === 5);
      const line9Idx = trace.events.findIndex((e) => e.provenance.line === 9);
      expect(hiddenIdx).toBeGreaterThan(line5Idx);
      expect(hiddenIdx).toBeLessThan(line9Idx);
    });

    it("declares captures consulted-but-unavailable explicitly rather than omitting it", () => {
      const inputs = baseInputs();
      inputs.captures = {
        consulted: true,
        available: false,
        note: "no capture file for this session",
      };
      const trace = buildEvaluationTrace(inputs);
      expect(trace.enrichment.captures).toMatchObject({ consulted: true, available: false });
      expect(trace.sourceCompleteness.sources.map((s) => s.source)).toEqual([
        "claude-session-jsonl",
      ]);
    });
  });

  it("appends a line-less, timestamp-less hidden call at the very end, never mid-stream", () => {
    const inputs = baseInputs();
    inputs.captures = { consulted: true, available: true };
    inputs.hiddenCalls = [{ requestId: "req_hidden_no_ts", model: "claude-x" }];
    const trace = buildEvaluationTrace(inputs);
    expect(trace.events.at(-1)?.name).toBe("junrei.hidden_api_call");
  });
});
