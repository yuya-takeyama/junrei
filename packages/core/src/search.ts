/**
 * Searchable-text extraction for transcript search.
 *
 * Both extractors take one RAW parsed JSONL record (the `JSON.parse` of a
 * line, not `parser.ts`'s normalized records) and return the DECODED string
 * fields a substring search should run against. Raw records are deliberate:
 * the normalizers truncate tool results (`TOOL_RESULT_TEXT_LIMIT`) and drop
 * thinking text entirely (length only), which would silently blind a search.
 * Matching decoded values — rather than the raw JSON line — means a query
 * containing `"` or a newline needs no escaping, and JSON escaping inside the
 * log can never split an occurrence.
 */

import { isSyntheticUserText } from "./codex/analyze.js";
import { coerceOutputText } from "./codex/parser.js";

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
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

/** Join the `text` of an array-of-blocks (or pass a bare string through). */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : ""))
    .filter((t) => t !== "")
    .join("\n");
}

function push(out: SearchableField[], field: SearchFieldKind, text: string, toolName?: string) {
  if (text === "") return;
  out.push({ field, text, ...(toolName !== undefined && { toolName }) });
}

// ---------------------------------------------------------------------------
// Claude Code records
// ---------------------------------------------------------------------------

/**
 * Searchable fields of one raw Claude Code session record. Harness-injected
 * task notifications are skipped (background-task events, not user words);
 * `isMeta` and compact-summary user records are kept — their text (skill
 * content, command output, summaries) is exactly what a "which session
 * mentioned X" search wants to see.
 */
export function extractClaudeSearchFields(raw: unknown): SearchableField[] {
  if (!isObject(raw) || typeof raw.type !== "string") return [];
  const out: SearchableField[] = [];
  switch (raw.type) {
    case "user": {
      const message = isObject(raw.message) ? raw.message : {};
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block)) continue;
          if (block.type === "tool_result") {
            push(out, "tool_result", textOfContent(block.content));
          }
        }
      }
      const promptText = textOfContent(content);
      if (!promptText.includes("<task-notification>")) push(out, "user", promptText);
      break;
    }
    case "assistant": {
      const message = isObject(raw.message) ? raw.message : {};
      const content = message.content;
      if (!Array.isArray(content)) break;
      const texts: string[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        switch (block.type) {
          case "text": {
            const text = str(block.text);
            if (text !== undefined && text !== "") texts.push(text);
            break;
          }
          case "thinking":
            push(out, "thinking", str(block.thinking) ?? "");
            break;
          case "tool_use":
            push(out, "tool_input", flattenToSearchText(block.input), str(block.name));
            break;
          default:
            break;
        }
      }
      push(out, "assistant", texts.join("\n"));
      break;
    }
    case "summary":
      push(out, "title", str(raw.summary) ?? "");
      break;
    case "ai-title":
      push(out, "title", str(raw.aiTitle) ?? "");
      break;
    case "custom-title":
      push(out, "title", str(raw.customTitle) ?? str(raw.title) ?? "");
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex rollout records
// ---------------------------------------------------------------------------

/**
 * A `response_item` `message` text whose inclusion depends on file-level
 * knowledge the per-record extractor can't have: current-format rollouts
 * mirror every real prompt as an `event_msg` `user_message` (and assistant
 * text as `agent_message`), making the `response_item` form a duplicate.
 * The caller keeps a deferred field only when the WHOLE file turned out to
 * have no event of its `gate` kind — the same fallback rule
 * `codex/timeline.ts` applies to user prompts.
 */
export interface CodexDeferredSearchField extends SearchableField {
  gate: "userMessage" | "agentMessage";
}

export interface CodexSearchExtraction {
  fields: SearchableField[];
  deferredFields: CodexDeferredSearchField[];
  /** This record IS an `event_msg` `user_message` — callers OR this across the file. */
  sawUserMessageEvent: boolean;
  /** This record IS an `event_msg` `agent_message` — callers OR this across the file. */
  sawAgentMessageEvent: boolean;
}

