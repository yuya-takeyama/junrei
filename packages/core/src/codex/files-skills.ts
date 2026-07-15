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
 *  - Edits are DETERMINISTIC: every apply_patch invocation carries a patch
 *    envelope whose `*** Update/Add/Delete File: <path>` header lines name
 *    every touched file exactly.
 *  - Reads are a HEURISTIC, and deliberately a conservative one: Codex has
 *    no read-only file tool, only a general-purpose shell. We recognize a
 *    short list of read-oriented commands (cat/head/tail/.../rg/grep) and
 *    pull path-looking tokens out of their arguments. This under-reports
 *    (e.g. a script that reads a file internally is invisible to us) rather
 *    than risk over-reporting by guessing at arbitrary shell invocations.
 *
 * Both signals exist on two wire surfaces, because Codex 0.144 replaced the
 * per-tool calls with a "unified exec" tool:
 *
 *  - Pre-0.144: a `custom_tool_call` named `apply_patch` whose input IS the
 *    raw patch envelope, and a `function_call` named `exec_command`/`shell`
 *    whose JSON arguments carry the command (`cmd` string or `command`
 *    argv array) plus an optional `workdir`.
 *  - 0.144+: a single `custom_tool_call` named `exec` whose input is a JS
 *    program; shell commands appear as `tools.exec_command({cmd, workdir})`
 *    call-site object literals (see `extractUnifiedExecCommands`) and patch
 *    envelopes as JS string literals passed to `tools.apply_patch(...)`,
 *    where the envelope's newlines are two-character `\n` escapes (see
 *    `EMBEDDED_PATCH_HEADER_PATTERN`). MCP calls (`tools.mcp__*`) in the
 *    same program carry no file signal and are ignored.
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

/** Git revision ranges such as `origin/main...HEAD` are slash-bearing, but never file paths. */
const GIT_REVISION_RANGE_PATTERN = /\.\.\./;

/**
 * Characters that essentially never appear in an honest, unquoted file-path
 * argument but are common in the OTHER slash-bearing tokens read commands
 * take — quoted awk programs (`'/^resource/{print $3}'`), regex patterns
 * (`/akira\./`), globs (`src/*.ts`, `'!archives/**'`), URLs — any hit
 * disqualifies the token.
 */
const NON_PATH_CHARS_PATTERN = /['"`{}()[\]*?$\\!]|:\/\//;

function isPathLooking(token: string): boolean {
  if (token === "" || token.startsWith("-")) return false;
  if (NON_PATH_CHARS_PATTERN.test(token)) return false;
  if (GIT_REVISION_RANGE_PATTERN.test(token)) return false;
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

/** A shell command call normalized off either wire surface: its tokens plus the per-call `workdir`, when one was given. */
interface ShellCommandCall {
  tokens: string[];
  workdir?: string;
}

/**
 * `exec_command`/`shell` function-call arguments carry the command as either
 * a single string (`cmd`) or a pre-split argv array (`command`, or newer
 * `cmd` as an array) — normalize whichever shape shows up to a token list,
 * keeping the per-call `workdir` (it wins over the session cwd when
 * resolving relative paths — the two can genuinely differ).
 */
function commandTokens(argumentsJson: string): ShellCommandCall | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const workdir = typeof obj.workdir === "string" ? obj.workdir : undefined;
  const raw = obj.cmd ?? obj.command;
  if (typeof raw === "string") {
    return { tokens: tokenize(raw), ...(workdir !== undefined && { workdir }) };
  }
  if (Array.isArray(raw) && raw.every((t): t is string => typeof t === "string")) {
    return { tokens: raw, ...(workdir !== undefined && { workdir }) };
  }
  return undefined;
}

/** Tokens that separate commands in a compound command line (`a && b | c`). Only exact whitespace-delimited matches count — a `|` INSIDE a quoted rg/grep pattern is part of its token and never splits. */
const SHELL_OPERATOR_TOKENS = new Set(["&&", "||", ";", "|", "&"]);

/**
 * Path-looking arguments of one recognized read command, or `[]` when the
 * command isn't one we treat as a read (or carries no path-looking args).
 * `sed` is only counted when invoked with `-n` (print-selected-lines mode) —
 * plain `sed` is at least as often used to transform a stream as to inspect
 * a file, and `sed -i` edits in place, so neither should be counted as a read.
 * Redirect targets (`> out.txt`, `2>err.log`) are writes, not reads, so they
 * are skipped; a heredoc marker (`<<EOF`) ends the scan outright since
 * everything after it is content being WRITTEN, not file arguments.
 */
function readPathsFromSegment(tokens: readonly string[]): string[] {
  const [name, ...args] = tokens;
  if (name === undefined || !READ_COMMANDS.has(name)) return [];
  if (name === "sed" && !args.includes("-n")) return [];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith("<<")) break;
    if (token === ">" || token === ">>") {
      i += 1; // the next token is the redirect target
      continue;
    }
    if (token.includes(">")) continue; // attached form: ">out.txt", "2>&1", "2>err.log"
    if (token === "<") continue; // `< in.txt` — in.txt itself still counts as the next token
    // A semicolon may be attached to the preceding argument (`cat foo.ts;`)
    // because this deliberately lightweight tokenizer splits only on
    // whitespace. Keep the path, but never surface shell syntax as part of
    // its name.
    const pathToken = token.replace(/;+$/, "");
    if (isPathLooking(pathToken)) paths.push(pathToken);
  }
  return paths;
}

