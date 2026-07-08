import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseJsonlLine } from "./jsonl.js";
import type {
  ApiErrorRecord,
  AssistantContentBlock,
  AssistantRecord,
  CompactBoundaryRecord,
  OtherSystemRecord,
  ParseWarning,
  RecordBase,
  SessionRecord,
  SystemRecord,
  TokenUsage,
  ToolResultInfo,
  Transcript,
  UserRecord,
} from "./types.js";

const TOOL_RESULT_TEXT_LIMIT = 2000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Parse one session JSONL file into lenient typed records. */
export async function parseTranscriptFile(filePath: string): Promise<Transcript> {
  const records: SessionRecord[] = [];
  const warnings: ParseWarning[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let line = 0;
  for await (const text of rl) {
    line += 1;
    if (text.trim() === "") continue;
    const raw = parseJsonlLine(text);
    if (raw === null) {
      warnings.push({ line, reason: "malformed JSON" });
      continue;
    }
    if (!isObject(raw) || typeof raw.type !== "string") {
      warnings.push({ line, reason: "missing record type" });
      continue;
    }
    records.push(normalizeRecord(raw, line));
  }
  return { filePath, records, warnings };
}

function normalizeRecord(raw: Record<string, unknown>, line: number): SessionRecord {
  const type = raw.type as string;
  switch (type) {
    case "user":
      return normalizeUser(raw, line);
    case "assistant":
      return normalizeAssistant(raw, line);
    case "system":
      return normalizeSystem(raw, line);
    case "ai-title": {
      const title = str(raw.aiTitle);
      if (title !== undefined) return { line, type: "ai-title", title };
      return { line, type };
    }
    case "custom-title": {
      const title = str(raw.customTitle) ?? str(raw.title);
      if (title !== undefined) return { line, type: "custom-title", title };
      return { line, type };
    }
    default:
      return { line, type };
  }
}

function envelope(raw: Record<string, unknown>, line: number): RecordBase {
  const base: RecordBase = { line };
  const uuid = str(raw.uuid);
  if (uuid !== undefined) base.uuid = uuid;
  const parentUuid = raw.parentUuid;
  if (typeof parentUuid === "string" || parentUuid === null) base.parentUuid = parentUuid;
  const timestamp = str(raw.timestamp);
  if (timestamp !== undefined) base.timestamp = timestamp;
  const isSidechain = bool(raw.isSidechain);
  if (isSidechain !== undefined) base.isSidechain = isSidechain;
  const cwd = str(raw.cwd);
  if (cwd !== undefined) base.cwd = cwd;
  const version = str(raw.version);
  if (version !== undefined) base.version = version;
  const gitBranch = str(raw.gitBranch);
  if (gitBranch !== undefined) base.gitBranch = gitBranch;
  const agentId = str(raw.agentId);
  if (agentId !== undefined) base.agentId = agentId;
  return base;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : ""))
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

function normalizeUser(raw: Record<string, unknown>, line: number): UserRecord {
  const message = isObject(raw.message) ? raw.message : {};
  const content = message.content;
  const toolResults: ToolResultInfo[] = [];
  let hasToolResult = false;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      hasToolResult = true;
      const toolUseId = str(block.tool_use_id);
      if (toolUseId === undefined) continue;
      toolResults.push({
        toolUseId,
        // `is_error: null` is common and means success.
        isError: block.is_error === true,
        text: extractText(block.content).slice(0, TOOL_RESULT_TEXT_LIMIT),
      });
    }
  }

  const record: UserRecord = { ...envelope(raw, line), type: "user", toolResults };
  if (bool(raw.isMeta) === true) record.isMeta = true;
  if (bool(raw.isCompactSummary) === true) record.isCompactSummary = true;
  if (!hasToolResult) {
    const text = extractText(content);
    if (text !== "") record.promptText = text;
  }
  return record;
}

function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const usage: TokenUsage = {
    inputTokens: num(raw.input_tokens) ?? 0,
    outputTokens: num(raw.output_tokens) ?? 0,
    cacheReadTokens: num(raw.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: num(raw.cache_creation_input_tokens) ?? 0,
  };
  const breakdown = raw.cache_creation;
  if (isObject(breakdown)) {
    const m5 = num(breakdown.ephemeral_5m_input_tokens);
    const h1 = num(breakdown.ephemeral_1h_input_tokens);
    if (m5 !== undefined) usage.cacheCreation5mTokens = m5;
    if (h1 !== undefined) usage.cacheCreation1hTokens = h1;
  }
  return usage;
}

function normalizeAssistant(raw: Record<string, unknown>, line: number): AssistantRecord {
  const message = isObject(raw.message) ? raw.message : {};
  const blocks: AssistantContentBlock[] = [];
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      switch (block.type) {
        case "text": {
          const text = str(block.text);
          if (text !== undefined) blocks.push({ kind: "text", text });
          break;
        }
        case "thinking": {
          const thinking = str(block.thinking);
          blocks.push({ kind: "thinking", length: thinking?.length ?? 0 });
          break;
        }
        case "tool_use": {
          const toolUseId = str(block.id);
          const name = str(block.name);
          if (toolUseId !== undefined && name !== undefined) {
            blocks.push({ kind: "tool_use", toolUseId, name, input: block.input });
          }
          break;
        }
        default:
          break;
      }
    }
  }
  const usage = normalizeUsage(message.usage);
  const record: AssistantRecord = { ...envelope(raw, line), type: "assistant", blocks };
  const requestId = str(raw.requestId);
  if (requestId !== undefined) record.requestId = requestId;
  const messageId = str(message.id);
  if (messageId !== undefined) record.messageId = messageId;
  const model = str(message.model);
  if (model !== undefined) record.model = model;
  if (usage !== undefined) record.usage = usage;
  return record;
}

function normalizeSystem(raw: Record<string, unknown>, line: number): SystemRecord {
  const subtype = str(raw.subtype);
  if (subtype === "compact_boundary") {
    const meta = isObject(raw.compactMetadata) ? raw.compactMetadata : {};
    const record: CompactBoundaryRecord = {
      ...envelope(raw, line),
      type: "system",
      subtype: "compact_boundary",
    };
    const trigger = str(meta.trigger);
    if (trigger !== undefined) record.trigger = trigger;
    const preTokens = num(meta.preTokens);
    if (preTokens !== undefined) record.preTokens = preTokens;
    const postTokens = num(meta.postTokens);
    if (postTokens !== undefined) record.postTokens = postTokens;
    return record;
  }
  if (subtype === "api_error") {
    const record: ApiErrorRecord = { ...envelope(raw, line), type: "system", subtype: "api_error" };
    const retryAttempt = num(raw.retryAttempt);
    if (retryAttempt !== undefined) record.retryAttempt = retryAttempt;
    return record;
  }
  const record: OtherSystemRecord = { ...envelope(raw, line), type: "system" };
  if (subtype !== undefined) record.subtype = subtype;
  return record;
}
