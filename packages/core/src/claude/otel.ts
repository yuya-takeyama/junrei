/**
 * Claude Code OTLP (OpenTelemetry) parsing — Goshuin milestone Phase E (see
 * docs/milestones/goshuin.md, Decision 7). Claude Code exports logs/metrics
 * over OTLP/HTTP JSON when launched with `OTEL_LOGS_EXPORTER=otlp` /
 * `OTEL_METRICS_EXPORTER=otlp` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`;
 * `@junrei/server`'s opt-in receiver (`src/otel.ts`) stores each POSTed
 * export body verbatim, one per JSONL line, under
 * `<JUNREI_OTEL_DIR>/<session.id>.jsonl`. This module is the pure,
 * dependency-free (no OTel SDK, no `node:fs`) parsing layer over those
 * lines — ported knowledge from `experiments/claude-code-capture/`'s
 * validated OTLP collector (`otel-collector.mjs`) and its digest tool
 * (`summarize-run.mjs`, whose `collectLogRecords`/`collectMetrics`/
 * `attrValue` helpers this module's OTLP-JSON walking mirrors) plus the
 * event/attribute vocabulary the completeness study observed on real
 * captures (docs/research/claude-code-session-log-completeness.md, "What
 * OTel adds — and doesn't"): log events `user_prompt`, `tool_decision`,
 * `tool_result`, `api_request`, `assistant_response`, `subagent_completed`,
 * `hook_execution_start`/`hook_execution_complete`, `hook_registered`,
 * `plugin_loaded`, `mcp_server_connection`; metrics `session.count`,
 * `cost.usage`, `token.usage`, `active_time.total`. `event.name` is the
 * log record's own attribute key carrying the event type (falling back to
 * the record's `body.stringValue`, same fallback `summarize-run.mjs` uses).
 *
 * `no node:fs in core`: every function here takes already-read data
 * (`unknown` OTLP bodies, or raw JSONL line strings) — the receiver and the
 * `get_session_observability` MCP tool (`@junrei/server`) own all file I/O.
 */

// ---------------------------------------------------------------------------
// OTLP/JSON structural helpers — generic walking, no Claude-specific
// knowledge. Types are intentionally loose (`unknown`-rooted): this module
// only trusts what it can find, degrading a missing/malformed shape to
// "not found" rather than throwing, since OTLP export bodies come straight
// off the wire.
// ---------------------------------------------------------------------------

interface OtlpKeyValue {
  key?: unknown;
  value?: unknown;
}

/** One AnyValue's scalar payload, ported from summarize-run.mjs's `attrValue`. */
function scalarOf(value: unknown): string | number | boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.intValue === "string") return Number(v.intValue);
  if (typeof v.intValue === "number") return v.intValue;
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  return undefined;
}

function isKeyValueArray(attributes: unknown): attributes is OtlpKeyValue[] {
  return Array.isArray(attributes);
}

/** First matching attribute's scalar value, or `undefined` if absent/unreadable. */
function findAttr(attributes: unknown, key: string): string | number | boolean | undefined {
  if (!isKeyValueArray(attributes)) return undefined;
  for (const attr of attributes) {
    if (attr?.key === key) return scalarOf(attr.value);
  }
  return undefined;
}

function findAttrString(attributes: unknown, key: string): string | undefined {
  const v = findAttr(attributes, key);
  return v === undefined ? undefined : String(v);
}

function findAttrNumber(attributes: unknown, key: string): number | undefined {
  const v = findAttr(attributes, key);
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Every attribute flattened to a plain record, for events this module doesn't parse structurally (health/unrecognized). */
function attributesRecordOf(attributes: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!isKeyValueArray(attributes)) return out;
  for (const attr of attributes) {
    if (typeof attr?.key !== "string") continue;
    const v = scalarOf(attr.value);
    if (v !== undefined) out[attr.key] = v;
  }
  return out;
}

/** logRecord.timeUnixNano (string or number, per OTLP/JSON's mixed int64 encoding) -> ISO 8601, or `undefined` if unreadable. */
function isoFromUnixNano(nano: unknown): string | undefined {
  if (typeof nano !== "string" && typeof nano !== "number") return undefined;
  try {
    const asBigInt = typeof nano === "number" ? BigInt(Math.trunc(nano)) : BigInt(nano);
    const ms = asBigInt / 1_000_000n;
    return new Date(Number(ms)).toISOString();
  } catch {
    return undefined;
  }
}