/**
 * Path-looking read arguments across a whole (possibly compound) command
 * line: the token list is split on shell operator tokens and each segment is
 * judged independently, so `pwd && cat a.ts | head` still credits `cat` its
 * read even though the line doesn't START with a read command.
 */
function readPathsFromCommand(tokens: readonly string[]): string[] {
  const paths: string[] = [];
  let segment: string[] = [];
  for (const token of tokens) {
    if (SHELL_OPERATOR_TOKENS.has(token)) {
      paths.push(...readPathsFromSegment(segment));
      segment = [];
    } else {
      segment.push(token);
    }
  }
  paths.push(...readPathsFromSegment(segment));
  return paths;
}

// ---------------------------------------------------------------------------
// Unified exec (Codex 0.144+) — lifting file signals out of the JS program
// ---------------------------------------------------------------------------

/**
 * Patch-envelope file headers as they appear EMBEDDED IN JS SOURCE: the
 * envelope is a JS string literal (`"*** Begin Patch\n*** Update File: ..."`),
 * so the newline ending a header line is the two-character `\n` escape and
 * the path capture must stop at a backslash — as well as at a real newline
 * or a quote, which covers a patch written as a template literal instead.
 */
const EMBEDDED_PATCH_HEADER_PATTERN = /\*\*\* (?:Update|Add|Delete) File: ([^\\\n"'`]+)/g;

/** One `tools.exec_command({...})` call site lifted out of a unified-exec JS program — the raw command string plus its per-call `workdir`. */
interface UnifiedExecCommand {
  cmd: string;
  workdir?: string;
}

const UNIFIED_EXEC_MARKER = "tools.exec_command(";

const SIMPLE_JS_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function skipWhitespace(source: string, index: number): number {
  let i = index;
  while (i < source.length && /\s/.test(source.charAt(i))) i += 1;
  return i;
}

/**
 * Scan one JS string literal (double-, single-, or backtick-quoted) starting
 * at `start`, decoding standard escapes (`\n`, `\t`, `\xNN`, `\uNNNN`,
 * `\u{...}`; anything unrecognized keeps the escaped character literally).
 * Template-literal `${...}` interpolation is NOT evaluated — its source text
 * lands in the value as-is, which is harmless downstream since interpolated
 * fragments never look path-like. Returns `undefined` on an unterminated
 * literal so the caller can abandon the surrounding call site.
 */
function scanStringLiteral(
  source: string,
  start: number,
): { value: string; end: number } | undefined {
  const quote = source.charAt(start);
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === quote) return { value, end: i + 1 };
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const next = source.charAt(i + 1);
    if (next === "") return undefined;
    if (next === "x") {
      const hex = source.slice(i + 2, i + 4);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    if (next === "u") {
      if (source.charAt(i + 2) === "{") {
        const close = source.indexOf("}", i + 3);
        const hex = close === -1 ? "" : source.slice(i + 3, close);
        if (/^[0-9A-Fa-f]{1,6}$/.test(hex)) {
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          i = close + 1;
          continue;
        }
      } else {
        const hex = source.slice(i + 2, i + 6);
        if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
      }
    }
    value += SIMPLE_JS_ESCAPES[next] ?? next;
    i += 2;
  }
  return undefined;
}

/**
 * Every `tools.exec_command({...})` call site in a unified-exec JS program
 * whose argument is an inline object literal, with its `cmd` and `workdir`
 * string values decoded. This is a tolerant single-pass scanner, not a JS
 * parser: it walks the object literal tracking brace/bracket depth and
 * string literals, and only harvests top-level `cmd:`/`workdir:` properties
 * (bare or quoted keys — both spellings occur in real rollouts). A call
 * whose argument is a variable reference is skipped — the conservative
 * under-report the read heuristic already accepts everywhere else.
 */
function extractUnifiedExecCommands(source: string): UnifiedExecCommand[] {
  const calls: UnifiedExecCommand[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(UNIFIED_EXEC_MARKER, from);
    if (at === -1) break;
    from = at + UNIFIED_EXEC_MARKER.length;
    let i = skipWhitespace(source, from);
    if (source.charAt(i) !== "{") continue;
    let depth = 0;
    let pendingKey: string | undefined;
    let cmd: string | undefined;
    let workdir: string | undefined;
    scan: while (i < source.length) {
      const ch = source.charAt(i);
      switch (ch) {
        case "{":
        case "[":
          depth += 1;
          i += 1;
          break;
        case "}":
        case "]":
          depth -= 1;
          i += 1;
          if (depth === 0) break scan;
          break;
        case ",":
          if (depth === 1) pendingKey = undefined;
          i += 1;
          break;
        case '"':
        case "'":
        case "`": {
          const literal = scanStringLiteral(source, i);
          if (literal === undefined) break scan;
          if (depth === 1) {
            if (pendingKey !== undefined) {
              if (pendingKey === "cmd") cmd ??= literal.value;
              else if (pendingKey === "workdir") workdir ??= literal.value;
              pendingKey = undefined;
            } else {
              const after = skipWhitespace(source, literal.end);
              if (source.charAt(after) === ":") {
                pendingKey = literal.value;
                i = after + 1;
                continue;
              }
            }
          }
          i = literal.end;
          break;
        }
        default: {
          if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
            let j = i + 1;
            while (j < source.length && /[\w$]/.test(source.charAt(j))) j += 1;
            const after = skipWhitespace(source, j);
            if (source.charAt(after) === ":") {
              pendingKey = source.slice(i, j);
              i = after + 1;
              continue;
            }
            i = j;
            break;
          }
          i += 1;
        }
      }
    }
    if (cmd !== undefined) calls.push({ cmd, ...(workdir !== undefined && { workdir }) });
    from = Math.max(from, i);
  }
  return calls;
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

    if (item.kind === "customToolCall" && item.name === "exec" && item.input !== undefined) {
      // Unified exec (0.144+): one JS program may carry several exec_command
      // calls AND a patch envelope — harvest both. The `apply_patch` guard
      // keeps stray `*** ... File:` prose in an unrelated command (say, a
      // heredoc discussing patches) from being misread as an edit.
      if (item.input.includes("apply_patch")) {
        for (const match of item.input.matchAll(EMBEDDED_PATCH_HEADER_PATTERN)) {
          const rawPath = match[1]?.trim();
          if (rawPath === undefined || rawPath === "") continue;
          touch(resolveAgainstCwd(rawPath, cwd), "edit", record.line, record.timestamp);
        }
      }
      for (const call of extractUnifiedExecCommands(item.input)) {
        const base = call.workdir ?? cwd;
        for (const rawPath of readPathsFromCommand(tokenize(call.cmd))) {
          touch(resolveAgainstCwd(rawPath, base), "read", record.line, record.timestamp);
        }
      }
      continue;
    }

    if (
      item.kind === "functionCall" &&
      (item.name === "exec_command" || item.name === "shell") &&
      item.argumentsJson !== undefined
    ) {
      const call = commandTokens(item.argumentsJson);
      if (call === undefined) continue;
      const base = call.workdir ?? cwd;
      for (const rawPath of readPathsFromCommand(call.tokens)) {
        touch(resolveAgainstCwd(rawPath, base), "read", record.line, record.timestamp);
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
