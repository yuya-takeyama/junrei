import type { RecordDetail } from "../../api.js";

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

/**
 * Whether a captured result/returned text is still short of the tool's TRUE
 * output — driven by the backend's explicit `resultTextFullCharCount` /
 * `returnedTextFullCharCount` companion field (see `ToolCallRecordDetail`/
 * `SubagentLaunchRecordDetail` in `@junrei/core`), never a length heuristic:
 * the backend recovers the full text from the record's raw source line
 * whenever the parser's own parse-time capture cap would otherwise have cut
 * it, so a captured text landing at/above that old cap no longer implies
 * truncation by itself — only the explicit signal does.
 */
export function isResultCapped(fullCharCount: number | undefined): boolean {
  return fullCharCount !== undefined;
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