/** Direct port of summarize-run.mjs's `collectLogRecords`: resourceLogs[].scopeLogs[].logRecords[]. */
function collectLogRecords(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const resourceLogs = (body as Record<string, unknown>).resourceLogs;
  if (!Array.isArray(resourceLogs)) return [];
  const out: unknown[] = [];
  for (const rl of resourceLogs) {
    const scopeLogs = (rl as Record<string, unknown> | undefined)?.scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const sl of scopeLogs) {
      const logRecords = (sl as Record<string, unknown> | undefined)?.logRecords;
      if (Array.isArray(logRecords)) out.push(...logRecords);
    }
  }
  return out;
}

/** Direct port of summarize-run.mjs's `collectMetrics`: resourceMetrics[].scopeMetrics[].metrics[]. */
function collectMetrics(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const resourceMetrics = (body as Record<string, unknown>).resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return [];
  const out: unknown[] = [];
  for (const rm of resourceMetrics) {
    const scopeMetrics = (rm as Record<string, unknown> | undefined)?.scopeMetrics;
    if (!Array.isArray(scopeMetrics)) continue;
    for (const sm of scopeMetrics) {
      const metrics = (sm as Record<string, unknown> | undefined)?.metrics;
      if (Array.isArray(metrics)) out.push(...metrics);
    }
  }
  return out;
}

/** Every resource-level attribute array across a logs/metrics export body's resourceLogs/resourceMetrics entries. */
function resourceAttributeArrays(
  body: unknown,
  resourceListKey: "resourceLogs" | "resourceMetrics",
): unknown[][] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as Record<string, unknown>)[resourceListKey];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const resource = (entry as Record<string, unknown> | undefined)?.resource as
      | Record<string, unknown>
      | undefined;
    return (resource?.attributes as unknown[] | undefined) ?? [];
  });
}

/** A metric's numeric data points, whichever of gauge/sum/histogram it is — `[]` for unsupported metric shapes (e.g. exponential histogram, summary). */
function dataPointsOf(metric: unknown): unknown[] {
  if (typeof metric !== "object" || metric === null) return [];
  const m = metric as Record<string, unknown>;
  const gauge = (m.gauge as Record<string, unknown> | undefined)?.dataPoints;
  if (Array.isArray(gauge)) return gauge;
  const sum = (m.sum as Record<string, unknown> | undefined)?.dataPoints;
  if (Array.isArray(sum)) return sum;
  const histogram = (m.histogram as Record<string, unknown> | undefined)?.dataPoints;
  if (Array.isArray(histogram)) return histogram;
  return [];
}

function dataPointValue(dataPoint: unknown): number | undefined {
  if (typeof dataPoint !== "object" || dataPoint === null) return undefined;
  const dp = dataPoint as Record<string, unknown>;
  if (typeof dp.asDouble === "number") return dp.asDouble;
  if (typeof dp.asInt === "string") return Number(dp.asInt);
  if (typeof dp.asInt === "number") return dp.asInt;
  // Histogram data points carry an aggregate `sum` instead of a single value.
  if (typeof dp.sum === "number") return dp.sum;
  return undefined;
}

// ---------------------------------------------------------------------------
// session.id extraction (receiver-side routing) — checks resource-level
// attributes first (Claude Code attaches session.id as a common attribute
// shared by every record in an export), then falls back to per-record /
// per-data-point attributes for exporters that place it differently.
// ---------------------------------------------------------------------------

const SESSION_ID_ATTR = "session.id";

/**
 * Extract `session.id` from a parsed OTLP/HTTP JSON export body (either an
 * `ExportLogsServiceRequest` or `ExportMetricsServiceRequest`), checking
 * resource attributes before per-record/per-data-point attributes.
 * `undefined` when the body has neither shape or carries no session id
 * anywhere — the receiver routes such records to `_unassigned.jsonl` rather
 * than guessing.
 */
