import type { RecordDetail } from "../../api.js";

/**
 * Mirrors `TOOL_RESULT_TEXT_LIMIT` in `packages/core/src/parser.ts` — the
 * parser caps captured tool-result text at this many characters. That
 * constant isn't exported from core, so it's re-declared here (web-only
 * change); a captured `resultText`/`returnedText` whose length hits this
 * exact value means the true tool output was longer and got truncated at
 * parse time, not that the output happened to be exactly this long.
 */
export const TOOL_RESULT_TEXT_CAP = 2000;

/** Human label for the slide-over header — see design-spec/17-record-detail.md's anatomy. */
export const RECORD_KIND_LABEL: Record<RecordDetail["kind"], string> = {
  user: "User message",
  "injected-context": "Injected context",
  "assistant-text": "Assistant message",
  thinking: "Thinking",
  "tool-call": "Tool call",
  "subagent-launch": "Subagent launch",
  "task-notification": "Task notification",
  compaction: "Compaction",
  "api-error": "API error",
};

/** Pretty-printed JSON for on-screen display — never throws (falls back to `String(value)`). */
export function prettyJson(value: unknown): string {
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

/**
 * Raw (minified) JSON for the clipboard — per 2s's interaction note: "Payloads
 * copy raw JSON, not pretty-printed" even though the on-screen `.code` block
 * shows the pretty-printed form for readability.
 */
export function rawJson(value: unknown): string {
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

/** Whether a captured result/returned text hit the parser's capture cap (see `TOOL_RESULT_TEXT_CAP`). */
export function isResultCapped(text: string | undefined): boolean {
  return text !== undefined && text.length >= TOOL_RESULT_TEXT_CAP;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** Label for the Result/Returned section header, e.g. "Result · 412 lines · ok". */
export function resultSectionLabel(
  prefix: string,
  text: string | undefined,
  status?: string,
): string {
  if (text === undefined) return `${prefix} · none captured`;
  const parts = [`${countLines(text)} lines`];
  if (status !== undefined) parts.push(status);
  return `${prefix} · ${parts.join(" · ")}`;
}
