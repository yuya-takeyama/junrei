/**
 * Codex analog of `../timeline.ts` — builds the Timeline lens (L2) entries
 * and single-record detail (L3) for a Codex rollout transcript, reusing the
 * EXISTING Claude `TimelineEntry` / `RecordDetail` vocabulary so the web
 * renders both harnesses with the same components (see
 * packages/web/src/lenses/Timeline.tsx / RecordDetail.tsx) — no Codex-only
 * entry kind or renderer exists or is needed.
 *
 * Kind mapping (see `buildCodexTimeline` below for the exact rules):
 *  - `event_msg user_message`            -> `user`
 *  - `event_msg agent_message`           -> `assistant-text`
 *  - `response_item reasoning`           -> `thinking` (the human-readable
 *    `summary` text is retained and rendered, same as Claude's thinking
 *    blocks; `encrypted_content` is opaque and is never read or surfaced)
 *  - `response_item function_call` /
 *    `custom_tool_call` / `local_shell_call` /
 *    `web_search_call`                   -> `tool-call`
 *  - `response_item compaction` (+ aliases) and
 *    the top-level `compacted` envelope   -> `compaction`
 *
 * Never emitted: `subagent-launch` and `task-notification` (Codex has no
 * subagent tree or background-task concept) and `api-error` (Codex's JSONL
 * has no structured API-error envelope — see `codex/parser.ts`). `turn_context`
 * / `task_started` / `task_complete` produce no entry either: Claude's own
 * vocabulary has no turn-boundary kind, so turn context is tracked
 * internally (for `model` attribution) rather than invented as a new kind.
 */

import type {
  RecordDetail,
  ThinkingEntry,
  TimelineEntry,
  ToolCallEntry,
  ToolCallRecordDetail,
  ToolCallStatus,
} from "../shared/timeline.js";
import {
  countLines,
  durationBetween,
  summarizeResultText,
  truncate,
  truncateOneLine,
} from "../shared/timeline.js";
import { isCodexToolOutputError, isSyntheticUserText } from "./analyze.js";
import type { CodexRecord, CodexTranscript } from "./parser.js";

const USER_TEXT_LIMIT = 700;
const ASSISTANT_TEXT_LIMIT = 700;
const INPUT_SUMMARY_LIMIT = 120;

/** Same key precedence as the Claude timeline's `summarizeToolInput`, applied after JSON-parsing Codex's stringified `arguments`/`input`. */
const CODEX_INPUT_SUMMARY_KEYS = [
  "command",
  "file_path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

/**
 * Codex `function_call.arguments` / `custom_tool_call.input` arrive as a
 * JSON-encoded string (unlike Claude's already-structured tool input), and
 * `command` is commonly a string array (e.g. `["pytest", "foo.spec.ts"]`)
 * rather than a single string — joined with spaces when found.
 */
function summarizeCodexArgs(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return truncateOneLine(raw, INPUT_SUMMARY_LIMIT);
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of CODEX_INPUT_SUMMARY_KEYS) {
      const value = obj[key];
      if (typeof value === "string") return truncateOneLine(value, INPUT_SUMMARY_LIMIT);
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        return truncateOneLine((value as string[]).join(" "), INPUT_SUMMARY_LIMIT);
      }
    }
  }
  return truncateOneLine(raw, INPUT_SUMMARY_LIMIT);
}

