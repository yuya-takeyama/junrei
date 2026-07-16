/**
 * Transcript substring search across both harnesses — the engine behind the
 * `search_sessions` MCP tool.
 *
 * Candidates come from the same `listSessions` feed every other surface uses
 * (so filters like `repo` resolve identically to `get_repo_overview`, and
 * result metadata needs no extra reads), then each candidate's JSONL file is
 * re-scanned streaming, line by line, matching the query against DECODED
 * string values via `@junrei/core`'s search-field extractors — never against
 * raw JSON, so JSON escaping can't split a match. Output is deliberately
 * compact: capped snippet lists with exact `matchCount`s and explicit
 * truncation flags (a capped list must never read as complete).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  type ClaudeSessionFileRef,
  type ClaudeSessionStore,
  type CodexSessionFileRef,
  extractClaudeSearchFields,
  extractCodexSearchFields,
  listSubagentRefs,
  parseJsonlLine,
  type SearchableField,
  type SearchFieldKind,
  type SessionSource,
} from "@junrei/core";
import { repoKeyOf } from "./overview.js";
import {
  type AnySessionListItem,
  listSessions,
  MAX_LIST_LIMIT,
  type SessionSourceFilter,
} from "./sessions.js";
import { claudeStoreForFilePath, listAllClaudeRefs } from "./sources/claude.js";
import { listCodexRefs } from "./sources/codex.js";

export interface SearchParams {
  query: string;
  source?: SessionSourceFilter | undefined;
  /** Claude only: restrict to one munged project dir. */
  project?: string | undefined;
  /** repoRoot path or fallback bucket key — same semantics as get_repo_overview. */
  repo?: string | undefined;
  /** Restrict to one session. */
  sessionId?: string | undefined;
  fields?: SearchFieldKind[] | undefined;
  caseSensitive?: boolean | undefined;
  /** ISO 8601 — only sessions last active at/after this time (file mtime). */
  since?: string | undefined;
  /** ISO 8601 — only sessions last active at/before this time (file mtime). */
  until?: string | undefined;
  scanLimit?: number | undefined;
  maxSessions?: number | undefined;
  maxMatchesPerSession?: number | undefined;
  includeSubagents?: boolean | undefined;
}

export interface SearchMatch {
  /** 1-based JSONL line number in the transcript the match was found in. */
  line: number;
  field: SearchFieldKind;
  toolName?: string;
  timestamp?: string;
  /**
   * Set when the match is in a subagent transcript rather than the session's
   * main one: a Claude sidecar's agentId, or a Codex sub-agent thread's own
   * sessionId (which `line` then refers into).
   */
  agentId?: string;
  /** Occurrences within this record across all searched fields (1 record = 1 match). */
  occurrences: number;
  snippet: string;
}

export interface SearchSessionResult {
  source: SessionSource;
  sessionId: string;
  /**
   * Claude only, informational — the munged project dir this session lives
   * under. No longer needed by the other session-scoped tools (they resolve
   * by `sessionId` alone now — see `ClaudeSessionKey`'s doc comment in
   * `sources/claude.ts`), but still useful for the `search_sessions`
   * `project` filter and for display.
   */
  project?: string;
  repoRoot?: string;
  worktreeName?: string;
  title?: string;
  /** Truncated to ~80 chars — a preview, not the full prompt. */
  firstUserPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  /** Exact matched-record count for the whole session (main + searched subagents). */
  matchCount: number;
  matches: SearchMatch[];
  /** True when matchCount exceeds the returned matches. */
  matchesTruncated: boolean;
}

export interface SearchResponse {
  query: string;
  caseSensitive: boolean;
  /** The field set actually searched (echoes the default when omitted). */
  fields: SearchFieldKind[];
  scanned: {
    /** Sessions whose transcripts were actually scanned (≤ scanLimit; stops early at maxSessions). */
    sessions: number;
    /** Candidate transcripts (or subagent sidecars) that could not be read. */
    skippedUnreadable: number;
  };
  /** Matched sessions, newest first (same recency order as list_sessions). */
  results: SearchSessionResult[];
  /** True when more matches may exist: stopped at maxSessions, or scanLimit clipped the candidates. */
  resultsTruncated: boolean;
}

export const DEFAULT_SEARCH_FIELDS: readonly SearchFieldKind[] = [
  "user",
  "assistant",
  "tool_input",
  "tool_result",
  "title",
];