export function extractSessionId(body: unknown): string | undefined {
  for (const attrs of resourceAttributeArrays(body, "resourceLogs")) {
    const id = findAttrString(attrs, SESSION_ID_ATTR);
    if (id !== undefined) return id;
  }
  for (const record of collectLogRecords(body)) {
    const id = findAttrString(
      (record as Record<string, unknown> | undefined)?.attributes,
      SESSION_ID_ATTR,
    );
    if (id !== undefined) return id;
  }
  for (const attrs of resourceAttributeArrays(body, "resourceMetrics")) {
    const id = findAttrString(attrs, SESSION_ID_ATTR);
    if (id !== undefined) return id;
  }
  for (const metric of collectMetrics(body)) {
    for (const dp of dataPointsOf(metric)) {
      const id = findAttrString(
        (dp as Record<string, unknown> | undefined)?.attributes,
        SESSION_ID_ATTR,
      );
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session-scoped aggregation — `parseOtelSessionLines` takes one session's
// stored JSONL lines (already scoped to that session by the receiver's
// per-session file, or the `_unassigned` bucket) and derives the aggregates
// `get_session_observability` serves.
// ---------------------------------------------------------------------------

export interface OtelDurationStats {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

export type OtelCostSource = "api_request_events" | "cost_metric" | "none";

export interface OtelApiRequestStats {
  count: number;
  costUsdSum: number;
  /** Which signal the cost figure came from — events are per-request (and can also carry duration), metrics are session-scoped totals. */
  costSource: OtelCostSource;
  /** `undefined` when no `api_request` event carried a `duration_ms` attribute. */
  duration?: OtelDurationStats;
}

export interface OtelToolDecision {
  toolName?: string;
  decision?: string;
  source?: string;
  timestamp?: string;
}

export interface OtelHealthEvent {
  kind: "mcp" | "hook";
  eventName: string;
  timestamp?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface OtelSessionAnalysis {
  /** OTLP export payloads (POST bodies) seen for this session, one count per signal. */
  logPayloads: number;
  metricPayloads: number;
  /** Lines that failed to parse as JSON, or parsed but matched neither an OTLP logs nor metrics export shape — declared, never silently dropped. */
  malformedLines: number;
  apiRequests: OtelApiRequestStats;
  toolDecisions: {
    total: number;
    entries: OtelToolDecision[];
    /** `true` when `total` exceeds `entries.length` (capped by `maxToolDecisions`). */
    truncated: boolean;
  };
  health: OtelHealthEvent[];
  /** Every OTHER log event type seen, by name, with its count — "declared, not dropped silently" (spec: counts of unrecognized event types). */
  unrecognizedEventCounts: Record<string, number>;
  /** Every OTHER metric name seen (not the cost metric), by name, with its count. */
  unrecognizedMetricCounts: Record<string, number>;
}

export interface ParseOtelSessionOptions {
  /** Cap on `toolDecisions.entries` — `total` stays exact past the cap. Default 500. */
  maxToolDecisions?: number;
}

const DEFAULT_MAX_TOOL_DECISIONS = 500;

/** `event.name` attribute value, falling back to the log record's own body text — same fallback summarize-run.mjs uses. */
function eventNameOf(record: unknown): string {
  const attrs = (record as Record<string, unknown> | undefined)?.attributes;
  const fromAttr = findAttrString(attrs, "event.name");
  if (fromAttr !== undefined) return fromAttr;
  const body = (record as Record<string, unknown> | undefined)?.body;
  const stringValue = (body as Record<string, unknown> | undefined)?.stringValue;
  return typeof stringValue === "string" ? stringValue : "__unknown";
}

/** Cost metric names observed end with `cost.usage` (`session-log-completeness.md`'s `cost.usage`; Claude Code's own metric names may carry a `claude_code.` prefix — matched by suffix so either form is recognized). */
function isCostMetric(name: string): boolean {
  return name === "cost.usage" || name.endsWith(".cost.usage");
}

function isHookEvent(eventName: string): boolean {
  return eventName === "hook_registered" || eventName.startsWith("hook_execution_");
}

/**
 * Parse one session's stored OTel JSONL lines (raw strings — this function
 * owns the `JSON.parse`, per the "no node:fs in core: parse from provided
 * lines" constraint) into the aggregates `get_session_observability` needs:
 * authoritative cost (summed `cost_usd` off `api_request` log events when
 * present, else summed off `cost.usage` metric data points), api request
 * count + duration stats (from `api_request`'s `duration_ms` attribute, when
 * exported), `tool_decision` events, MCP/hook health events, and a declared
 * count of every event/metric type this parser doesn't specifically model.
 *
 * A line that isn't valid JSON, or doesn't match either OTLP export shape
 * (`resourceLogs` / `resourceMetrics` at the top level), counts toward
 * `malformedLines` rather than throwing — stored lines are exactly what a
 * (possibly future, possibly buggy) exporter POSTed, so this parser must
 * degrade gracefully on garbage rather than fail the whole session's
 * observability read.
 */
export function parseOtelSessionLines(
  lines: readonly string[],
  options: ParseOtelSessionOptions = {},
): OtelSessionAnalysis {
  const maxToolDecisions = options.maxToolDecisions ?? DEFAULT_MAX_TOOL_DECISIONS;

  let logPayloads = 0;
  let metricPayloads = 0;
  let malformedLines = 0;

  let apiRequestCount = 0;
  let apiRequestCostSum = 0;
  let sawApiRequestCost = false;
  const durationSamplesMs: number[] = [];

  let toolDecisionTotal = 0;
  const toolDecisions: OtelToolDecision[] = [];

  const health: OtelHealthEvent[] = [];
  const unrecognizedEventCounts: Record<string, number> = {};

  let metricCostSum = 0;
  let sawCostMetric = false;
  const unrecognizedMetricCounts: Record<string, number> = {};

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;

    let body: unknown;
    try {
      body = JSON.parse(trimmed);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof body !== "object" || body === null) {
      malformedLines += 1;
      continue;
    }
    const rec = body as Record<string, unknown>;
    const hasLogs = Array.isArray(rec.resourceLogs);
    const hasMetrics = Array.isArray(rec.resourceMetrics);
    if (!hasLogs && !hasMetrics) {
      malformedLines += 1;
      continue;
    }

    if (hasLogs) {
      logPayloads += 1;
      for (const record of collectLogRecords(body)) {
        const attrs = (record as Record<string, unknown> | undefined)?.attributes;
        const eventName = eventNameOf(record);
        const timestamp = isoFromUnixNano(
          (record as Record<string, unknown> | undefined)?.timeUnixNano,
        );

        if (eventName === "api_request") {
          apiRequestCount += 1;
          const cost = findAttrNumber(attrs, "cost_usd");
          if (cost !== undefined) {
            apiRequestCostSum += cost;
            sawApiRequestCost = true;
          }
          const durationMs = findAttrNumber(attrs, "duration_ms");
          if (durationMs !== undefined) durationSamplesMs.push(durationMs);
        } else if (eventName === "tool_decision") {
          toolDecisionTotal += 1;
          if (toolDecisions.length < maxToolDecisions) {
            const toolName = findAttrString(attrs, "tool_name");
            const decision = findAttrString(attrs, "decision");
            const decisionSource = findAttrString(attrs, "source");
            toolDecisions.push({
              ...(toolName !== undefined && { toolName }),
              ...(decision !== undefined && { decision }),
              ...(decisionSource !== undefined && { source: decisionSource }),
              ...(timestamp !== undefined && { timestamp }),
            });
          }
        } else if (eventName === "mcp_server_connection") {
          health.push({
            kind: "mcp",
            eventName,
            ...(timestamp !== undefined && { timestamp }),
            attributes: attributesRecordOf(attrs),
          });
        } else if (isHookEvent(eventName)) {
          health.push({
            kind: "hook",
            eventName,
            ...(timestamp !== undefined && { timestamp }),
            attributes: attributesRecordOf(attrs),
          });
        } else {
          unrecognizedEventCounts[eventName] = (unrecognizedEventCounts[eventName] ?? 0) + 1;
        }
      }
    }

    if (hasMetrics) {
      metricPayloads += 1;
      for (const metric of collectMetrics(body)) {
        const name =
          typeof (metric as Record<string, unknown> | undefined)?.name === "string"
            ? ((metric as Record<string, unknown>).name as string)
            : "__unknown";
        if (isCostMetric(name)) {
          sawCostMetric = true;
          for (const dp of dataPointsOf(metric)) {
            const value = dataPointValue(dp);
            if (value !== undefined) metricCostSum += value;
          }
        } else {
          unrecognizedMetricCounts[name] = (unrecognizedMetricCounts[name] ?? 0) + 1;
        }
      }
    }
  }

  const costUsdSum = sawApiRequestCost ? apiRequestCostSum : metricCostSum;
  const costSource: OtelCostSource = sawApiRequestCost
    ? "api_request_events"
    : sawCostMetric
      ? "cost_metric"
      : "none";

  let duration: OtelDurationStats | undefined;
  if (durationSamplesMs.length > 0) {
    const sumMs = durationSamplesMs.reduce((a, b) => a + b, 0);
    duration = {
      count: durationSamplesMs.length,
      sumMs,
      minMs: Math.min(...durationSamplesMs),
      maxMs: Math.max(...durationSamplesMs),
      avgMs: sumMs / durationSamplesMs.length,
    };
  }

  return {
    logPayloads,
    metricPayloads,
    malformedLines,
    apiRequests: {
      count: apiRequestCount,
      costUsdSum,
      costSource,
      ...(duration !== undefined && { duration }),
    },
    toolDecisions: {
      total: toolDecisionTotal,
      entries: toolDecisions,
      truncated: toolDecisionTotal > toolDecisions.length,
    },
    health,
    unrecognizedEventCounts,
    unrecognizedMetricCounts,
  };
}
