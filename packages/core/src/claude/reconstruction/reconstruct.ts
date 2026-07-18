/**
 * Public reconstruction API — assembles a labelled `ReconstructedRequest` for
 * one main-loop `/v1/messages` turn from replayed messages (exact), an injected
 * per-CLI-version template (template), and injected current disk state
 * (disk-contingent), declaring everything it cannot recover (unknown). Every
 * value is either labelled with a confidence class + provenance or declared
 * absent — nothing is silently missing.
 *
 * SCOPE: main-loop requests only. Subagent (sidechain) requests are an
 * explicitly declared limitation, not a silent gap (see `limitations`).
 */

import { type ClaudeSessionStore, localClaudeSessionStore } from "../store.js";
import { renderAgentListingBlock, renderSkillListingBlock } from "./attachments.js";
import { deriveCurrentDate, renderClaudeMdContextBlock } from "./disk-context.js";
import {
  buildTurns,
  parseReconstructionRecords,
  type ReplayBlock,
  type ReplayTurn,
} from "./replay.js";
import {
  applyCacheControlStrip,
  applyCallerStrip,
  applyContentForm,
  RULE_CACHE_CONTROL_STRIP,
  RULE_CALLER_STRIP,
  RULE_CONTENT_FORM,
  RULE_QUEUE_OPERATION_SKIP,
  RULE_TASK_NOTIFICATION_PREAMBLE,
  RULE_THINKING_DROP,
} from "./rules.js";
import { substituteTemplateText } from "./template.js";
import type {
  DiskContext,
  Provenance,
  ReconAssistantRecord,
  ReconstructableRequestRef,
  ReconstructedMessage,
  ReconstructedMessageBlock,
  ReconstructedRequest,
  ReconstructedSection,
  ReconstructedSystemBlock,
  ReconstructionInput,
  ReconstructionProviders,
  ReconstructionRecord,
  ReconstructionSessionMeta,
  ReconstructionTemplate,
  ReconUserRecord,
} from "./types.js";

/** See `replay.ts` — `ReconOtherRecord.type: string` defeats discriminant narrowing. */
function isAssistantRecord(rec: ReconstructionRecord): rec is ReconAssistantRecord {
  return rec.type === "assistant";
}
/** A record that carries the shared cwd/version/timestamp envelope. */
function messageEnvelope(
  rec: ReconstructionRecord,
): ReconUserRecord | ReconAssistantRecord | undefined {
  return rec.type === "user" || rec.type === "assistant"
    ? (rec as ReconUserRecord | ReconAssistantRecord)
    : undefined;
}

const SUBAGENT_LIMITATION =
  "subagent (sidechain) requests are not supported: reconstruction covers main-loop requests only";
const BILLING_REASON =
  "per-launch billing-header system block (random build suffix) is not recoverable";

interface RequestGroup {
  requestId?: string;
  ordinal: number;
  targetLine: number;
  memberLines: number[];
}

/**
 * Group assistant records into requests, keyed by the log's own `requestId`
 * where present (the records of one multi-block response share it), falling
 * back to `messageId`, then to the record's own line ordinal. Any non-assistant
 * record ends the current group.
 */
function groupRequests(records: ReconstructionRecord[]): RequestGroup[] {
  const groups: RequestGroup[] = [];
  let current: RequestGroup | null = null;
  let currentKey: string | null = null;
  for (const rec of records) {
    if (!isAssistantRecord(rec)) {
      current = null;
      currentKey = null;
      continue;
    }
    const key = rec.requestId ?? rec.messageId ?? `line:${rec.line}`;
    if (current === null || key !== currentKey) {
      current = {
        ordinal: groups.length,
        targetLine: rec.line,
        memberLines: [rec.line],
        ...(rec.requestId !== undefined && { requestId: rec.requestId }),
      };
      groups.push(current);
      currentKey = key;
    } else {
      current.memberLines.push(rec.line);
    }
  }
  return groups;
}

/** List a session's reconstructable requests (requestId + target line + ordinal). */
export function listReconstructableRequests(
  records: ReconstructionRecord[],
): ReconstructableRequestRef[] {
  return groupRequests(records).map((g) => ({
    ordinal: g.ordinal,
    targetLine: g.targetLine,
    ...(g.requestId !== undefined && { requestId: g.requestId }),
  }));
}

function findGroup(groups: RequestGroup[], target: string | number): RequestGroup | undefined {
  if (typeof target === "string") return groups.find((g) => g.requestId === target);
  return groups.find((g) => g.memberLines.includes(target));
}