const EMPTY_CODEX_EXTRACTION: CodexSearchExtraction = {
  fields: [],
  deferredFields: [],
  sawUserMessageEvent: false,
  sawAgentMessageEvent: false,
};

/** `.text` of each summary/content item of a reasoning payload (objects or bare strings). */
function reasoningTexts(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const texts: string[] = [];
  for (const item of items) {
    const text = typeof item === "string" ? item : isObject(item) ? str(item.text) : undefined;
    if (text !== undefined && text !== "") texts.push(text);
  }
  return texts;
}

/**
 * Searchable fields of one raw Codex rollout envelope (`{timestamp, type,
 * payload}`). Synthetic role-user response items (injected AGENTS.md /
 * environment context — `isSyntheticUserText`) are never searchable, matching
 * how the timeline and prompt extraction already treat them.
 */
export function extractCodexSearchFields(raw: unknown): CodexSearchExtraction {
  if (!isObject(raw) || typeof raw.type !== "string" || !isObject(raw.payload)) {
    return EMPTY_CODEX_EXTRACTION;
  }
  const payload = raw.payload;
  const fields: SearchableField[] = [];
  const deferredFields: CodexDeferredSearchField[] = [];
  let sawUserMessageEvent = false;
  let sawAgentMessageEvent = false;

  if (raw.type === "event_msg") {
    switch (payload.type) {
      case "user_message":
        sawUserMessageEvent = true;
        push(fields, "user", str(payload.message) ?? "");
        break;
      case "agent_message":
        sawAgentMessageEvent = true;
        push(fields, "assistant", str(payload.message) ?? "");
        break;
      case "thread_name_updated":
        push(fields, "title", str(payload.thread_name) ?? "");
        break;
      default:
        break;
    }
  } else if (raw.type === "response_item") {
    switch (payload.type) {
      case "message": {
        const text = Array.isArray(payload.content)
          ? payload.content
              .map((block) => (isObject(block) ? (str(block.text) ?? "") : ""))
              .filter((t) => t !== "")
              .join("\n")
          : "";
        if (text === "") break;
        if (payload.role === "user" && !isSyntheticUserText(text)) {
          deferredFields.push({ gate: "userMessage", field: "user", text });
        } else if (payload.role === "assistant") {
          deferredFields.push({ gate: "agentMessage", field: "assistant", text });
        }
        break;
      }
      case "reasoning": {
        const texts = [...reasoningTexts(payload.summary), ...reasoningTexts(payload.content)];
        push(fields, "thinking", texts.join("\n"));
        break;
      }
      case "function_call": {
        const args = str(payload.arguments);
        let text = args ?? "";
        if (args !== undefined) {
          try {
            text = flattenToSearchText(JSON.parse(args));
          } catch {
            // Not JSON — search the raw arguments string.
          }
        }
        push(fields, "tool_input", text, str(payload.name));
        break;
      }
      case "custom_tool_call":
        push(fields, "tool_input", str(payload.input) ?? "", str(payload.name));
        break;
      case "function_call_output":
        push(fields, "tool_result", coerceOutputText(payload.output));
        break;
      case "custom_tool_call_output":
        push(fields, "tool_result", coerceOutputText(payload.output), str(payload.name));
        break;
      case "local_shell_call":
        push(fields, "tool_input", flattenToSearchText(payload.action), "local_shell");
        break;
      case "web_search_call": {
        const action = isObject(payload.action) ? payload.action : {};
        const queries = [
          ...(str(action.query) !== undefined ? [str(action.query) as string] : []),
          ...(Array.isArray(action.queries)
            ? action.queries.filter((q): q is string => typeof q === "string")
            : []),
        ];
        push(fields, "tool_input", queries.join("\n"), "web_search");
        break;
      }
      default:
        break;
    }
  }

  if (
    fields.length === 0 &&
    deferredFields.length === 0 &&
    !sawUserMessageEvent &&
    !sawAgentMessageEvent
  ) {
    return EMPTY_CODEX_EXTRACTION;
  }
  return { fields, deferredFields, sawUserMessageEvent, sawAgentMessageEvent };
}
