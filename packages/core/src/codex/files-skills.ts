/**
 * Files & skills lens data for a Codex transcript — the Codex analog of
 * `metrics.ts`'s `computeFileAccess`/`computeSkillInvocations`, reusing the
 * exact same `FileAccessAgg`/`FileAccessEntry`/`SkillInvocation` shapes (now
 * promoted onto `SessionAnalysisCore` — see `session-analysis.ts`) so the
 * web's Files & skills lens needs no Codex-specific rendering path for
 * either of them.
 *
 * Codex has no `Read`/`Edit` tool concept to key off of the way Claude does,
 * so the two halves are derived very differently:
 *
 *  - Edits are DETERMINISTIC: every `custom_tool_call` named `apply_patch`
 *    carries a patch envelope whose `*** Update/Add/Delete File: <path>`
 *    header lines name every touched file exactly.
 *  - Reads are a HEURISTIC, and deliberately a conservative one: Codex has
 *    no read-only file tool, only a general-purpose shell. We recognize a
 *    short list of read-oriented commands (cat/head/tail/.../rg/grep) and
 *    pull path-looking tokens out of their arguments. This under-reports
 *    (e.g. a script that reads a file internally is invisible to us) rather
 *    than risk over-reporting by guessing at arbitrary shell invocations.
 *
 * Unlike Claude (see `metrics.ts#computeFileAccess`), NO context-injection
 * tracking (`injectedCount`/`injectedChars`) is derived for Codex, on
 * purpose: the only injected-context marker Codex's rollout format exposes,
 * `# AGENTS.md instructions for <cwd>` (`isSyntheticUserText` in
 * `./analyze.ts`), names a DIRECTORY, never a single file — Codex merges
 * AGENTS.md from several directory levels, so there is no one honest path to
 * attribute the injection to. The `[$plugin:skill](path/to/SKILL.md)` marker
 * `computeCodexSkillInvocations` parses below DOES carry an honest path, but
 * it's the human's own mention syntax typed into their prompt, not a
 * harness-generated record proving the body was actually loaded (no matching
 * record measures its size, unlike Claude's isMeta injection) — so it's left
 * out rather than guessed at too.
 */
import type {
  FileAccessAgg,
  FileAccessEntry,
  FileAccessResult,
  SkillInvocation,
} from "../shared/metrics.js";
import { foldFileAccess, mergeFileAccess } from "../shared/metrics.js";
import type { CodexTranscript } from "./parser.js";

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

/** `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>` — one per touched file, possibly several per `apply_patch` call. */
const PATCH_HEADER_PATTERN = /^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$/gm;

/** Commands whose output we treat as "read this file" when a path-looking argument follows. */
const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "rg",
  "grep",
  "awk",
  "wc",
  "stat",
  "nl",
  "sed",
]);

/** A bare filename's extension, e.g. `foo.spec.ts` with no `/` in it — still counts as path-looking. */
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,10}$/;

function isPathLooking(token: string): boolean {
  if (token === "" || token.startsWith("-")) return false;
  return token.includes("/") || FILE_EXTENSION_PATTERN.test(token);
}

/**
 * Best-effort shell-command tokenizer: splits on runs of whitespace. Good
 * enough for pulling flags/paths out of the simple read commands we
 * recognize — not a real shell parser (no quote/escape handling), which is
 * fine here since we only ever look for path-looking tokens, never execute
 * anything.
 */
function tokenize(command: string): string[] {
  return command.split(/\s+/).filter((t) => t !== "");
}

/**
 * `exec_command`/`shell` function-call arguments carry the command as either
 * a single string (`cmd`) or a pre-split argv array (`command`, or newer
 * `cmd` as an array) — normalize whichever shape shows up to a token list.
 */
function commandTokens(argumentsJson: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const raw = obj.cmd ?? obj.command;
  if (typeof raw === "string") return tokenize(raw);
  if (Array.isArray(raw) && raw.every((t): t is string => typeof t === "string")) return raw;
  return undefined;
}

/**
 * Path-looking arguments of a recognized read command, or `[]` when the
 * command isn't one we treat as a read (or carries no path-looking args).
 * `sed` is only counted when invoked with `-n` (print-selected-lines mode) —
 * plain `sed` is at least as often used to transform a stream as to inspect
 * a file, and `sed -i` edits in place, so neither should be counted as a read.
 */
function readPathsFromCommand(tokens: readonly string[]): string[] {
  const [name, ...args] = tokens;
  if (name === undefined || !READ_COMMANDS.has(name)) return [];
  if (name === "sed" && !args.includes("-n")) return [];
  return args.filter(isPathLooking);
}

/**
 * Resolve a possibly-relative path against the session's cwd. Relative paths
 * are joined as plain strings (no `..`/`.` segment resolution) — a
 * deliberate simplification: this is a heuristic signal to begin with, and a
 * literal join keeps the displayed path recognizable even when it isn't
 * perfectly normalized, rather than silently collapsing it into something
 * that might not match what was actually typed.
 */