/** A unique-preserving string collector (declaration order, no duplicates). */
function uniquePush(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

interface MaterializeContext {
  diskContext: DiskContext | undefined;
  dateStr: string | undefined;
  sessionStartMs: number | undefined;
  appliedRules: Set<string>;
  limitations: string[];
}

/** Turn one replay block into a labelled reconstructed message block. */
function materializeBlock(block: ReplayBlock, ctx: MaterializeContext): ReconstructedMessageBlock {
  switch (block.source) {
    case "user-string": {
      const [value] = applyContentForm(block.text);
      ctx.appliedRules.add(RULE_CONTENT_FORM);
      const result: ReconstructedMessageBlock = {
        wireType: "text",
        value,
        confidence: "exact",
        provenance: { kind: "log", lines: [block.line] },
        appliedRules: [RULE_CONTENT_FORM],
      };
      if (block.isTaskNotification) {
        ctx.appliedRules.add(RULE_TASK_NOTIFICATION_PREAMBLE);
        result.appliedRules = [RULE_CONTENT_FORM, RULE_TASK_NOTIFICATION_PREAMBLE];
        result.note =
          "harness task-notification turn: the wire prepends a fixed safety preamble the log omits, so this turn is body-exact but missing that preamble";
        uniquePush(
          ctx.limitations,
          "task-notification turns carry a fixed harness safety preamble that the session log omits; reconstructed task-notification turns are body-exact but missing it",
        );
      }
      return result;
    }
    case "assistant-text":
      return {
        wireType: "text",
        value: { type: "text", text: block.text },
        confidence: "exact",
        provenance: { kind: "log", lines: [block.line] },
      };
    case "tool-use": {
      const callerStripped = applyCallerStrip(block.block);
      const cacheStripped = applyCacheControlStrip(callerStripped.block);
      const rules: string[] = [];
      if (callerStripped.applied) {
        rules.push(RULE_CALLER_STRIP);
        ctx.appliedRules.add(RULE_CALLER_STRIP);
      }
      if (cacheStripped.applied) {
        rules.push(RULE_CACHE_CONTROL_STRIP);
        ctx.appliedRules.add(RULE_CACHE_CONTROL_STRIP);
      }
      return {
        wireType: "tool_use",
        value: cacheStripped.block,
        confidence: "exact",
        provenance: { kind: "log", lines: [block.line] },
        ...(rules.length > 0 && { appliedRules: rules }),
      };
    }
    case "tool-result": {
      const cacheStripped = applyCacheControlStrip(block.block);
      if (cacheStripped.applied) ctx.appliedRules.add(RULE_CACHE_CONTROL_STRIP);
      return {
        wireType: "tool_result",
        value: cacheStripped.block,
        confidence: "exact",
        provenance: { kind: "log", lines: [block.line] },
        ...(cacheStripped.applied && { appliedRules: [RULE_CACHE_CONTROL_STRIP] }),
      };
    }
    case "assistant-other": {
      const cacheStripped = applyCacheControlStrip(block.block);
      if (cacheStripped.applied) ctx.appliedRules.add(RULE_CACHE_CONTROL_STRIP);
      return {
        wireType: block.wireType,
        value: cacheStripped.block,
        confidence: "exact",
        provenance: { kind: "log", lines: [block.line] },
        note: `unhandled wire block type '${block.wireType}' passed through verbatim from the log`,
      };
    }
    case "attachment-agent":
      return {
        wireType: "text",
        value: { type: "text", text: renderAgentListingBlock(block.addedLines) },
        confidence: "exact",
        provenance: { kind: "attachment", line: block.line },
      };
    case "attachment-skill":
      return {
        wireType: "text",
        value: { type: "text", text: renderSkillListingBlock(block.content) },
        confidence: "exact",
        provenance: { kind: "attachment", line: block.line },
      };
    case "disk-claude-md":
      return materializeDiskBlock(ctx);
  }
}

function materializeDiskBlock(ctx: MaterializeContext): ReconstructedMessageBlock {
  const declareUnknown = (reason: string): ReconstructedMessageBlock => {
    uniquePush(ctx.limitations, `${reason} (unknown)`);
    return {
      wireType: "text",
      confidence: "unknown",
      provenance: { kind: "declared-absent", reason },
      note: "the CLAUDE.md/memory/userEmail/currentDate reminder is disk-contingent and could not be rebuilt here",
    };
  };

  if (ctx.diskContext === undefined) {
    return declareUnknown("no disk-context provider: CLAUDE.md/memory/email reminder not rebuilt");
  }
  if (ctx.dateStr === undefined) {
    return declareUnknown(
      "no log timestamp to derive currentDate: CLAUDE.md/memory/email reminder not rebuilt",
    );
  }
  const rendered = renderClaudeMdContextBlock(ctx.diskContext, {
    dateStr: ctx.dateStr,
    ...(ctx.sessionStartMs !== undefined && { sessionStartMs: ctx.sessionStartMs }),
  });
  if (rendered === undefined) {
    return declareUnknown(
      "global CLAUDE.md or account email unavailable: CLAUDE.md/memory/email reminder not rebuilt",
    );
  }
  const provenance: Provenance = {
    kind: "disk",
    files: rendered.files,
    driftDetected: rendered.driftDetected,
  };
  return {
    wireType: "text",
    value: { type: "text", text: rendered.text },
    confidence: "disk-contingent",
    provenance,
    ...(rendered.driftDetected && {
      note: "a contributing file was modified after the session started; this reminder may have drifted from what the session saw",
    }),
  };
}

function materializeMessages(turns: ReplayTurn[], ctx: MaterializeContext): ReconstructedMessage[] {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.blocks.map((block) => materializeBlock(block, ctx)),
  }));
}

