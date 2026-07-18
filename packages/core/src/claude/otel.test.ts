import { describe, expect, it } from "vitest";
import { extractSessionId, parseOtelSessionLines } from "./otel.js";

// ---------------------------------------------------------------------------
// Synthetic OTLP/HTTP JSON fixture builders — invented values, no real
// captures (Goshuin Decision 9/4 forbid committing real capture data). Shapes
// follow the OTLP/JSON encoding (attribute values as {stringValue|intValue|
// doubleValue|boolValue}, int64 timestamps as decimal strings) and the event/
// attribute vocabulary the completeness study observed on real Claude Code
// captures (docs/research/claude-code-session-log-completeness.md).
// ---------------------------------------------------------------------------

function attr(key: string, value: unknown) {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isInteger(value)) {
    return { key, value: { intValue: String(value) } };
  }
  return { key, value: { doubleValue: value as number } };
}

function logsBody(records: unknown[], resourceAttributes: unknown[] = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [{ scope: { name: "com.anthropic.claude_code" }, logRecords: records }],
      },
    ],
  };
}

function metricsBody(metrics: unknown[], resourceAttributes: unknown[] = []) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
}

function apiRequestRecord(
  opts: { costUsd?: number; durationMs?: number; timeUnixNano?: string } = {},
) {
  const attributes = [attr("event.name", "api_request")];
  if (opts.costUsd !== undefined) attributes.push(attr("cost_usd", opts.costUsd));
  if (opts.durationMs !== undefined) attributes.push(attr("duration_ms", opts.durationMs));
  return {
    timeUnixNano: opts.timeUnixNano ?? "1700000000000000000",
    attributes,
    body: { stringValue: "api_request" },
  };
}

function toolDecisionRecord(opts: { toolName?: string; decision?: string; source?: string } = {}) {
  const attributes = [attr("event.name", "tool_decision")];
  if (opts.toolName !== undefined) attributes.push(attr("tool_name", opts.toolName));
  if (opts.decision !== undefined) attributes.push(attr("decision", opts.decision));
  if (opts.source !== undefined) attributes.push(attr("source", opts.source));
  return {
    timeUnixNano: "1700000000000000000",
    attributes,
    body: { stringValue: "tool_decision" },
  };
}

describe("extractSessionId", () => {
  it("finds session.id on a logs export's resource attributes", () => {
    const body = logsBody([apiRequestRecord()], [attr("session.id", "sess-resource")]);
    expect(extractSessionId(body)).toBe("sess-resource");
  });

  it("falls back to a logs export's per-record attributes when the resource carries none", () => {
    const record = apiRequestRecord();
    (record.attributes as unknown[]).push(attr("session.id", "sess-record"));
    const body = logsBody([record]);
    expect(extractSessionId(body)).toBe("sess-record");
  });

  it("finds session.id on a metrics export's resource attributes", () => {
    const body = metricsBody(
      [
        {
          name: "claude_code.cost.usage",
          sum: { dataPoints: [{ asDouble: 0.1, attributes: [] }] },
        },
      ],
      [attr("session.id", "sess-metric-resource")],
    );
    expect(extractSessionId(body)).toBe("sess-metric-resource");
  });

  it("falls back to a metrics export's per-data-point attributes when the resource carries none", () => {
    const body = metricsBody([
      {
        name: "claude_code.cost.usage",
        sum: {
          dataPoints: [{ asDouble: 0.1, attributes: [attr("session.id", "sess-datapoint")] }],
        },
      },
    ]);
    expect(extractSessionId(body)).toBe("sess-datapoint");
  });

  it("returns undefined when no session.id is present anywhere", () => {
    const body = logsBody([apiRequestRecord()]);
    expect(extractSessionId(body)).toBeUndefined();
  });

  it("returns undefined for a body matching neither OTLP export shape", () => {
    expect(extractSessionId({ foo: "bar" })).toBeUndefined();
    expect(extractSessionId(null)).toBeUndefined();
    expect(extractSessionId("not an object")).toBeUndefined();
  });
});

