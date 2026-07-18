/**
 * Generic tool-call listing for a Codex transcript — every `function_call` /
 * `custom_tool_call` / `local_shell_call` / `web_search_call` response item,
 * resolved against its output via the SAME linkage `codex/timeline.ts`'s
 * Timeline lens uses (`buildCodexLinkMaps`/`resolveCodexToolOutcome`), plus a
 * reconstructed `shellCommand` string for the subset of calls that are
 * genuinely shell executions. Two consumers:
 *
 *  - `codex/bash-stats.ts` filters to `shellCommand !== undefined` and feeds
 *    the rest into the harness-neutral Bash-analysis engine
 *    (`../shared/bash-stats.ts`).
 *  - The server's `get_tool_calls` MCP tool (`@junrei/server`'s `mcp.ts`)
 *    lists EVERY call generically (Bash-like or not), annotating
 *    family/subcommand only where `shellCommand` is set — mirroring how it
 *    already does this for Claude's own `Bash` tool calls.
 *
 * ## What Codex records for a shell execution (evidence)
 *
 * Three wire surfaces carry a shell command, all observed in this repo's
 * fixtures:
 *
 *  1. Pre-0.144: a `function_call` named `"shell"` or `"exec_command"` whose
 *     JSON `arguments` carry the command as EITHER a single string (`cmd`)
 *     or a pre-split argv array (`command`) — see
 *     `packages/core/test/fixtures/codex/sessions/2026/07/01/...11111111....jsonl:6`
 *     (`{"command":["pytest","foo.spec.ts"]}`) and
 *     `.../files-skills/...dddddddd....jsonl:4` (`{"cmd":"cat src/foo.ts",...}`).
 *     A wrapper-argv form (`["bash","-lc","<cmd>"]` / `["sh","-c",...]` /
 *     `["zsh","-lc",...]`) has been OBSERVED in the wild but not in this
 *     repo's fixtures — `unwrapShellArgv` below handles it defensively.
 *  2. `local_shell_call` response items carry NO command text at all (their
 *     `action` field is deliberately left unparsed — see
 *     `codexResponseLocalShellCallSchema`'s doc comment in `schema.ts`); the
 *     command only shows up on the PAIRED `exec_command_end` event's
 *     `command` array — see
 *     `.../sessions/2026/07/01/...11111111....jsonl:12-13`
 *     (`local_shell_call call-3` / `exec_command_end command:["pytest","foo.spec.ts"],exit_code:2`).
 *     Critically, `local_shell_call` ALSO carries no real output text: no
 *     `function_call_output` pairs with it, so `resolveCodexToolOutcome`
 *     synthesizes `"exited with code N"` as its only "result" — meaning
 *     entries sourced from this surface have a genuine, tiny `resultChars`
 *     (the placeholder string's length), not the command's real stdout/
 *     stderr size. This is a real gap in what Codex's log records, not a
 *     parsing shortfall.
 *  3. 0.144+ ("unified exec"): a `custom_tool_call` named `"exec"` whose
 *     `input` is a JS PROGRAM, not a command — shell invocations appear as
 *     `tools.exec_command({cmd, workdir})` call-site object literals inside
 *     it (see `files-skills.ts`'s `extractUnifiedExecCommands`, reused here)
 *     — see `.../files-skills/...eeeeeeee....jsonl:4` (two such calls in one
 *     program). A program's REAL output is one `custom_tool_call_output` for
 *     the WHOLE call, not per embedded `exec_command` — so every embedded
 *     command in one program is folded into ONE tool-call entry here (joined
 *     with `" && "`, since `parseShellCommand` already knows how to segment
 *     a compound command), rather than fabricated per-command result sizes
 *     that would double/triple-count the same output across several entries.
 *
 * `exec_command_end`'s `duration` field exists on the wire (`schema.ts`
 * declares it `z.unknown()`) but no fixture or real capture available while
 * building this shows its actual shape/units, so it is NEVER mapped to a
 * duration figure — `durationMs` here comes only from `durationBetween` (the
 * call's own timestamp vs. its resolved result's timestamp), the same
 * derivation the Timeline lens already uses, never a wire-reported value.
 */