interface TemplateSections {
  system: ReconstructedSystemBlock[];
  tools: ReconstructedSection<unknown[]>;
  params: ReconstructedSection<Record<string, unknown>>;
}

function buildTemplateSections(
  template: ReconstructionTemplate | undefined,
  cliVersion: string | undefined,
  session: ReconstructionSessionMeta,
  limitations: string[],
): TemplateSections {
  if (template === undefined) {
    const reason =
      cliVersion !== undefined
        ? `no reconstruction template for CLI version ${cliVersion}`
        : "session CLI version is unknown; no reconstruction template selected";
    uniquePush(limitations, `${reason}: system prompt, tools, and generation params are unknown`);
    const provenance: Provenance = { kind: "declared-absent", reason };
    const note = "requires a per-CLI-version reconstruction template";
    return {
      system: [{ confidence: "unknown", provenance, note: `system prompt ${note}` }],
      tools: { confidence: "unknown", provenance, note: `tool schemas ${note}` },
      params: { confidence: "unknown", provenance, note: `generation params ${note}` },
    };
  }

  const target = {
    sessionId: session.sessionId,
    ...(session.cwd !== undefined && { cwd: session.cwd }),
    ...(session.substitutions !== undefined && { extra: session.substitutions }),
  };
  const system: ReconstructedSystemBlock[] = template.system.map((tplBlock) => {
    const { text, substituted, unsubstituted } = substituteTemplateText(
      tplBlock.text,
      template.capturedValues,
      target,
    );
    const provenance: Provenance = {
      kind: "template",
      cliVersion: template.cliVersion,
      ...(substituted.length > 0 && { substitutions: substituted }),
      ...(unsubstituted.length > 0 && { unsubstituted }),
    };
    return {
      text,
      confidence: "template",
      provenance,
      ...(unsubstituted.length > 0 && {
        note: `un-substituted run-specific values remain: ${unsubstituted.join(", ")}`,
      }),
    };
  });
  system.push({
    confidence: "unknown",
    provenance: { kind: "declared-absent", reason: BILLING_REASON },
    note: "per-launch billing-header block; not derivable",
  });
  uniquePush(limitations, `${BILLING_REASON} (unknown)`);

  const templateProvenance: Provenance = { kind: "template", cliVersion: template.cliVersion };
  const tools: ReconstructedSection<unknown[]> =
    template.tools !== undefined
      ? { value: template.tools, confidence: "template", provenance: templateProvenance }
      : {
          confidence: "unknown",
          provenance: {
            kind: "declared-absent",
            reason: `template for CLI version ${template.cliVersion} carries no tools array`,
          },
        };
  const params: ReconstructedSection<Record<string, unknown>> =
    template.params !== undefined
      ? { value: template.params, confidence: "template", provenance: templateProvenance }
      : {
          confidence: "unknown",
          provenance: {
            kind: "declared-absent",
            reason: `template for CLI version ${template.cliVersion} carries no params`,
          },
        };
  return { system, tools, params };
}