function resolveAgainstCwd(path: string, cwd: string | undefined): string {
  if (path.startsWith("/") || path.startsWith("~") || cwd === undefined) return path;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${path}`;
}

/**
 * Per-transcript file-access tally for a Codex rollout — same
 * `Map<string, FileAccessAgg>` shape `computeFileAccess` (metrics.ts)
 * produces for Claude, so `mergeFileAccess`/`foldFileAccess` work unchanged
 * on either harness's output (see `mergeCodexFileAccess` below, used at
 * serve time to fold sub-agent threads into a parent's tally).
 */
export function computeCodexFileAccess(transcript: CodexTranscript): Map<string, FileAccessAgg> {
  const map = new Map<string, FileAccessAgg>();
  let cwd: string | undefined;

  const touch = (
    path: string,
    kind: "read" | "edit",
    line: number,
    timestamp: string | undefined,
  ) => {
    let entry = map.get(path);
    if (entry === undefined) {
      entry = {
        path,
        reads: 0,
        edits: 0,
        firstLine: line,
        ...(timestamp !== undefined && { firstTimestamp: timestamp }),
      };
      map.set(path, entry);
    }
    if (kind === "read") entry.reads += 1;
    else entry.edits += 1;
  };

  for (const record of transcript.records) {
    if (record.type === "sessionMeta") {
      cwd = record.cwd ?? cwd;
      continue;
    }
    if (record.type === "turnContext") {
      cwd = record.cwd ?? cwd;
      continue;
    }
    if (record.type !== "responseItem") continue;
    const item = record.item;

    if (item.kind === "customToolCall" && item.name === "apply_patch" && item.input !== undefined) {
      for (const match of item.input.matchAll(PATCH_HEADER_PATTERN)) {
        const rawPath = match[1];
        if (rawPath === undefined || rawPath === "") continue;
        touch(resolveAgainstCwd(rawPath, cwd), "edit", record.line, record.timestamp);
      }
      continue;
    }

    if (
      item.kind === "functionCall" &&
      (item.name === "exec_command" || item.name === "shell") &&
      item.argumentsJson !== undefined
    ) {
      const tokens = commandTokens(item.argumentsJson);
      if (tokens === undefined) continue;
      for (const rawPath of readPathsFromCommand(tokens)) {
        touch(resolveAgainstCwd(rawPath, cwd), "read", record.line, record.timestamp);
      }
    }
  }

  return map;
}

/** `FileAccessEntry[]` -> `Map<string, FileAccessAgg>`, dropping the `threads` tag `mergeFileAccess` recomputes itself. */
function toAggMap(entries: readonly FileAccessEntry[]): Map<string, FileAccessAgg> {
  const map = new Map<string, FileAccessAgg>();
  for (const entry of entries) {
    map.set(entry.path, {
      path: entry.path,
      reads: entry.reads,
      edits: entry.edits,
      ...(entry.firstTouchTimestamp !== undefined && { firstTimestamp: entry.firstTouchTimestamp }),
      ...(entry.firstTouchLine !== undefined && { firstLine: entry.firstTouchLine }),
    });
  }
  return map;
}

/**
 * Fold a Codex session's own file access with every descendant sub-agent
 * thread's — the Codex analog of Claude's `analyzeSubagents` (analyze.ts),
 * just running at serve time (see `getCodexSession` on the server) instead
 * of analysis time, since a Codex sub-agent is a sibling rollout file
 * discovered from the whole session pool rather than a sidecar `analyzeClaudeSession`
 * can walk on its own. `main`/`subagents` are each already-merged
 * `FileAccessEntry[]` (one session's own `computeCodexFileAccess` output,
 * already run through `mergeFileAccess` once at analysis time — see
 * `analyzeCodexSession`); this re-derives `FileAccessAgg` maps from them
 * rather than re-parsing transcripts, then reuses `mergeFileAccess`/
 * `foldFileAccess` unchanged.
 */
export function mergeCodexFileAccess(
  main: readonly FileAccessEntry[],
  subagents: readonly (readonly FileAccessEntry[])[],
): FileAccessResult {
  const subagentMap = new Map<string, FileAccessAgg>();
  for (const entries of subagents) foldFileAccess(subagentMap, toAggMap(entries));
  return mergeFileAccess(toAggMap(main), subagentMap);
}

// ---------------------------------------------------------------------------
// Skill invocations
// ---------------------------------------------------------------------------

/**
 * Codex plugin/skill invocation marker, as it appears in a `user_message`
 * event's text: `[$<plugin>:<skill>](<path-to-SKILL.md>)`, e.g.
 * `[$superpowers:brainstorming](/Users/.../skills/brainstorming/SKILL.md)`.
 */
const SKILL_LINK_PATTERN = /\[\$([\w-]+):([\w-]+)]\(([^)]+)\)/g;

/**
 * Skill invocations from `user_message` event text — the Codex analog of
 * Claude's `Skill` tool calls, main transcript only (Codex sub-agent threads
 * are analyzed independently, same as Claude subagents never contributing to
 * the parent's `skillInvocations`). `name` is the `plugin:skill` pair as
 * written in the marker (not just the skill id) since that's the identifier
 * that actually disambiguates it — Codex has no separate "slash command"
 * concept, so every invocation here is `kind: "skill"`. `argsPreview`,
 * `resultChars`, and `injectedChars`/`injectionLine` (Claude-only: a `Skill`
 * tool call's args/tool-result and its matched injection record) have no
 * Codex equivalent and are left unset rather than fabricated.
 */
export function computeCodexSkillInvocations(transcript: CodexTranscript): SkillInvocation[] {
  const invocations: SkillInvocation[] = [];
  let userMessageIndex = 0;

  for (const record of transcript.records) {
    if (record.type !== "eventMsg" || record.event.kind !== "userMessage") continue;
    userMessageIndex += 1;
    const text = record.event.text;
    if (text === undefined) continue;
    for (const match of text.matchAll(SKILL_LINK_PATTERN)) {
      const plugin = match[1];
      const skill = match[2];
      if (plugin === undefined || skill === undefined) continue;
      invocations.push({
        kind: "skill",
        name: `${plugin}:${skill}`,
        line: record.line,
        userTurn: userMessageIndex,
        ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
      });
    }
  }

  return invocations;
}
