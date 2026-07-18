/**
 * Record replay — turns the raw session JSONL into the ordered, wire-shaped
 * turn list the reconstruction materializes into `messages`. A faithful port of
 * the calibrated reconstruction script's `buildTurns`, operating on a
 * byte-preserving raw record model (NOT the analytics parser, which truncates
 * tool-result text and drops attachment injection content).
 *
 * Structural replay rules applied here (see `rules.ts` for ids + measured
 * basis): `thinking-drop` (thinking blocks are never re-sent),
 * `queue-operation-skip` (queued-while-busy bookkeeping records carry no wire
 * message — the queued item is delivered later as its own user turn), and
 * tool_result merge-grouping (consecutive results sharing one owner assistant
 * message form a single user turn, matching how the harness batches them).
 */

import { parseJsonlLine } from "../../shared/jsonl.js";
import type {
  ReconAssistantRecord,
  ReconAttachmentRecord,
  ReconContentBlock,
  ReconstructionRecord,
  ReconUserRecord,
} from "./types.js";

/**
 * `ReconOtherRecord.type` is `string`, so it stays in the union under a plain
 * `rec.type === "user"` check and defeats discriminant narrowing — these
 * predicates recover the specific record type (sound: `normalizeRecord` only
 * ever emits a `"user"`/`"assistant"` record as the typed shape).
 */
function isUserRecord(rec: ReconstructionRecord): rec is ReconUserRecord {
  return rec.type === "user";
}
function isAssistantRecord(rec: ReconstructionRecord): rec is ReconAssistantRecord {
  return rec.type === "assistant";
}
function isAttachmentRecord(rec: ReconstructionRecord): rec is ReconAttachmentRecord {
  return rec.type === "attachment";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

/** Keep only the objects that have a string `type` — a raw content block array. */
function asContentBlocks(value: unknown): ReconContentBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: ReconContentBlock[] = [];
  for (const item of value) {
    if (isObject(item) && typeof item.type === "string") {
      blocks.push(item as ReconContentBlock);
    }
  }
  return blocks;
}

function normalizeRecord(
  raw: Record<string, unknown>,
  line: number,
): ReconstructionRecord | undefined {
  const type = asString(raw.type);
  if (type === undefined) return undefined;

  // Main-loop only: sidechain (subagent) records live in separate sidecar files
  // and are explicitly out of scope for reconstruction (see `reconstruct.ts`).
  if (raw.isSidechain === true) return undefined;

  const timestamp = asString(raw.timestamp);
  const cwd = asString(raw.cwd);
  const version = asString(raw.version);

  if (type === "user") {
    const message = isObject(raw.message) ? raw.message : {};
    const rawContent = message.content;
    const content: string | ReconContentBlock[] =
      typeof rawContent === "string" ? rawContent : asContentBlocks(rawContent);
    const record: ReconUserRecord = { type: "user", line, content };
    if (timestamp !== undefined) record.timestamp = timestamp;
    if (cwd !== undefined) record.cwd = cwd;
    if (version !== undefined) record.version = version;
    if (raw.isMeta === true) record.isMeta = true;
    return record;
  }

  if (type === "assistant") {
    const message = isObject(raw.message) ? raw.message : {};
    const record: ReconAssistantRecord = {
      type: "assistant",
      line,
      blocks: asContentBlocks(message.content),
    };
    if (timestamp !== undefined) record.timestamp = timestamp;
    if (cwd !== undefined) record.cwd = cwd;
    if (version !== undefined) record.version = version;
    const requestId = asString(raw.requestId);
    if (requestId !== undefined) record.requestId = requestId;
    const messageId = asString(message.id);
    if (messageId !== undefined) record.messageId = messageId;
    // The model the request ACTUALLY ran on, recorded per assistant turn — the
    // recon parser reads the raw line directly, so `message.model` is available
    // here without the drill-down raw-line recovery other paths need.
    const model = asString(message.model);
    if (model !== undefined) record.model = model;
    return record;
  }

  if (type === "attachment") {
    const attachment = isObject(raw.attachment) ? raw.attachment : {};
    const record: ReconAttachmentRecord = { type: "attachment", line, attachment: {} };
    const attType = asString(attachment.type);
    if (attType !== undefined) record.attachment.type = attType;
    const addedLines = asStringArray(attachment.addedLines);
    if (addedLines !== undefined) record.attachment.addedLines = addedLines;
    const content = asString(attachment.content);
    if (content !== undefined) record.attachment.content = content;
    return record;
  }

  return { type, line };
}