import type { ToolCallStatus } from "../shared/timeline.js";
import { durationBetween } from "../shared/timeline.js";
import { extractUnifiedExecCommands } from "./files-skills.js";
import type { CodexRecord, CodexResponseItemInner, CodexTranscript } from "./parser.js";
import {
  buildCodexLinkMaps,
  type CodexLinkMaps,
  resolveCodexToolOutcome,
  summarizeCodexArgs,
} from "./timeline.js";

// ---------------------------------------------------------------------------
// Shell-command reconstruction — argv unwrapping/reassembly
// ---------------------------------------------------------------------------

/** `function_call` names Codex has used for a shell execution across CLI versions. */
const SHELL_FUNCTION_NAMES: ReadonlySet<string> = new Set(["shell", "exec_command"]);

/** Wrapper shells whose `-lc`/`-c` argv form carries the real command as a single, already-quoted string in its third element. */
const WRAPPER_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh"]);
const WRAPPER_FLAGS: ReadonlySet<string> = new Set(["-lc", "-c"]);

/**
 * `["bash","-lc","git status"]` (or `sh`/`zsh`, `-c`) -> `"git status"` — the
 * inner string is already a complete, correctly-quoted shell command line,
 * so it's used AS-IS rather than re-joined/re-quoted. `undefined` for any
 * other argv shape (the caller falls back to `reassembleArgv`).
 */
function unwrapShellArgv(argv: readonly string[]): string | undefined {
  if (argv.length !== 3) return undefined;
  const [shell, flag, inner] = argv;
  if (shell === undefined || flag === undefined || inner === undefined) return undefined;
  if (!WRAPPER_SHELLS.has(shell) || !WRAPPER_FLAGS.has(flag)) return undefined;
  return inner;
}

