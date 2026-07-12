/**
 * Searchable-text extraction for Codex rollout records — see
 * `../shared/search.ts` for the cross-harness field vocabulary and the
 * generic flattening helper this reuses.
 */

import {
  flattenToSearchText,
  isObject,
  push,
  type SearchableField,
  str,
} from "../shared/search.js";
import { isSyntheticUserText } from "./analyze.js";
import { coerceOutputText } from "./parser.js";

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