/** Best-effort JSON parse of a tool call's raw stringified input, for the record-detail's full `input` field — falls back to the raw string when it isn't valid JSON. */
function parseCodexInput(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Tool-call output/result linkage (shared by the entry- and detail-builders)
// ---------------------------------------------------------------------------

interface OutputInfo {
  text: string;
  success?: boolean;
  line: number;
  timestamp?: string;
}

interface ExecEndInfo {
  exitCode?: number;
  line: number;
  timestamp?: string;
}

interface CodexLinkMaps {
  outputByCallId: Map<string, OutputInfo>;
  execEndByCallId: Map<string, ExecEndInfo>;
}

/**
 * One forward pass linking `function_call_output` / `custom_tool_call_output`
 * response items and `exec_command_end` events back to the `call_id` that
 * opened them — mirrors `analyze.ts`'s `linkToolCalls`, but keyed for
 * per-entry result lookup rather than a session-wide count.
 */
function buildCodexLinkMaps(records: readonly CodexRecord[]): CodexLinkMaps {
  const outputByCallId = new Map<string, OutputInfo>();
  const execEndByCallId = new Map<string, ExecEndInfo>();

  for (const record of records) {
    if (record.type === "responseItem") {
      const item = record.item;
      if (item.kind === "functionCallOutput" || item.kind === "customToolCallOutput") {
        outputByCallId.set(item.callId, {
          text: item.text,
          ...(item.success !== undefined && { success: item.success }),
          line: record.line,
          ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
        });
      }
    } else if (record.type === "eventMsg" && record.event.kind === "execCommandEnd") {
      execEndByCallId.set(record.event.callId, {
        ...(record.event.exitCode !== undefined && { exitCode: record.event.exitCode }),
        line: record.line,
        ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      });
    }
  }

  return { outputByCallId, execEndByCallId };
}

interface CodexToolOutcome {
  status: ToolCallStatus;
  /** Full result text, when a `*_output` or `exec_command_end` signal exists. */
  text?: string;
  lineCount?: number;
  resultLine?: number;
  resultTimestamp?: string;
}

/**
 * Resolve one call's outcome: a matching `*_output` item wins when present
 * (richer, real tool-output text); otherwise a matching `exec_command_end`
 * (local shell calls report completion this way, not via `*_output`); a call
 * with neither is `missing-result`, same as Claude's `toolCallStatus`.
 */
function resolveCodexToolOutcome(
  callId: string | undefined,
  { outputByCallId, execEndByCallId }: CodexLinkMaps,
): CodexToolOutcome {
  const output = callId !== undefined ? outputByCallId.get(callId) : undefined;
  if (output !== undefined) {
    return {
      status: isCodexToolOutputError(output.success, output.text) ? "error" : "ok",
      text: output.text,
      lineCount: countLines(output.text),
      resultLine: output.line,
      ...(output.timestamp !== undefined && { resultTimestamp: output.timestamp }),
    };
  }
  const exec = callId !== undefined ? execEndByCallId.get(callId) : undefined;
  if (exec !== undefined) {
    const text = exec.exitCode !== undefined ? `exited with code ${exec.exitCode}` : undefined;
    return {
      status: exec.exitCode !== undefined && exec.exitCode !== 0 ? "error" : "ok",
      ...(text !== undefined && { text, lineCount: countLines(text) }),
      resultLine: exec.line,
      ...(exec.timestamp !== undefined && { resultTimestamp: exec.timestamp }),
    };
  }
  return { status: "missing-result" };
}

function buildCodexToolCallEntry(
  callId: string | undefined,
  name: string,
  inputSummary: string,
  line: number,
  timestamp: string | undefined,
  linkMaps: CodexLinkMaps,
): ToolCallEntry {
  const outcome = resolveCodexToolOutcome(callId, linkMaps);
  const durationMs = durationBetween(timestamp, outcome.resultTimestamp);
  return {
    kind: "tool-call",
    // web_search_call and a local_shell_call with no call_id have nothing to
    // key on — synthesize from the line so the entry still has a stable id.
    toolUseId: callId ?? `L${String(line)}`,
    name,
    inputSummary,
    status: outcome.status,
    line,
    ...(timestamp !== undefined && { timestamp }),
    ...(outcome.text !== undefined && { resultSummary: summarizeResultText(outcome.text) }),
    ...(outcome.lineCount !== undefined && { resultLineCount: outcome.lineCount }),
    ...(outcome.resultLine !== undefined && { resultLine: outcome.resultLine }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

function buildCodexToolCallDetail(
  callId: string | undefined,
  name: string,
  rawInput: string | undefined,
  line: number,
  timestamp: string | undefined,
  linkMaps: CodexLinkMaps,
): ToolCallRecordDetail {
  const outcome = resolveCodexToolOutcome(callId, linkMaps);
  const durationMs = durationBetween(timestamp, outcome.resultTimestamp);
  return {
    kind: "tool-call",
    toolUseId: callId ?? `L${String(line)}`,
    name,
    input: parseCodexInput(rawInput),
    status: outcome.status,
    line,
    ...(timestamp !== undefined && { timestamp }),
    ...(outcome.text !== undefined && { resultText: outcome.text }),
    ...(outcome.lineCount !== undefined && { resultLineCount: outcome.lineCount }),
    ...(outcome.resultLine !== undefined && { resultLine: outcome.resultLine }),
    ...(outcome.resultTimestamp !== undefined && { resultTimestamp: outcome.resultTimestamp }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

// ---------------------------------------------------------------------------
// User-prompt source selection
// ---------------------------------------------------------------------------

/**
 * Whether ANY `event_msg user_message` exists in the transcript. Real human
 * turns are always mirrored there; `response_item` `message` records with
 * `role: "user"` are either injected context (AGENTS.md / user_instructions /
 * environment_context — see `isSyntheticUserText`) or a duplicate of the same
 * turn. Mirrors `analyzeCodexSession`'s own session-wide fallback: only when
 * a transcript has NO `user_message` event at all do `response_item` user
 * messages get treated as the real prompt source (and even then, synthetic
 * ones are still skipped).
 */
function hasEventUserMessage(records: readonly CodexRecord[]): boolean {
  return records.some((r) => r.type === "eventMsg" && r.event.kind === "userMessage");
}

// ---------------------------------------------------------------------------
// buildCodexTimeline
// ---------------------------------------------------------------------------

/** Ordered, log-derived reconstruction of a Codex transcript for the Timeline lens — see this file's doc comment for the full kind mapping. */
export function buildCodexTimeline(transcript: CodexTranscript): TimelineEntry[] {
  const records = transcript.records;
  const linkMaps = buildCodexLinkMaps(records);
  const useEventUserMessages = hasEventUserMessage(records);

  const entries: TimelineEntry[] = [];
  // Model attribution for assistant-text/thinking entries: Codex doesn't
  // repeat the model per response item, only on `turn_context` — track the
  // most recent one seen so far, same as `analyzeCodexSession`'s `currentModel`.
  let currentModel: string | undefined;

  for (const record of records) {
    switch (record.type) {
      case "turnContext": {
        if (record.model !== undefined) currentModel = record.model;
        break;
      }
      case "eventMsg": {
        const event = record.event;
        if (event.kind === "userMessage" && event.text !== undefined && event.text !== "") {
          const { text, truncated } = truncate(event.text, USER_TEXT_LIMIT);
          entries.push({
            kind: "user",
            text,
            truncated,
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
          });
        } else if (event.kind === "agentMessage" && event.text !== undefined && event.text !== "") {
          const { text, truncated } = truncate(event.text, ASSISTANT_TEXT_LIMIT);
          entries.push({
            kind: "assistant-text",
            text,
            truncated,
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            ...(currentModel !== undefined && { model: currentModel }),
          });
        }
        break;
      }
      case "responseItem": {
        const item = record.item;
        if (item.kind === "message") {
          if (item.role !== "user" || useEventUserMessages) break;
          if (item.text === "" || isSyntheticUserText(item.text)) break;
          const { text, truncated } = truncate(item.text, USER_TEXT_LIMIT);
          entries.push({
            kind: "user",
            text,
            truncated,
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
          });
        } else if (item.kind === "reasoning") {
          const { text, truncated } = truncate(item.summaryText, ASSISTANT_TEXT_LIMIT);
          const entry: ThinkingEntry = {
            kind: "thinking",
            text,
            truncated,
            charCount: item.summaryText.length,
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
            ...(currentModel !== undefined && { model: currentModel }),
          };
          entries.push(entry);
        } else if (item.kind === "functionCall") {
          entries.push(
            buildCodexToolCallEntry(
              item.callId,
              item.name,
              summarizeCodexArgs(item.argumentsJson),
              record.line,
              record.timestamp,
              linkMaps,
            ),
          );
        } else if (item.kind === "customToolCall") {
          entries.push(
            buildCodexToolCallEntry(
              item.callId,
              item.name,
              summarizeCodexArgs(item.input),
              record.line,
              record.timestamp,
              linkMaps,
            ),
          );
        } else if (item.kind === "localShellCall") {
          entries.push(
            buildCodexToolCallEntry(
              item.callId,
              "shell",
              "",
              record.line,
              record.timestamp,
              linkMaps,
            ),
          );
        } else if (item.kind === "webSearchCall") {
          entries.push({
            kind: "tool-call",
            toolUseId: `L${String(record.line)}`,
            name: "web_search",
            inputSummary:
              item.query !== undefined ? truncateOneLine(item.query, INPUT_SUMMARY_LIMIT) : "",
            status: item.status === "failed" ? "error" : "ok",
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
          });
        } else if (item.kind === "compaction") {
          entries.push({
            kind: "compaction",
            line: record.line,
            ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
          });
        }
        break;
      }
      case "compacted": {
        entries.push({
          kind: "compaction",
          line: record.line,
          ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
        });
        break;
      }
      default:
        break; // sessionMeta / other — no timeline entry.
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// getCodexRecordDetail
// ---------------------------------------------------------------------------

/** Full record at one source line — for the Record detail (L3) slide-over, scoped to a Codex transcript. */
export function getCodexRecordDetail(
  transcript: CodexTranscript,
  line: number,
): RecordDetail | undefined {
  const records = transcript.records;
  const target = records.find((r) => r.line === line);
  if (target === undefined) return undefined;

  const linkMaps = buildCodexLinkMaps(records);
  const useEventUserMessages = hasEventUserMessage(records);

  // Model as of this record: the most recent `turn_context.model` at or
  // before `line` — mirrors `buildCodexTimeline`'s running `currentModel`.
  let currentModel: string | undefined;
  for (const record of records) {
    if (record.type === "turnContext" && record.model !== undefined) currentModel = record.model;
    if (record.line === line) break;
  }

  if (target.type === "eventMsg") {
    const event = target.event;
    if (event.kind === "userMessage") {
      return {
        kind: "user",
        text: event.text ?? "",
        line,
        ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
      };
    }
    if (event.kind === "agentMessage" && event.text !== undefined && event.text !== "") {
      return {
        kind: "assistant-text",
        text: event.text,
        line,
        ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
        ...(currentModel !== undefined && { model: currentModel }),
      };
    }
    return undefined;
  }

  if (target.type === "responseItem") {
    const item = target.item;
    if (item.kind === "message") {
      if (item.role !== "user" || item.text === "") return undefined;
      // Injected context (AGENTS.md merge / user_instructions /
      // environment_context) never surfaces as a user_message EVENT, so it
      // stays viewable regardless of `useEventUserMessages` — the Files lens
      // links an injected-only fileAccess entry straight to this record.
      // Real user prompts on this surface still defer to the event record
      // when one exists (same dedup rule as `buildCodexTimeline`).
      if (isSyntheticUserText(item.text)) {
        return {
          kind: "injected-context",
          text: item.text,
          charCount: item.text.length,
          line,
          ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
        };
      }
      if (useEventUserMessages) return undefined;
      return {
        kind: "user",
        text: item.text,
        line,
        ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
      };
    }
    if (item.kind === "reasoning") {
      return {
        kind: "thinking",
        text: item.summaryText,
        charCount: item.summaryText.length,
        line,
        ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
        ...(currentModel !== undefined && { model: currentModel }),
      };
    }
    if (item.kind === "functionCall") {
      return buildCodexToolCallDetail(
        item.callId,
        item.name,
        item.argumentsJson,
        line,
        target.timestamp,
        linkMaps,
      );
    }
    if (item.kind === "customToolCall") {
      return buildCodexToolCallDetail(
        item.callId,
        item.name,
        item.input,
        line,
        target.timestamp,
        linkMaps,
      );
    }
    if (item.kind === "localShellCall") {
      return buildCodexToolCallDetail(
        item.callId,
        "shell",
        undefined,
        line,
        target.timestamp,
        linkMaps,
      );
    }
    if (item.kind === "webSearchCall") {
      return {
        kind: "tool-call",
        toolUseId: `L${String(line)}`,
        name: "web_search",
        input: { query: item.query },
        status: item.status === "failed" ? "error" : "ok",
        line,
        ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
      };
    }
    if (item.kind === "compaction") {
      return {
        kind: "compaction",
        line,
        ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
      };
    }
    return undefined;
  }

  if (target.type === "compacted") {
    return {
      kind: "compaction",
      line,
      ...(target.timestamp !== undefined && { timestamp: target.timestamp }),
    };
  }

  return undefined;
}