/** Characters that force single-quoting when reassembling a plain (non-wrapper) argv into a display command string. */
const NEEDS_QUOTING_PATTERN = /[\s'"$`\\!*?[\]{}();&|<>~#]/;

function quoteArgvToken(token: string): string {
  if (token === "") return "''";
  if (!NEEDS_QUOTING_PATTERN.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * A plain (non-wrapper) argv array — e.g. `["git","commit","-m","fix bug"]`
 * — reassembled into a single command-line string with any arg containing
 * whitespace/shell-special characters single-quoted, so the result is a
 * FAITHFUL shell command line (safe to re-feed to `parseShellCommand`), not
 * just a space-joined guess that would silently merge `-m` and `fix bug`
 * into one token.
 */
function reassembleArgv(argv: readonly string[]): string {
  const unwrapped = unwrapShellArgv(argv);
  if (unwrapped !== undefined) return unwrapped;
  return argv.map(quoteArgvToken).join(" ");
}

/** `function_call.arguments` (a JSON string) -> a display command, for `"shell"`/`"exec_command"` calls whose payload carries a `cmd` string or `command` argv. `undefined` when `arguments` is missing/malformed, or the payload has neither field. */
function shellCommandFromFunctionCall(
  name: string,
  argumentsJson: string | undefined,
): string | undefined {
  if (!SHELL_FUNCTION_NAMES.has(name) || argumentsJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const raw = obj.cmd ?? obj.command;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((t): t is string => typeof t === "string")) {
    return reassembleArgv(raw);
  }
  return undefined;
}

/** `exec_command_end.command` (an argv array) -> a display command — the only source of command text for a `local_shell_call` (see this module's doc comment). */
function shellCommandFromExecEnd(command: string[] | undefined): string | undefined {
  if (command === undefined || command.length === 0) return undefined;
  return reassembleArgv(command);
}

/** 0.144+ unified-exec `custom_tool_call` "exec" input (a JS program) -> a joined display command, or `undefined` when it embeds no `tools.exec_command(...)` call (e.g. an `apply_patch`-only program). */
function shellCommandFromUnifiedExec(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const calls = extractUnifiedExecCommands(input);
  if (calls.length === 0) return undefined;
  return calls.map((c) => c.cmd).join(" && ");
}

// ---------------------------------------------------------------------------
// listCodexToolCalls
// ---------------------------------------------------------------------------

export interface CodexToolCallRecord {
  /** Real `call_id` when the wire carried one; a `L<line>` synthetic fallback otherwise (a `web_search_call`, or a `local_shell_call` with no `call_id`) — mirrors `buildCodexToolCallEntry`'s own fallback (timeline.ts). */
  callId: string;
  /** Raw wire tool name (`"shell"`, `"exec_command"`, `"exec"`, `"apply_patch"`, ...), or `"shell"`/`"web_search"` for the two response-item kinds that carry no `name` field of their own — same convention `buildCodexTimeline` already uses. */
  toolName: string;
  line: number;
  timestamp?: string;
  status: ToolCallStatus;
  inputChars: number;
  resultChars: number;
  durationMs?: number;
  inputSummary: string;
  /** Reconstructed shell command text, set ONLY when this call is a genuine shell execution — see the module doc comment for exactly which wire surfaces this covers and what it can't recover (real output size for `local_shell_call`, in particular). */
  shellCommand?: string;
  /**
   * `true` for a `local_shell_call`-sourced record — its `resultChars` is the
   * synthesized `"exited with code N"` placeholder's length, NEVER a real
   * captured output size (see this module's doc comment, surface 2). Omitted
   * (never `false`) for every other surface. Threaded into
   * `NeutralBashCall.resultIsPlaceholder` by `codex/bash-stats.ts` so
   * `shared/bash-stats.ts`'s $ weighting excludes it from every `estUsd` sum.
   */
  resultIsPlaceholder?: boolean;
}

function inputCharsOf(raw: string | undefined): number {
  return raw?.length ?? 0;
}

function toRecord(
  item: Extract<
    CodexResponseItemInner,
    { kind: "functionCall" | "customToolCall" | "localShellCall" | "webSearchCall" }
  >,
  line: number,
  timestamp: string | undefined,
  linkMaps: CodexLinkMaps,
): CodexToolCallRecord {
  if (item.kind === "webSearchCall") {
    const callId = `L${String(line)}`;
    const inputSummary = item.query !== undefined ? item.query.slice(0, 120) : "";
    return {
      callId,
      toolName: "web_search",
      line,
      ...(timestamp !== undefined && { timestamp }),
      status: item.status === "failed" ? "error" : "ok",
      inputChars: inputCharsOf(item.query),
      resultChars: 0,
      inputSummary,
    };
  }

  const callId = item.kind === "localShellCall" ? (item.callId ?? `L${String(line)}`) : item.callId;
  const rawInput = item.kind === "functionCall" ? item.argumentsJson : undefined;
  const rawCustomInput = item.kind === "customToolCall" ? item.input : undefined;
  const outcome = resolveCodexToolOutcome(callId, linkMaps);
  const durationMs = durationBetween(timestamp, outcome.resultTimestamp);

  const shellCommand =
    item.kind === "functionCall"
      ? shellCommandFromFunctionCall(item.name, item.argumentsJson)
      : item.kind === "customToolCall" && item.name === "exec"
        ? shellCommandFromUnifiedExec(item.input)
        : item.kind === "localShellCall"
          ? shellCommandFromExecEnd(linkMaps.execEndByCallId.get(callId)?.command)
          : undefined;

  const toolName = item.kind === "localShellCall" ? "shell" : item.name;

  return {
    callId,
    toolName,
    line,
    ...(timestamp !== undefined && { timestamp }),
    status: outcome.status,
    inputChars: inputCharsOf(rawInput ?? rawCustomInput),
    resultChars: outcome.text?.length ?? 0,
    ...(durationMs !== undefined && { durationMs }),
    inputSummary:
      item.kind === "localShellCall"
        ? ""
        : summarizeCodexArgs(item.kind === "functionCall" ? item.argumentsJson : item.input),
    ...(shellCommand !== undefined && { shellCommand }),
    ...(item.kind === "localShellCall" && { resultIsPlaceholder: true }),
  };
}

/** Every tool call in a Codex transcript, in source order — see the module doc comment. */
export function listCodexToolCalls(transcript: CodexTranscript): CodexToolCallRecord[] {
  const records = transcript.records;
  const linkMaps = buildCodexLinkMaps(records);
  const out: CodexToolCallRecord[] = [];
  for (const record of records as readonly CodexRecord[]) {
    if (record.type !== "responseItem") continue;
    const item = record.item;
    if (
      item.kind !== "functionCall" &&
      item.kind !== "customToolCall" &&
      item.kind !== "localShellCall" &&
      item.kind !== "webSearchCall"
    ) {
      continue;
    }
    out.push(toRecord(item, record.line, record.timestamp, linkMaps));
  }
  return out;
}
