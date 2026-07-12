/**
 * Cross-harness searchable-text vocabulary — the field kinds, the generic
 * value-flattening helper, and the tiny record-shape guards both
 * `claude/search.ts`'s `extractClaudeSearchFields` and `codex/search.ts`'s
 * `extractCodexSearchFields` need, without either harness reaching into the
 * other's module.
 *
 * Both extractors take one RAW parsed JSONL record (the `JSON.parse` of a
 * line, not a parser's normalized record) and return the DECODED string
 * fields a substring search should run against. Raw records are deliberate:
 * the normalizers truncate tool results and drop thinking text entirely
 * (length only), which would silently blind a search. Matching decoded
 * values — rather than the raw JSON line — means a query containing `"` or a
 * newline needs no escaping, and JSON escaping inside the log can never
 * split an occurrence.
 */

/** Which part of a record a searchable text came from — also the search API's field filter. */
export type SearchFieldKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_input"
  | "tool_result"
  | "title";

export interface SearchableField {
  field: SearchFieldKind;
  /** Set when the record itself names the tool (tool_use / function_call / …). */
  toolName?: string;
  /** Decoded text to match against. Never empty. */
  text: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const FLATTEN_DEPTH_LIMIT = 8;

function flatten(value: unknown, out: string[], depth: number): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (depth >= FLATTEN_DEPTH_LIMIT) return;
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) flatten(item, out, depth + 1);
  }
}

/**
 * Flatten a structured tool input/action into newline-joined decoded VALUES.
 * Key names are deliberately not included: emitting only decoded values (with
 * `\n` joins, which no escape-free query can span) guarantees that any query
 * eligible for the server's raw-line fast path and matching this text also
 * appears verbatim in the raw JSONL line — synthetic `key: value` text would
 * make the fast path silently miss what the slow path finds.
 */
export function flattenToSearchText(value: unknown): string {
  const lines: string[] = [];
  flatten(value, lines, 0);
  return lines.join("\n");
}

/** Push a non-empty searchable field onto `out` — shared by both harnesses' extractors. */
export function push(
  out: SearchableField[],
  field: SearchFieldKind,
  text: string,
  toolName?: string,
): void {
  if (text === "") return;
  out.push({ field, text, ...(toolName !== undefined && { toolName }) });
}