describe("parseOtelSessionLines", () => {
  it("counts log and metric payloads separately", () => {
    const lines = [
      JSON.stringify(logsBody([apiRequestRecord()])),
      JSON.stringify(metricsBody([{ name: "claude_code.token.usage", sum: { dataPoints: [] } }])),
      JSON.stringify(logsBody([apiRequestRecord()])),
    ];
    const result = parseOtelSessionLines(lines);
    expect(result.logPayloads).toBe(2);
    expect(result.metricPayloads).toBe(1);
    expect(result.malformedLines).toBe(0);
  });

  it("sums cost_usd and computes duration stats from api_request events", () => {
    const lines = [
      JSON.stringify(
        logsBody([
          apiRequestRecord({ costUsd: 0.01, durationMs: 100 }),
          apiRequestRecord({ costUsd: 0.02, durationMs: 300 }),
          apiRequestRecord({ costUsd: 0.005 }), // no duration attribute
        ]),
      ),
    ];
    const result = parseOtelSessionLines(lines);
    expect(result.apiRequests.count).toBe(3);
    expect(result.apiRequests.costSource).toBe("api_request_events");
    expect(result.apiRequests.costUsdSum).toBeCloseTo(0.035, 6);
    expect(result.apiRequests.duration).toEqual({
      count: 2,
      sumMs: 400,
      minMs: 100,
      maxMs: 300,
      avgMs: 200,
    });
  });

  it("falls back to the cost.usage metric when no api_request event carries cost_usd", () => {
    const lines = [
      JSON.stringify(logsBody([apiRequestRecord({ durationMs: 50 })])), // no cost_usd
      JSON.stringify(
        metricsBody([
          {
            name: "claude_code.cost.usage",
            sum: { dataPoints: [{ asDouble: 0.03 }, { asDouble: 0.04 }] },
          },
        ]),
      ),
    ];
    const result = parseOtelSessionLines(lines);
    expect(result.apiRequests.costSource).toBe("cost_metric");
    expect(result.apiRequests.costUsdSum).toBeCloseTo(0.07, 6);
    // api_request count/duration still come from the log event, independent of cost source.
    expect(result.apiRequests.count).toBe(1);
    expect(result.apiRequests.duration?.count).toBe(1);
  });

  it("declares costSource 'none' with a zero sum when neither signal carries cost", () => {
    const lines = [JSON.stringify(logsBody([apiRequestRecord()]))];
    const result = parseOtelSessionLines(lines);
    expect(result.apiRequests.costSource).toBe("none");
    expect(result.apiRequests.costUsdSum).toBe(0);
  });

  it("extracts tool_decision events with tool name/decision/source/timestamp", () => {
    const lines = [
      JSON.stringify(
        logsBody([
          toolDecisionRecord({ toolName: "Bash", decision: "accept", source: "config" }),
          toolDecisionRecord({ toolName: "Read", decision: "reject", source: "user_reject" }),
        ]),
      ),
    ];
    const result = parseOtelSessionLines(lines);
    expect(result.toolDecisions.total).toBe(2);
    expect(result.toolDecisions.truncated).toBe(false);
    expect(result.toolDecisions.entries).toEqual([
      {
        toolName: "Bash",
        decision: "accept",
        source: "config",
        timestamp: new Date(1_700_000_000_000).toISOString(),
      },
      {
        toolName: "Read",
        decision: "reject",
        source: "user_reject",
        timestamp: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  it("caps toolDecisions.entries at maxToolDecisions while keeping total exact", () => {
    const records = [
      toolDecisionRecord({ toolName: "A", decision: "accept" }),
      toolDecisionRecord({ toolName: "B", decision: "accept" }),
      toolDecisionRecord({ toolName: "C", decision: "accept" }),
    ];
    const lines = [JSON.stringify(logsBody(records))];
    const result = parseOtelSessionLines(lines, { maxToolDecisions: 2 });
    expect(result.toolDecisions.total).toBe(3);
    expect(result.toolDecisions.entries).toHaveLength(2);
    expect(result.toolDecisions.truncated).toBe(true);
  });

  it("collects mcp_server_connection and hook_* events as health, keyed by kind", () => {
    const mcpRecord = {
      timeUnixNano: "1700000000000000000",
      attributes: [attr("event.name", "mcp_server_connection"), attr("status", "failed")],
      body: { stringValue: "mcp_server_connection" },
    };
    const hookRecord = {
      timeUnixNano: "1700000000000000000",
      attributes: [attr("event.name", "hook_execution_complete"), attr("exit_code", 0)],
      body: { stringValue: "hook_execution_complete" },
    };
    const lines = [JSON.stringify(logsBody([mcpRecord, hookRecord]))];
    const result = parseOtelSessionLines(lines);
    expect(result.health).toHaveLength(2);
    expect(result.health[0]).toMatchObject({ kind: "mcp", eventName: "mcp_server_connection" });
    expect(result.health[0]?.attributes).toMatchObject({ status: "failed" });
    expect(result.health[1]).toMatchObject({ kind: "hook", eventName: "hook_execution_complete" });
    expect(result.health[1]?.attributes).toMatchObject({ exit_code: 0 });
  });

  it("declares unrecognized event and metric types by name rather than dropping them", () => {
    const userPromptRecord = {
      timeUnixNano: "1700000000000000000",
      attributes: [attr("event.name", "user_prompt")],
      body: { stringValue: "user_prompt" },
    };
    const lines = [
      JSON.stringify(logsBody([userPromptRecord, userPromptRecord])),
      JSON.stringify(metricsBody([{ name: "claude_code.session.count", sum: { dataPoints: [] } }])),
    ];
    const result = parseOtelSessionLines(lines);
    expect(result.unrecognizedEventCounts).toEqual({ user_prompt: 2 });
    expect(result.unrecognizedMetricCounts).toEqual({ "claude_code.session.count": 1 });
  });

  it("counts unparseable JSON and non-OTLP-shaped lines as malformed, and skips blank lines", () => {
    const lines = ["not json at all", "", "   ", JSON.stringify({ notAnOtlpBody: true }), "null"];
    const result = parseOtelSessionLines(lines);
    expect(result.malformedLines).toBe(3);
    expect(result.logPayloads).toBe(0);
    expect(result.metricPayloads).toBe(0);
  });
});