/** Parse raw JSONL lines into byte-preserving reconstruction records (1-based lines). */
export async function parseReconstructionRecords(
  lines: AsyncIterable<string>,
): Promise<ReconstructionRecord[]> {
  const records: ReconstructionRecord[] = [];
  let line = 0;
  for await (const text of lines) {
    line += 1;
    if (text.trim() === "") continue;
    const raw = parseJsonlLine(text);
    if (!isObject(raw)) continue;
    const record = normalizeRecord(raw, line);
    if (record !== undefined) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// buildTurns
// ---------------------------------------------------------------------------

export type ReplayBlock =
  | { source: "user-string"; text: string; line: number; isTaskNotification: boolean }
  | { source: "user-block"; block: ReconContentBlock; line: number }
  | { source: "assistant-text"; text: string; line: number }
  | { source: "tool-use"; block: ReconContentBlock; line: number }
  | { source: "tool-result"; block: ReconContentBlock; line: number }
  | { source: "assistant-other"; wireType: string; block: ReconContentBlock; line: number }
  | { source: "attachment-agent"; addedLines: string[]; line: number }
  | { source: "attachment-skill"; content: string; line: number }
  | { source: "disk-claude-md" };

export interface ReplayTurn {
  role: "user" | "assistant";
  blocks: ReplayBlock[];
}

export interface ReplayStats {
  /** A `thinking` block was dropped from at least one replayed assistant turn. */
  droppedThinking: boolean;
  /** Count of `queue-operation` records skipped (carry no wire message). */
  skippedQueueOperations: number;
  /** Count of user turns whose content is a harness `<task-notification>`. */
  taskNotificationTurns: number;
}

export interface ReplayResult {
  turns: ReplayTurn[];
  stats: ReplayStats;
}

type PendingReminder =
  | { kind: "agent"; addedLines: string[]; line: number }
  | { kind: "skill"; content: string; line: number };

/** Extract the agent/skill reminder an attachment record carries, if any. */
function reminderFromAttachment(record: ReconAttachmentRecord): PendingReminder | undefined {
  const att = record.attachment;
  if (att.type === "agent_listing_delta" && att.addedLines !== undefined) {
    return { kind: "agent", addedLines: att.addedLines, line: record.line };
  }
  if (att.type === "skill_listing" && att.content !== undefined) {
    return { kind: "skill", content: att.content, line: record.line };
  }
  return undefined;
}

/**
 * Replay records into ordered wire-shaped turns. Attachment-injected reminders
 * (agent/skill listings) are buffered and prepended to the user turn they
 * follow, together with the disk-contingent CLAUDE.md/memory/email reminder
 * that always accompanies them but has NO attachment record of its own.
 */
export function buildTurns(records: ReconstructionRecord[]): ReplayResult {
  const turns: ReplayTurn[] = [];
  const assistantTurnIndexByMsgId = new Map<string | undefined, number>();
  const toolUseIdToOwnerMsgId = new Map<string, string | undefined>();
  let openToolResultTurn: { ownerMsgId: string | undefined; turnIndex: number } | null = null;
  let pendingReminders: PendingReminder[] = [];
  let lastUserTurnIndex: number | null = null;
  const stats: ReplayStats = {
    droppedThinking: false,
    skippedQueueOperations: 0,
    taskNotificationTurns: 0,
  };

  function flushPendingReminders(): void {
    if (pendingReminders.length === 0) return;
    if (lastUserTurnIndex === null) {
      pendingReminders = [];
      return;
    }
    const turn = turns[lastUserTurnIndex];
    if (turn === undefined) {
      pendingReminders = [];
      return;
    }
    const reminderBlocks: ReplayBlock[] = pendingReminders.map((r) =>
      r.kind === "agent"
        ? { source: "attachment-agent", addedLines: r.addedLines, line: r.line }
        : { source: "attachment-skill", content: r.content, line: r.line },
    );
    if (reminderBlocks.length > 0) {
      // The CLAUDE.md/memory/userEmail/currentDate reminder always accompanies
      // the agent+skill listing reminders as the trailing block, but it has NO
      // attachment record of its own anywhere in the session log.
      reminderBlocks.push({ source: "disk-claude-md" });
      turn.blocks = [...reminderBlocks, ...turn.blocks];
    }
    pendingReminders = [];
  }

  for (const rec of records) {
    if (isAttachmentRecord(rec)) {
      const reminder = reminderFromAttachment(rec);
      if (reminder !== undefined) pendingReminders.push(reminder);
      continue;
    }
    if (rec.type === "queue-operation") {
      stats.skippedQueueOperations += 1;
      continue;
    }

    if (isUserRecord(rec)) {
      flushPendingReminders();
      const content = rec.content;
      if (typeof content === "string") {
        const isTaskNotification = content.includes("<task-notification>");
        if (isTaskNotification) stats.taskNotificationTurns += 1;
        const turnIndex = turns.length;
        turns.push({
          role: "user",
          blocks: [{ source: "user-string", text: content, line: rec.line, isTaskNotification }],
        });
        lastUserTurnIndex = turnIndex;
        openToolResultTurn = null;
        continue;
      }
      // A user record's block-array content is EITHER a loop-continuation
      // (top-level `tool_result` blocks ONLY, grouped below by owner
      // assistant message) OR a user turn sent as blocks that carries at
      // least one non-`tool_result` block — a genuine prompt (text/image/...,
      // no `tool_result` at all) or a MIXED array (a `tool_result` alongside
      // other blocks; unobserved in real logs so far, but the wire would send
      // it verbatim just the same). Either way it must become ONE user turn
      // holding every block in record order — the pre-fix code only ever
      // handled the string and pure-tool_result forms, so an array-form first
      // prompt produced NO turn at all, and a mixed array would have silently
      // dropped its non-tool_result blocks.
      if (content.length === 0) continue;
      const allToolResults = content.every((block) => block.type === "tool_result");
      if (!allToolResults) {
        const turnIndex = turns.length;
        turns.push({
          role: "user",
          blocks: content.map(
            (block): ReplayBlock =>
              block.type === "tool_result"
                ? { source: "tool-result", block, line: rec.line }
                : { source: "user-block", block, line: rec.line },
          ),
        });
        lastUserTurnIndex = turnIndex;
        openToolResultTurn = null;
        continue;
      }
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const toolUseId = asString(block.tool_use_id);
        const ownerMsgId =
          toolUseId !== undefined ? toolUseIdToOwnerMsgId.get(toolUseId) : undefined;
        const wireBlock: ReplayBlock = { source: "tool-result", block, line: rec.line };
        if (
          openToolResultTurn !== null &&
          openToolResultTurn.ownerMsgId === ownerMsgId &&
          ownerMsgId !== undefined
        ) {
          turns[openToolResultTurn.turnIndex]?.blocks.push(wireBlock);
        } else {
          const turnIndex = turns.length;
          turns.push({ role: "user", blocks: [wireBlock] });
          openToolResultTurn = { ownerMsgId, turnIndex };
          lastUserTurnIndex = turnIndex;
        }
      }
      continue;
    }

    if (!isAssistantRecord(rec)) {
      // last-prompt / system / titles / other bookkeeping — no wire message.
      continue;
    }

    const msgid = rec.messageId;
    const nonThinking = rec.blocks.filter((b) => b.type !== "thinking");
    if (nonThinking.length !== rec.blocks.length) stats.droppedThinking = true;
    for (const b of nonThinking) {
      if (b.type === "tool_use") {
        const id = asString(b.id);
        if (id !== undefined) toolUseIdToOwnerMsgId.set(id, msgid);
      }
    }
    const wireBlocks: ReplayBlock[] = nonThinking.map((b) => {
      if (b.type === "text")
        return { source: "assistant-text", text: asString(b.text) ?? "", line: rec.line };
      if (b.type === "tool_use") return { source: "tool-use", block: b, line: rec.line };
      return { source: "assistant-other", wireType: b.type, block: b, line: rec.line };
    });
    const existing = assistantTurnIndexByMsgId.get(msgid);
    if (existing !== undefined) {
      turns[existing]?.blocks.push(...wireBlocks);
    } else {
      const turnIndex = turns.length;
      turns.push({ role: "assistant", blocks: wireBlocks });
      assistantTurnIndexByMsgId.set(msgid, turnIndex);
      openToolResultTurn = null;
    }
  }

  flushPendingReminders();
  return { turns, stats };
}
