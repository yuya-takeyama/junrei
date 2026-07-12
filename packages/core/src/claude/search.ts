/**
 * Searchable-text extraction for Claude Code session records — see
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

/** Join the `text` of an array-of-blocks (or pass a bare string through). */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : ""))
    .filter((t) => t !== "")
    .join("\n");
}

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