export const DEFAULT_MAX_SESSIONS = 10;
export const MAX_MAX_SESSIONS = 50;
export const DEFAULT_MAX_MATCHES_PER_SESSION = 3;
export const MAX_MATCHES_PER_SESSION = 20;

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 100;
const FIRST_PROMPT_TRUNCATE = 80;
/**
 * Per-file cap on match DETAILS kept in memory while scanning (the count
 * stays exact past it). Far above MAX_MATCHES_PER_SESSION so the session-level
 * cap, not this one, decides what's returned.
 */
const FILE_MATCH_DETAIL_CAP = 200;

interface Matcher {
  query: string;
  caseSensitive: boolean;
  /** The query as compared: lowercased unless caseSensitive. */
  needle: string;
}

/**
 * `JSON.stringify` (and serde_json) escape only `"`, `\` and control chars in
 * string values — non-ASCII text is written verbatim. A query containing none
 * of those therefore appears byte-for-byte in the raw JSONL line, so a cheap
 * raw `includes` can gate the JSON.parse without false negatives.
 */
function fastPathEligible(query: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what JSON escapes.
  return !/["\\\u0000-\u001f]/.test(query);
}

/** Non-overlapping occurrence count plus first index, or undefined when absent. */
function findOccurrences(
  text: string,
  matcher: Matcher,
): { count: number; firstIndex: number } | undefined {
  // Case-insensitive matching lowercases the haystack and slices the ORIGINAL
  // text at the lowered index — exotic case-mapping (e.g. İ) can change string
  // length and skew a snippet by a char or two, which is acceptable for a
  // human-facing preview.
  const haystack = matcher.caseSensitive ? text : text.toLowerCase();
  const firstIndex = haystack.indexOf(matcher.needle);
  if (firstIndex === -1) return undefined;
  let count = 0;
  let index = firstIndex;
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(matcher.needle, index + matcher.needle.length);
  }
  return { count, firstIndex };
}