/**
 * Reconstruct one main-loop request, identified by the log's `requestId`
 * (string) or by a target assistant record's line (number). Returns `undefined`
 * when no such request exists in `input.records`.
 */
export async function reconstructRequest(
  input: ReconstructionInput,
  target: string | number,
  providers: ReconstructionProviders = {},
): Promise<ReconstructedRequest | undefined> {
  const groups = groupRequests(input.records);
  const group = findGroup(groups, target);
  if (group === undefined) return undefined;

  // The request that produced this response carried the history up to (not
  // including) the response's first record.
  const priorRecords = input.records.filter((r) => r.line < group.targetLine);
  const { turns, stats } = buildTurns(priorRecords);

  const targetRecord = input.records.find(
    (r): r is ReconAssistantRecord => isAssistantRecord(r) && r.line === group.targetLine,
  );
  const dateStr = deriveCurrentDate(targetRecord?.timestamp ?? input.session.firstTimestamp);

  const diskContext =
    providers.diskContext !== undefined
      ? await providers.diskContext.getDiskContext(input.session)
      : undefined;
  const startParsed =
    input.session.firstTimestamp !== undefined
      ? Date.parse(input.session.firstTimestamp)
      : Number.NaN;
  const sessionStartMs = Number.isNaN(startParsed) ? undefined : startParsed;

  const appliedRules = new Set<string>();
  const limitations: string[] = [];
  const ctx: MaterializeContext = {
    diskContext,
    dateStr,
    sessionStartMs,
    appliedRules,
    limitations,
  };
  const messages = materializeMessages(turns, ctx);

  if (stats.droppedThinking) {
    appliedRules.add(RULE_THINKING_DROP);
    uniquePush(
      limitations,
      "thinking blocks are dropped from replayed history per the thinking-drop rule",
    );
  }
  if (stats.skippedQueueOperations > 0) appliedRules.add(RULE_QUEUE_OPERATION_SKIP);
  if (messages.some((m) => m.content.length > 0)) appliedRules.add(RULE_CACHE_CONTROL_STRIP);

  const cliVersion = input.session.cliVersion;
  const template =
    providers.template !== undefined && cliVersion !== undefined
      ? await providers.template.getTemplate(cliVersion)
      : undefined;
  const { system, tools, params } = buildTemplateSections(
    template,
    cliVersion,
    input.session,
    limitations,
  );

  uniquePush(limitations, SUBAGENT_LIMITATION);

  return {
    ordinal: group.ordinal,
    targetLine: group.targetLine,
    ...(group.requestId !== undefined && { requestId: group.requestId }),
    system,
    tools,
    params,
    messages,
    appliedRules: [...appliedRules].sort(),
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Store-backed loading (thin I/O wrapper — all reads go through the store)
// ---------------------------------------------------------------------------

/** Derive session identity/timing from replay records (file order authoritative). */
export function deriveReconstructionSessionMeta(
  sessionId: string,
  records: ReconstructionRecord[],
  overrides: { substitutions?: Record<string, string> } = {},
): ReconstructionSessionMeta {
  let cwd: string | undefined;
  let cliVersion: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  for (const rec of records) {
    const env = messageEnvelope(rec);
    if (env === undefined) continue;
    if (cwd === undefined && env.cwd !== undefined) cwd = env.cwd;
    if (cliVersion === undefined && env.version !== undefined) cliVersion = env.version;
    if (env.timestamp !== undefined) {
      firstTimestamp ??= env.timestamp;
      lastTimestamp = env.timestamp;
    }
  }
  return {
    sessionId,
    ...(cwd !== undefined && { cwd }),
    ...(cliVersion !== undefined && { cliVersion }),
    ...(firstTimestamp !== undefined && { firstTimestamp }),
    ...(lastTimestamp !== undefined && { lastTimestamp }),
    ...(overrides.substitutions !== undefined && { substitutions: overrides.substitutions }),
  };
}

/**
 * Load a `ReconstructionInput` for a session transcript file through a
 * `ClaudeSessionStore` (local filesystem by default). All bytes come from the
 * store's `openLines`; this module never touches `node:fs` directly.
 */
export async function loadReconstructionInput(
  sessionId: string,
  filePath: string,
  store: ClaudeSessionStore = localClaudeSessionStore,
  overrides: { substitutions?: Record<string, string> } = {},
): Promise<ReconstructionInput> {
  const records = await parseReconstructionRecords(store.openLines(filePath));
  const session = deriveReconstructionSessionMeta(sessionId, records, overrides);
  return { records, session };
}
