/**
 * "Virtual wire" reconstruction layer — Goshuin milestone, Phase C (see
 * docs/milestones/goshuin.md, "C. Reconstruction layer" and Decisions 1–4).
 *
 * Reconstructs the per-request Anthropic `/v1/messages` payload (system blocks,
 * tools, generation params, and the wire-shaped `messages` array) for a Claude
 * Code MAIN-LOOP request, purely from the session JSONL + its attachment
 * records + a user-local per-CLI-version template + current disk state. Every
 * reconstructed part carries an explicit CONFIDENCE CLASS so a consuming agent
 * can tell a reproduced value apart from a labelled guess — nothing is ever
 * silently missing.
 *
 * This vocabulary is intentionally SEPARATE from `shared/completeness.ts`
 * (Phase B's `sourceCompleteness`): that answers "what can this source
 * represent at all?"; this answers "how was THIS reconstructed block derived?".
 */

/**
 * How a reconstructed block/section was derived:
 *  - `exact` — from the session data alone (a replayed message block, or an
 *    injection rebuilt byte-for-byte from an attachment record + fixed wrapper).
 *  - `template` — from a per-CLI-version captured template plus log-recorded
 *    substitutions (system prompt, tools, generation params).
 *  - `disk-contingent` — rebuilt from CURRENT disk state (CLAUDE.md, memory,
 *    account email); may have drifted since the session ran (see `driftDetected`).
 *  - `unknown` — not recoverable from any available input (the per-launch
 *    billing-header system block, a missing template, an unaudited fragment).
 */
export type ConfidenceClass = "exact" | "template" | "disk-contingent" | "unknown";

/** Which local file a disk-contingent fragment was rebuilt from. */
export interface DiskFileProvenance {
  role: "global-claude-md" | "project-claude-md" | "memory" | "email";
  /** Absolute path the content came from (omitted for the account-email fragment). */
  path?: string;
  present: boolean;
  /** File mtime (epoch ms), when known. */
  mtimeMs?: number;
  /** True when this file's mtime is after the session start ⇒ it may have drifted. */
  driftDetected?: boolean;
}

/** Where a reconstructed value came from — a labelled, machine-readable trail. */
export type Provenance =
  | { kind: "log"; lines: number[] }
  | { kind: "attachment"; line: number }
  | { kind: "disk"; files: DiskFileProvenance[]; driftDetected: boolean }
  | { kind: "template"; cliVersion: string; substitutions?: string[]; unsubstituted?: string[] }
  | { kind: "declared-absent"; reason: string };

/** One top-level `system` block of the reconstructed request. */
export interface ReconstructedSystemBlock {
  /** The block's text; ABSENT (undefined) for a declared-unknown block. */
  text?: string;
  confidence: ConfidenceClass;
  provenance: Provenance;
  note?: string;
}

/** One content block of a reconstructed wire message. */
export interface ReconstructedMessageBlock {
  /** Wire block kind: `"text" | "tool_use" | "tool_result"` (or a passed-through other type). */
  wireType: string;
  /**
   * The reconstructed wire-shaped block object — concatenating a message's
   * `content[].value` yields the payload's `messages[i].content`. ABSENT
   * (undefined) only for a declared-unknown block.
   */
  value?: unknown;
  confidence: ConfidenceClass;
  provenance: Provenance;
  note?: string;
  /** Normalization rule ids (see `rules.ts`) that shaped this block. */
  appliedRules?: string[];
}

export interface ReconstructedMessage {
  role: "user" | "assistant";
  content: ReconstructedMessageBlock[];
}

/** A whole request section (today just `tools`) that is present-or-declared-absent. */
export interface ReconstructedSection<T> {
  /** Present when a template supplied this section. */
  value?: T;
  confidence: ConfidenceClass;
  provenance: Provenance;
  note?: string;
}

/**
 * One reconstructed generation-param entry (`model`, `max_tokens`, ...) with
 * its OWN confidence + provenance — so a value the LOG records deterministically
 * can override the template's captured default for that single key while every
 * other key stays `template`.
 */