function buildSnippet(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, index + matchLength + SNIPPET_AFTER);
  const clipped = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${clipped}${end < text.length ? "…" : ""}`;
}

/** A match within one record, before session-level assembly adds `agentId`. */
interface RecordMatch {
  line: number;
  field: SearchFieldKind;
  toolName?: string;
  timestamp?: string;
  occurrences: number;
  snippet: string;
}

/**
 * Match one record's extracted fields: occurrences sum across every searched
 * field, while `field`/`toolName`/`snippet` come from the first field that
 * hit (1 record = 1 match).
 */
function matchRecord(
  line: number,
  timestamp: string | undefined,
  fields: readonly SearchableField[],
  wanted: ReadonlySet<SearchFieldKind>,
  matcher: Matcher,
): RecordMatch | undefined {
  let first: SearchableField | undefined;
  let firstIndex = 0;
  let occurrences = 0;
  for (const field of fields) {
    if (!wanted.has(field.field)) continue;
    const hit = findOccurrences(field.text, matcher);
    if (hit === undefined) continue;
    occurrences += hit.count;
    if (first === undefined) {
      first = field;
      firstIndex = hit.firstIndex;
    }
  }
  if (first === undefined) return undefined;
  return {
    line,
    field: first.field,
    ...(first.toolName !== undefined && { toolName: first.toolName }),
    ...(timestamp !== undefined && { timestamp }),
    occurrences,
    snippet: buildSnippet(first.text, firstIndex, matcher.needle.length),
  };
}

function recordTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const timestamp = (raw as Record<string, unknown>).timestamp;
  return typeof timestamp === "string" ? timestamp : undefined;
}

interface FileScanResult {
  /** Matches in line order, capped at FILE_MATCH_DETAIL_CAP. */
  matches: RecordMatch[];
  /** Exact matched-record count, uncapped. */
  matchCount: number;
}

/**
 * Stream-scan one Claude transcript (main session or subagent sidecar).
 * `undefined` = unreadable. Reads through `store` (local filesystem or an
 * S3-backed store, picked per-file by `claudeStoreForFilePath`) rather than
 * `node:fs` directly, so S3 sessions are searchable the same way local ones
 * are.
 */
async function scanClaudeFile(
  filePath: string,
  matcher: Matcher,
  wanted: ReadonlySet<SearchFieldKind>,
  store: ClaudeSessionStore,
): Promise<FileScanResult | undefined> {
  const rawGate = fastPathEligible(matcher.query)
    ? (line: string) =>
        matcher.caseSensitive
          ? line.includes(matcher.needle)
          : line.toLowerCase().includes(matcher.needle)
    : undefined;
  const matches: RecordMatch[] = [];
  let matchCount = 0;
  try {
    let line = 0;
    for await (const text of store.openLines(filePath)) {
      line += 1;
      if (rawGate !== undefined && !rawGate(text)) continue;
      const raw = parseJsonlLine(text);
      if (raw === null) continue;
      const fields = extractClaudeSearchFields(raw);
      if (fields.length === 0) continue;
      const match = matchRecord(line, recordTimestamp(raw), fields, wanted, matcher);
      if (match === undefined) continue;
      matchCount += 1;
      if (matches.length < FILE_MATCH_DETAIL_CAP) matches.push(match);
    }
  } catch {
    return undefined;
  }
  return { matches, matchCount };
}

/**
 * Stream-scan one Codex rollout. No raw-line fast path: `response_item`
 * message matches are kept only when the WHOLE file lacks the corresponding
 * `event_msg` form (see `CodexDeferredSearchField`), which requires looking
 * at every line anyway — Codex rollouts are small enough that this doesn't
 * matter. `undefined` = unreadable.
 */
async function scanCodexFile(
  filePath: string,
  matcher: Matcher,
  wanted: ReadonlySet<SearchFieldKind>,
): Promise<FileScanResult | undefined> {
  const definite: RecordMatch[] = [];
  let definiteCount = 0;
  const deferred: { gate: "userMessage" | "agentMessage"; match: RecordMatch }[] = [];
  const deferredCount = { userMessage: 0, agentMessage: 0 };
  let sawUserMessageEvent = false;
  let sawAgentMessageEvent = false;
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let line = 0;
    for await (const text of rl) {
      line += 1;
      const raw = parseJsonlLine(text);
      if (raw === null) continue;
      const extraction = extractCodexSearchFields(raw);
      if (extraction.sawUserMessageEvent) sawUserMessageEvent = true;
      if (extraction.sawAgentMessageEvent) sawAgentMessageEvent = true;
      const timestamp = recordTimestamp(raw);
      const match = matchRecord(line, timestamp, extraction.fields, wanted, matcher);
      if (match !== undefined) {
        definiteCount += 1;
        if (definite.length < FILE_MATCH_DETAIL_CAP) definite.push(match);
      }
      for (const gate of ["userMessage", "agentMessage"] as const) {
        const gatedFields = extraction.deferredFields.filter((f) => f.gate === gate);
        if (gatedFields.length === 0) continue;
        const gatedMatch = matchRecord(line, timestamp, gatedFields, wanted, matcher);
        if (gatedMatch === undefined) continue;
        deferredCount[gate] += 1;
        if (deferred.length < FILE_MATCH_DETAIL_CAP) deferred.push({ gate, match: gatedMatch });
      }
    }
  } catch {
    return undefined;
  }
  const keep = { userMessage: !sawUserMessageEvent, agentMessage: !sawAgentMessageEvent };
  const matches = [...definite, ...deferred.filter((d) => keep[d.gate]).map((d) => d.match)]
    .sort((a, b) => a.line - b.line)
    .slice(0, FILE_MATCH_DETAIL_CAP);
  const matchCount =
    definiteCount +
    (keep.userMessage ? deferredCount.userMessage : 0) +
    (keep.agentMessage ? deferredCount.agentMessage : 0);
  return { matches, matchCount };
}

/**
 * `parent_thread_id` of a Codex rollout, read from its first line only (a
 * current-format rollout starts with `session_meta`) — cheap enough to probe
 * every non-listed rollout when `includeSubagents` asks for sub-agent
 * threads, without analyzing the whole pool.
 */
async function readCodexParentThreadId(filePath: string): Promise<string | undefined> {
  let firstLine: string | undefined;
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const text of rl) {
      firstLine = text;
      rl.close();
      break;
    }
  } catch {
    return undefined;
  }
  if (firstLine === undefined) return undefined;
  const raw = parseJsonlLine(firstLine);
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type !== "session_meta") return undefined;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const meta = payload as Record<string, unknown>;
  if (typeof meta.parent_thread_id === "string") return meta.parent_thread_id;
  const source = meta.source;
  if (typeof source !== "object" || source === null) return undefined;
  const subagent = (source as Record<string, unknown>).subagent;
  if (typeof subagent !== "object" || subagent === null) return undefined;
  const threadSpawn = (subagent as Record<string, unknown>).thread_spawn;
  if (typeof threadSpawn !== "object" || threadSpawn === null) return undefined;
  const parentThreadId = (threadSpawn as Record<string, unknown>).parent_thread_id;
  return typeof parentThreadId === "string" ? parentThreadId : undefined;
}

interface Candidate {
  item: AnySessionListItem;
  filePath: string;
  mtimeMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function toSessionResult(
  item: AnySessionListItem,
  matches: SearchMatch[],
  matchCount: number,
): SearchSessionResult {
  return {
    source: item.source,
    sessionId: item.sessionId,
    ...(item.source === "claude-code" && { project: item.projectDirName }),
    ...(item.repoRoot !== undefined && { repoRoot: item.repoRoot }),
    ...(item.worktreeName !== undefined && { worktreeName: item.worktreeName }),
    ...(item.title !== undefined && { title: item.title }),
    ...(item.firstUserPrompt !== undefined && {
      firstUserPrompt: truncate(item.firstUserPrompt, FIRST_PROMPT_TRUNCATE),
    }),
    ...(item.startedAt !== undefined && { startedAt: item.startedAt }),
    ...(item.endedAt !== undefined && { endedAt: item.endedAt }),
    matchCount,
    matches,
    matchesTruncated: matchCount > matches.length,
  };
}

/**
 * Search session transcripts for a plain substring. See `SearchParams` /
 * `SearchResponse` for the contract; parameter ranges are clamped defensively
 * here even though the MCP schema already enforces them.
 */
export async function searchSessions(params: SearchParams): Promise<SearchResponse> {
  const source = params.source ?? "all";
  const caseSensitive = params.caseSensitive ?? false;
  const fields =
    params.fields !== undefined && params.fields.length > 0
      ? [...new Set(params.fields)]
      : [...DEFAULT_SEARCH_FIELDS];
  const wanted: ReadonlySet<SearchFieldKind> = new Set(fields);
  const scanLimit = clamp(params.scanLimit ?? MAX_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const maxSessions = clamp(params.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, MAX_MAX_SESSIONS);
  const maxMatchesPerSession = clamp(
    params.maxMatchesPerSession ?? DEFAULT_MAX_MATCHES_PER_SESSION,
    1,
    MAX_MATCHES_PER_SESSION,
  );
  const includeSubagents = params.includeSubagents ?? false;
  const matcher: Matcher = {
    query: params.query,
    caseSensitive,
    needle: caseSensitive ? params.query : params.query.toLowerCase(),
  };
  const sinceMs = params.since !== undefined ? Date.parse(params.since) : undefined;
  const untilMs = params.until !== undefined ? Date.parse(params.until) : undefined;

  // Only the page matters here — `total` is pagination bookkeeping, and the
  // start-time-desc order still gives the "scan newest sessions first"
  // behavior the scanLimit truncation below relies on.
  const { sessions: items } = await listSessions(MAX_LIST_LIMIT, source);

  // File refs for the transcripts behind each list item. Claude items are
  // keyed by (projectDirName, sessionId) — the same id can exist in two
  // projects (or across the local + S3 stores — see `listAllClaudeRefs`);
  // Codex ids are globally unique (see listCodexRefs' dedup). Local refs come
  // first from `listAllClaudeRefs`, so a collision between a local and an S3
  // session keeps the LOCAL ref (same precedence as single-session lookups
  // elsewhere — see `sources/claude.ts`).
  const claudeRefs = new Map<string, ClaudeSessionFileRef>();
  if (source !== "codex") {
    for (const ref of await listAllClaudeRefs()) {
      const key = `${ref.projectDirName}\u0000${ref.sessionId}`;
      if (!claudeRefs.has(key)) claudeRefs.set(key, ref);
    }
  }
  const codexRefs = new Map<string, CodexSessionFileRef>();
  if (source !== "claude-code") {
    for (const ref of await listCodexRefs()) codexRefs.set(ref.sessionId, ref);
  }

  const refOf = (item: AnySessionListItem): { filePath: string; mtimeMs: number } | undefined => {
    if (item.source === "claude-code") {
      const ref = claudeRefs.get(`${item.projectDirName}\u0000${item.sessionId}`);
      return ref === undefined ? undefined : { filePath: ref.filePath, mtimeMs: ref.mtimeMs };
    }
    const ref = codexRefs.get(item.sessionId);
    return ref === undefined ? undefined : { filePath: ref.filePath, mtimeMs: ref.mtimeMs };
  };

  // A `sessionId` can appear TWICE in `items` — once from the local listing,
  // once from the S3 listing (see `sources/claude.ts`'s `s3ClaudeAdapter` doc
  // comment: both sources' rows are merged independently, accepted duplicate
  // behavior) — and `refOf` resolves BOTH rows to the SAME local file (the
  // ref map above prefers local). Without deduping, that one file gets
  // scanned twice, producing two identical result cards and burning two
  // `scanLimit` slots for one session. Dedup by `(source, sessionId)`,
  // keeping the first candidate to survive the filters above — local wins
  // since `claudeAdapter` is listed before `s3ClaudeAdapter` precisely when
  // both resolve to the same underlying file.
  const seenCandidates = new Set<string>();
  const filtered: Candidate[] = [];
  for (const item of items) {
    if (params.project !== undefined) {
      if (item.source !== "claude-code" || item.projectDirName !== params.project) continue;
    }
    if (params.sessionId !== undefined && item.sessionId !== params.sessionId) continue;
    if (params.repo !== undefined && repoKeyOf(item) !== params.repo) continue;
    const ref = refOf(item);
    if (ref === undefined) continue; // Raced with deletion — nothing to scan.
    if (sinceMs !== undefined && ref.mtimeMs < sinceMs) continue;
    if (untilMs !== undefined && ref.mtimeMs > untilMs) continue;
    const dedupeKey = `${item.source}\u0000${item.sessionId}`;
    if (seenCandidates.has(dedupeKey)) continue;
    seenCandidates.add(dedupeKey);
    filtered.push({ item, ...ref });
  }
  const candidates = filtered.slice(0, scanLimit);

  // Codex sub-agent rollouts are excluded from the session list (they surface
  // under their parent) — map parent id -> child refs so their matches can be
  // attributed to the parent session, mirroring Claude sidecars.
  const codexChildren = new Map<string, CodexSessionFileRef[]>();
  if (includeSubagents && source !== "claude-code") {
    const listedCodexIds = new Set(
      items.filter((i) => i.source === "codex").map((i) => i.sessionId),
    );
    for (const ref of codexRefs.values()) {
      if (listedCodexIds.has(ref.sessionId)) continue;
      const parentThreadId = await readCodexParentThreadId(ref.filePath);
      if (parentThreadId === undefined) continue;
      const children = codexChildren.get(parentThreadId) ?? [];
      children.push(ref);
      codexChildren.set(parentThreadId, children);
    }
  }

  const results: SearchSessionResult[] = [];
  let scannedSessions = 0;
  let skippedUnreadable = 0;

  for (const candidate of candidates) {
    if (results.length >= maxSessions) break;
    scannedSessions += 1;

    const sessionMatches: SearchMatch[] = [];
    let matchCount = 0;
    const absorb = (scan: FileScanResult | undefined, agentId?: string) => {
      if (scan === undefined) {
        skippedUnreadable += 1;
        return;
      }
      matchCount += scan.matchCount;
      for (const match of scan.matches) {
        if (sessionMatches.length >= maxMatchesPerSession) break;
        sessionMatches.push({ ...match, ...(agentId !== undefined && { agentId }) });
      }
    };

    if (candidate.item.source === "claude-code") {
      const store = claudeStoreForFilePath(candidate.filePath);
      absorb(await scanClaudeFile(candidate.filePath, matcher, wanted, store));
      if (includeSubagents) {
        for (const subagent of await listSubagentRefs(candidate.filePath, store)) {
          absorb(
            await scanClaudeFile(subagent.jsonlPath, matcher, wanted, store),
            subagent.agentId,
          );
        }
      }
    } else {
      absorb(await scanCodexFile(candidate.filePath, matcher, wanted));
      for (const child of codexChildren.get(candidate.item.sessionId) ?? []) {
        absorb(await scanCodexFile(child.filePath, matcher, wanted), child.sessionId);
      }
    }

    if (matchCount === 0) continue;
    results.push(toSessionResult(candidate.item, sessionMatches, matchCount));
  }

  return {
    query: params.query,
    caseSensitive,
    fields,
    scanned: { sessions: scannedSessions, skippedUnreadable },
    results,
    resultsTruncated: scannedSessions < candidates.length || filtered.length > candidates.length,
  };
}