export interface ReconstructedParamEntry {
  /** The reconstructed value; ABSENT (undefined) for a declared-unknown entry. */
  value?: unknown;
  confidence: ConfidenceClass;
  provenance: Provenance;
  note?: string;
}

/**
 * The reconstructed generation params as a PER-KEY confidence-labelled map,
 * NOT a single template-confidence section. `entries` is keyed by wire param
 * name (`model`, `max_tokens`, `thinking`, `context_management`, `stream`,
 * ...); each key carries its own confidence + provenance. Today `model` is
 * overlaid from the target assistant record's own `model` field (confidence
 * `exact`, provenance the log line) and OVERRIDES the template's captured
 * default — so a session that ran on a different model than the template
 * capture reports its real model, not a stale default; every other key stays
 * `template`. EXCEPTION: when the template default is a model ALIAS (e.g.
 * `claude-haiku-4-5`) and the log value is exactly that alias's resolved form
 * (`<alias>-<8-digit-date>`, e.g. `claude-haiku-4-5-20251001`), the wire
 * literal really was the alias — the template entry is kept (confidence
 * `template`) with a log-consistency note instead of being overridden. The
 * section-level `confidence`/`provenance`/`note` describe the
 * WHOLE section only in the "no template params" case (mirroring an unknown
 * `ReconstructedSection`): non-model params are unrecoverable without a
 * template even though a log-derived `model` may still be present. When a
 * template supplied params, the section-level fields are omitted and every key
 * is described by its own entry.
 */
export interface ReconstructedParams {
  entries: Record<string, ReconstructedParamEntry>;
  confidence?: ConfidenceClass;
  provenance?: Provenance;
  note?: string;
}

/** The reconstructed `/v1/messages` request for one main-loop turn. */
export interface ReconstructedRequest {
  /** The log's own `requestId` for this request, when the assistant records carry it. */
  requestId?: string;
  /** 0-based position among the session's reconstructable requests (fallback identity). */
  ordinal: number;
  /** 1-based line of the target assistant record this request produced (provenance). */
  targetLine: number;
  system: ReconstructedSystemBlock[];
  tools: ReconstructedSection<unknown[]>;
  params: ReconstructedParams;
  messages: ReconstructedMessage[];
  /** Union of normalization rule ids that shaped this reconstruction. */
  appliedRules: string[];
  /** Explicit declared gaps — things this reconstruction cannot or does not recover. */
  limitations: string[];
}

/** Lightweight listing of a session's reconstructable requests. */
export interface ReconstructableRequestRef {
  requestId?: string;
  ordinal: number;
  targetLine: number;
}

// ---------------------------------------------------------------------------
// Raw replay records (byte-preserving) — deliberately NOT the analytics
// `ClaudeSessionRecord` model, which truncates tool-result text and drops
// attachment injection content. Reconstruction needs the raw bytes.
// ---------------------------------------------------------------------------

/** A raw wire content block, preserved verbatim from the log. */
export interface ReconContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface ReconUserRecord {
  type: "user";
  line: number;
  timestamp?: string;
  cwd?: string;
  version?: string;
  isMeta?: boolean;
  /** Raw `message.content` — a bare string, or the block array, preserved. */
  content: string | ReconContentBlock[];
}

export interface ReconAssistantRecord {
  type: "assistant";
  line: number;
  timestamp?: string;
  cwd?: string;
  version?: string;
  requestId?: string;
  messageId?: string;
  /**
   * The record's own `message.model` — the model the request ACTUALLY ran on,
   * as the log records it per turn. Overlaid over the template's captured
   * default in the reconstructed `params.entries.model` (confidence `exact`),
   * so a session that ran on a different model than the template capture is
   * never misreported. Absent only when the log line carries no `model`.
   */
  model?: string;
  /** Raw `message.content` blocks, preserved (including thinking/caller). */
  blocks: ReconContentBlock[];
}

/** An attachment record carrying an agent-listing or skill-listing injection. */
export interface ReconAttachmentRecord {
  type: "attachment";
  line: number;
  attachment: { type?: string; addedLines?: string[]; content?: string };
}

/** Any other record (queue-operation, last-prompt, system, titles, ...). */
export interface ReconOtherRecord {
  type: string;
  line: number;
}

export type ReconstructionRecord =
  | ReconUserRecord
  | ReconAssistantRecord
  | ReconAttachmentRecord
  | ReconOtherRecord;

/** Session identity + timing, sourced from the session log itself. */
export interface ReconstructionSessionMeta {
  sessionId: string;
  cwd?: string;
  /** Claude Code CLI version (records' `version` field) — selects the template. */
  cliVersion?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  /**
   * Caller-supplied target values for run-specific template substitutions
   * beyond `cwd`/`sessionId` (e.g. a scratchpad dir), keyed the same as the
   * template's `capturedValues.extra`. Keys not provided here remain
   * un-substituted and are declared in the block's provenance.
   */
  substitutions?: Record<string, string>;
}

export interface ReconstructionInput {
  records: ReconstructionRecord[];
  session: ReconstructionSessionMeta;
}

// ---------------------------------------------------------------------------
// Template library (Decision 4) — USER-LOCAL artifacts, never shipped in-repo.
// ---------------------------------------------------------------------------

export interface ReconstructionTemplateSystemBlock {
  /**
   * The system block text as captured, still containing the run-specific
   * literals recorded in `capturedValues`; those are substituted at
   * reconstruction time with the target session's own values.
   */
  text: string;
}

/**
 * A per-CLI-version capture of the non-log-derived request parts. These are
 * Anthropic-authored text and are NEVER redistributed in the junrei repo — a
 * user captures and stores them locally under
 * `~/.junrei/templates/<cli-version>/template.json` (the documented on-disk
 * layout a later filesystem provider reads); the repo commits only this shape,
 * the pure `parseReconstructionTemplate` validator, and synthetic fixtures.
 */
export interface ReconstructionTemplate {
  cliVersion: string;
  capturedValues: {
    /** The `cwd` literal present in the captured system prompt. */
    cwd: string;
    /** The `sessionId` literal present in the captured system prompt. */
    sessionId: string;
    /** Other run-specific literals (e.g. scratchpad dir) keyed by a stable name. */
    extra?: Record<string, string>;
  };
  /** Ordered system blocks (identity block, instruction block, ...). */
  system: ReconstructionTemplateSystemBlock[];
  /** The `tools` array, verbatim. */
  tools?: unknown[];
  /** Generation params (`max_tokens`, `thinking`, `stream`, ...). */
  params?: Record<string, unknown>;
}

/** Injected source of per-CLI-version templates. A missing template ⇒ `unknown`. */
export interface ReconstructionTemplateProvider {
  getTemplate(cliVersion: string): Promise<ReconstructionTemplate | undefined>;
}

// ---------------------------------------------------------------------------
// Disk-contingent context (Decision 3) — CLAUDE.md / memory / email block.
// ---------------------------------------------------------------------------

export interface DiskContextFile {
  /** Absolute path the content was read from (rendered into the block verbatim). */
  path: string;
  content: string;
  /** File mtime (epoch ms) — compared to session start to flag possible drift. */
  mtimeMs?: number;
}

/** Current disk state needed to rebuild the CLAUDE.md/memory/email reminder block. */
export interface DiskContext {
  /** `~/.claude/CLAUDE.md` — required; without it the block is unrecoverable. */
  globalClaudeMd?: DiskContextFile;
  /** The project's `CLAUDE.md`, when one exists. */
  projectClaudeMd?: DiskContextFile;
  /** The auto-memory `MEMORY.md`, when one exists. */
  memoryMd?: DiskContextFile;
  /** `~/.claude.json` → `oauthAccount.emailAddress` — required for the block. */
  email?: string;
  /** mtime of the file the email was read from, for drift detection. */
  emailMtimeMs?: number;
}

/** Injected source of current disk state. Missing provider/files ⇒ `unknown`. */
export interface DiskContextProvider {
  getDiskContext(session: ReconstructionSessionMeta): Promise<DiskContext | undefined>;
}

export interface ReconstructionProviders {
  template?: ReconstructionTemplateProvider;
  diskContext?: DiskContextProvider;
}
