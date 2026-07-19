/**
 * Harness-agnostic shell-command parser. Pure text in, structured best-effort
 * output out — no knowledge of Claude Code or Codex transcript shapes lives
 * here, so both `claude/bash-stats.ts` (this PR) and a future Codex bash
 * analysis can share the exact same command-family grouping.
 *
 * This is NOT a full shell grammar. It is a pragmatic lexer good enough to
 * answer "what program(s) did this command line run, and with what
 * subcommand" for analytics purposes. Known, deliberate simplifications:
 *  - Here-docs (`<<`), process substitution (`<(...)`/`>(...)`), brace/glob
 *    expansion, and `&`-backgrounding are not modeled. `<(`/`>(` are treated
 *    as opaque spans (same as `$(...)`) purely so they don't corrupt
 *    tokenization, not because they're understood.
 *  - Global flags that consume a separate value (e.g. `git -C <dir>`,
 *    `kubectl -n <ns>`) are NOT special-cased when hunting for a family's
 *    subcommand — `subcommand` is always "the first arg after the executable
 *    that doesn't start with `-`", exactly as documented on `ShellSegment`.
 *    A command like `git -C /repo status` will misidentify `/repo` as the
 *    subcommand. Accepted as a known limitation for this best-effort parser.
 *  - Wrapper-command unwrapping (`env`/`time`/`nice`/`command`/`xargs`) skips
 *    leading flags heuristically; only `nice`'s `-n`/`--adjustment` and a
 *    handful of common `xargs` value flags are known to consume a separate
 *    argument. Anything else is assumed to be a boolean flag or to carry its
 *    value attached (`-P4`, `-I{}`).
 */

/** Command-family names whose first non-flag argument is treated as a `subcommand` — see `ShellSegment.subcommand`. */
const KNOWN_COMMAND_FAMILIES: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "aqua",
  "corepack",
]);

/** Wrapper commands skipped when hunting for the meaningful executable — see the module doc comment. */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set(["env", "time", "nice", "command", "xargs"]);

/** `nice` flags known to take a separate (detached) value argument. */
const NICE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-n", "--adjustment"]);

/** `xargs` flags known to take a separate (detached) value argument (best-effort, not exhaustive). */
const XARGS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-I",
  "-L",
  "-n",
  "-P",
  "-s",
  "-d",
  "-a",
  "-E",
  "-l",
  "--replace",
  "--max-lines",
  "--max-args",
  "--max-procs",
]);

/**
 * Executables that produce no meaningful stdout of their own — so when a
 * chained or piped call also contains a "real" command, that real command,
 * not one of these, is what actually produced the result chars. Used by
 * `primaryCommand` to skip past a leading `cd`/`echo`/etc. instead of
 * mis-attributing e.g. a 24k-char `cat` dump to the `echo` that merely
 * printed a separator line ahead of it.
 */
const NEAR_ZERO_OUTPUT_COMMANDS: ReadonlySet<string> = new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "true",
  "false",
  ":",
  "sleep",
  "touch",
  "mkdir",
  "exit",
]);

/**
 * Shell control-flow keywords. When a segment's first token is one of these,
 * it's classified via `controlKeyword` instead of attempting
 * executable/subcommand extraction — naive splitting on `;` (one of our four
 * segment separators) routinely slices a `for`/`if`/`while` construct into
 * fragments like "then echo hi" or "done", and none of `then`/`done`/etc. are
 * real executables. `for`/`while`/`if` are the ones named in the spec this
 * module implements; the rest are included because they arise from the same
 * naive split and would otherwise be misidentified as commands.
 */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "for",
  "while",
  "if",
  "until",
  "case",
  "select",
  "then",
  "else",
  "elif",
  "fi",
  "done",
  "esac",
  "do",
]);

/** A token that stands alone (`2>&1`, `>&2`) — dropped, no filename argument follows it. */
const FD_DUP_REDIRECT = /^\d*>&\d+$/;
/** A token that redirects and consumes the FOLLOWING token as its target filename. */
const REDIRECT_WITH_TARGET = /^(\d*>{1,2}|\d*<{1,2}|&>{1,2})$/;

/**
 * Matches a fd-duplication redirect operator (`2>&1`, `>&2`, `1>&2`) at the
 * START of a string that may have more text following it (a filename, or —
 * in the attached-redirect scan — trailing characters that were never
 * actually part of the operator). Used by `isStdoutFileRedirectOperator` to
 * rule these out before testing for a genuine stdout-to-file redirect, since
 * `>&2`'s leading `>` would otherwise look identical to a real `>file`.
 */
const FD_DUP_PREFIX = /^\d*>&\d+/;
/**
 * Matches a redirect operator that diverts STDOUT to a file — unnumbered
 * `>`/`>>`, explicit `1>`/`1>>`, or the combined `&>`/`&>>` (stdout+stderr)
 * — at the START of a string that may have more text following it (a
 * filename). The `(?!&)` guard keeps a bare `>` from matching the `>` in
 * `>&2`; callers are expected to check `FD_DUP_PREFIX` first regardless.
 */
const STDOUT_TARGET_PREFIX = /^(1?>{1,2}(?!&)|&>{1,2})/;

/**
 * Classify a redirect operator — either the whole operator token (the
 * standalone-token path) or an operator immediately followed by more text
 * such as a filename (the attached-redirect path) — as one that diverts
 * STDOUT to a file, per the stdout-only semantics documented on
 * `ShellSegment.hasOutputRedirect`.
 *
 * True only for unnumbered `>`/`>>`, explicit `1>`/`1>>`, and the combined
 * `&>`/`&>>` forms. False for another fd's redirect alone (`2>`, `2>>`, ...)
 * — stdout isn't touched, so it still reaches the tool result — and false
 * for a pure fd-duplication (`2>&1`, `>&2`, `1>&2`), which keeps output
 * within a stream the agent still receives rather than sending it to a
 * file. Also false for any `<`-led input redirect.
 */
function isStdoutFileRedirectOperator(text: string): boolean {
  if (FD_DUP_PREFIX.test(text)) return false;
  return STDOUT_TARGET_PREFIX.test(text);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One `|`/`&&`/`||`/`;`-delimited slice of a shell command line. */
export interface ShellSegment {
  /** This segment's original text, trimmed. Empty for a segment produced by malformed/empty input (e.g. a trailing separator). */
  raw: string;
  /** Leading `FOO=bar` assignments before the (possibly wrapper-wrapped) executable, quotes already stripped from the value. */
  envAssignments: string[];
  /**
   * The meaningful executable for this segment, after skipping leading env
   * assignments and unwrapping known wrapper commands (`env`, `time`,
   * `nice`, `command`, `xargs` — so `xargs grep` reads as `grep`).
   * `undefined` when the segment is empty, is env-assignments-only (e.g. a
   * bare `FOO=bar`), or a wrapper command with nothing after it.
   */
  executable?: string;
  /**
   * First argument after `executable` that doesn't start with `-`, ONLY when
   * `executable` is one of `KNOWN_COMMAND_FAMILIES` — e.g. `git diff --stat`
   * yields `"diff"`. See the module doc comment for the `git -C <dir>`-style
   * limitation.
   */
  subcommand?: string;
  /** Remaining tokens after `executable` (or after the control keyword), redirect tokens and their filename targets already stripped — both standalone, space-separated forms (`> out.txt`) and attached, no-space forms (`>out.txt`, `2>out.txt`, `&>out.txt`) via `findAttachedRedirectStart`. Best-effort — not a fully parsed argv. */
  args: string[];
  /** Set instead of `executable`/`subcommand` when this segment's first token is a shell control-flow keyword — see `CONTROL_KEYWORDS`. */
  controlKeyword?: string;
  /**
   * `true` when a redirect that diverts STDOUT to a file — unnumbered
   * `>file`/`>>file`, explicit `1>file`/`1>>file`, or the combined
   * `&>file`/`&>>file` (which redirects both stdout and stderr) — was
   * stripped from this segment, spaced or attached.
   *
   * NOT set for another fd's redirect alone, e.g. `2>file`/`2>>file`
   * (stderr-only — stdout still reaches the tool result), and NOT set for a
   * pure fd-duplication like `2>&1`, `>&2`, or `1>&2` (these keep output
   * within a stream the agent still receives, they don't send it to a
   * file). Also not set for an input `<` redirect.
   *
   * Consumers use this to tell "this command's stdout is visible in the
   * tool result" apart from "this command's stdout was sent to a file
   * instead" — see `bash-stats.ts`'s `isBashAsRead`, which a
   * stdout-redirecting `cat`/`head`/etc should NOT be flagged by, but a
   * stderr-only redirect (`cat foo.log 2>/dev/null`) SHOULD still be, since
   * the file content (stdout) still reaches the agent.
   */
  hasOutputRedirect?: boolean;
}

export interface ParsedShellCommand {
  segments: ShellSegment[];
}

interface LexToken {
  type: "word" | "op";
  value: string;
  start: number;
  end: number;
}

type Operator = "|" | "||" | "&&" | ";";

/**
 * Scan a balanced `(...)` span starting at `openIndex` (the index of the
 * opening `(` itself), returning the matched text (including both
 * parentheses) and the index just past the closing `)`. Used for `$(...)`,
 * `<(...)`, and `>(...)` — the span is copied verbatim into the current
 * token, never recursed into, so a `;`/`|`/`&&` inside a command
 * substitution can't corrupt the outer segment split.
 */
function consumeParenSpan(input: string, openIndex: number): { text: string; next: number } {
  const n = input.length;
  let depth = 1;
  let j = openIndex + 1;
  while (j < n && depth > 0) {
    const c = input[j];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    j += 1;
  }
  return { text: input.slice(openIndex, j), next: j };
}

/** Scan a backtick command-substitution span starting at the opening backtick, tolerating `\`-escapes inside it. */
function consumeBacktickSpan(input: string, openIndex: number): { text: string; next: number } {
  const n = input.length;
  let j = openIndex + 1;
  while (j < n && input[j] !== "`") {
    j += input[j] === "\\" && j + 1 < n ? 2 : 1;
  }
  if (j < n) j += 1; // consume the closing backtick
  return { text: input.slice(openIndex, j), next: j };
}

const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/**
 * Tokenize a full command line into words and the four pipeline/list
 * operators (`|`, `||`, `&&`, `;`). Quote/subshell-aware: nothing inside
 * `'...'`, `"..."`, `$(...)`, `<(...)`, `>(...)`, or `` `...` `` is ever
 * treated as an operator or a word boundary. A bare `&` (backgrounding) is
 * deliberately NOT an operator here — only `&&` is — so it doesn't corrupt
 * redirect tokens like `2>&1` or `&>file`; see the module doc comment.
 */
function lex(input: string): LexToken[] {
  const tokens: LexToken[] = [];
  const n = input.length;
  let i = 0;
  let buf = "";
  let active = false;
  let wordStart = -1;

  const pushWord = (end: number) => {
    if (active) {
      tokens.push({ type: "word", value: buf, start: wordStart, end });
      buf = "";
      active = false;
      wordStart = -1;
    }
  };
  const begin = (at: number) => {
    if (!active) wordStart = at;
    active = true;
  };
  const pushOp = (value: Operator, start: number, end: number) => {
    tokens.push({ type: "op", value, start, end });
  };

  while (i < n) {
    const c = input[i];

    if (c === " " || c === "\t" || c === "\n") {
      pushWord(i);
      i += 1;
      continue;
    }

    if (c === ";") {
      pushWord(i);
      pushOp(";", i, i + 1);
      i += 1;
      continue;
    }

    if (c === "|") {
      pushWord(i);
      if (input[i + 1] === "|") {
        pushOp("||", i, i + 2);
        i += 2;
      } else {
        pushOp("|", i, i + 1);
        i += 1;
      }
      continue;
    }

    if (c === "&" && input[i + 1] === "&") {
      pushWord(i);
      pushOp("&&", i, i + 2);
      i += 2;
      continue;
    }

    if (c === "'") {
      begin(i);
      i += 1;
      while (i < n && input[i] !== "'") {
        buf += input[i];
        i += 1;
      }
      i += 1; // tolerate an unterminated quote (i may overshoot n harmlessly)
      continue;
    }

    if (c === '"') {
      begin(i);
      i += 1;
      while (i < n && input[i] !== '"') {
        const cur = input[i];
        if (cur === "\\" && i + 1 < n && DOUBLE_QUOTE_ESCAPABLE.has(input[i + 1] ?? "")) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        if (cur === "$" && input[i + 1] === "(") {
          const { text, next } = consumeParenSpan(input, i + 1);
          buf += `$${text}`;
          i = next;
          continue;
        }
        if (cur === "`") {
          const { text, next } = consumeBacktickSpan(input, i);
          buf += text;
          i = next;
          continue;
        }
        buf += cur;
        i += 1;
      }
      i += 1; // tolerate an unterminated quote
      continue;
    }

    if ((c === "$" || c === "<" || c === ">") && input[i + 1] === "(") {
      begin(i);
      const { text, next } = consumeParenSpan(input, i + 1);
      buf += c + text;
      i = next;
      continue;
    }

    if (c === "`") {
      begin(i);
      const { text, next } = consumeBacktickSpan(input, i);
      buf += text;
      i = next;
      continue;
    }

    if (c === "\\" && i + 1 < n) {
      begin(i);
      buf += input[i + 1];
      i += 2;
      continue;
    }

    begin(i);
    buf += c;
    i += 1;
  }
  pushWord(n);
  return tokens;
}

/**
 * Scan a single lexed WORD token's raw (pre-dequote) source slice for the
 * first unquoted position where an attached (no-space) redirect operator
 * begins — `>`, `>>`, a digit-prefixed fd form (`2>`), or `&>`/`&>>` — so
 * `pnpm test>out.txt` and `cat foo.log>out.txt` can be split into their real
 * word plus a dropped redirect, the same way `pnpm test > out.txt` already
 * is via `REDIRECT_WITH_TARGET`.
 *
 * Quote/span tracking mirrors `lex()` itself (single quotes, double quotes
 * with `\`-escapes and nested `$()`/backtick spans, and `$()`/`<()`/`>()`/
 * backtick spans) so a `>` that only exists inside quoted text — the `a>b`
 * in `echo "a>b"` — is never treated as a redirect: this function only ever
 * returns an index reached through the same "not currently inside a
 * quote/span" branch `lex()` uses for real operators. (This duplicates a
 * slice of `lex()`'s quote-tracking rather than reusing it directly — by the
 * time a token reaches here it's already a fully dequoted `string`, with no
 * per-character record of which original characters were quoted, so the raw
 * source slice has to be re-scanned independently. Known limitation: this
 * is a second, hand-kept-in-sync copy of that logic.)
 *
 * A digit or `&` prefix only counts as part of the redirect operator when it
 * sits at the very START of the token (real shell fd-redirect syntax — the
 * fd number/`&` must be its own token, not glued onto a preceding word:
 * `results2>out.txt` is the word `results2` plus a plain `>` redirect, not
 * an fd-2 redirect) — signaled by returning `0` instead of the `>`/`<`
 * character's own index, so the caller drops the digit/`&` prefix too.
 *
 * Returns `undefined` when the token has no unquoted `>`/`<` at all.
 */
function findAttachedRedirectStart(raw: string): number | undefined {
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const c = raw[i];

    if (c === "'") {
      i += 1;
      while (i < n && raw[i] !== "'") i += 1;
      i += 1; // tolerate an unterminated quote
      continue;
    }

    if (c === '"') {
      i += 1;
      while (i < n && raw[i] !== '"') {
        if (raw[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (raw[i] === "$" && raw[i + 1] === "(") {
          const { next } = consumeParenSpan(raw, i + 1);
          i = next;
          continue;
        }
        if (raw[i] === "`") {
          const { next } = consumeBacktickSpan(raw, i);
          i = next;
          continue;
        }
        i += 1;
      }
      i += 1; // tolerate an unterminated quote
      continue;
    }

    if ((c === "$" || c === "<" || c === ">") && raw[i + 1] === "(") {
      const { next } = consumeParenSpan(raw, i + 1);
      i = next;
      continue;
    }

    if (c === "`") {
      const { next } = consumeBacktickSpan(raw, i);
      i = next;
      continue;
    }

    if (c === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }

    if (c === ">" || c === "<") {
      if (i > 0) {
        const prefix = raw.slice(0, i);
        if (/^\d+$/.test(prefix) || prefix === "&") return 0;
      }
      return i;
    }

    i += 1;
  }
  return undefined;
}

/**
 * Strip redirect tokens (and, for the ones that take one, their filename
 * target) from an already-tokenized arg list — both standalone,
 * space-separated forms (`pnpm test > out.txt`) and attached, no-space forms
 * (`pnpm test>out.txt`, `2>out.txt`, `&>out.txt`) found via
 * `findAttachedRedirectStart`. `sources` is the RAW (pre-dequote) source
 * text for each entry in `values`, same length/order — required so the
 * attached-redirect scan can tell a genuine unquoted `>` apart from one that
 * only exists inside quoted text (see `findAttachedRedirectStart`'s doc
 * comment).
 *
 * Also reports `hasOutputRedirect`: whether a redirect diverting STDOUT to a
 * file (unnumbered `>`/`>>`, explicit `1>`/`1>>`, or the combined `&>`/`&>>`
 * — spaced or attached) was found. NOT set for another fd's redirect alone
 * (`2>`, `2>>`, ...), NOT set for a pure fd-duplication (`2>&1`, `>&2`,
 * `1>&2`), and NOT set for an input `<` redirect — see the
 * `hasOutputRedirect` TSDoc on `ShellSegment` for the full rationale. So
 * callers can tell a command that's genuinely printing to its result apart
 * from one redirecting its output elsewhere.
 */
function stripRedirects(
  values: readonly string[],
  sources: readonly string[],
): { args: string[]; hasOutputRedirect: boolean } {
  const result: string[] = [];
  let hasOutputRedirect = false;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === undefined) continue;
    if (FD_DUP_REDIRECT.test(v)) continue;
    if (REDIRECT_WITH_TARGET.test(v)) {
      if (isStdoutFileRedirectOperator(v)) hasOutputRedirect = true;
      i += 1; // also drop the filename target, if any
      continue;
    }
    const raw = sources[i] ?? v;
    const splitAt = findAttachedRedirectStart(raw);
    if (splitAt === undefined) {
      result.push(v);
      continue;
    }
    if (isStdoutFileRedirectOperator(raw.slice(splitAt))) hasOutputRedirect = true;
    if (splitAt > 0) {
      const relexed = lex(raw.slice(0, splitAt));
      const word = relexed[0]?.value;
      if (word !== undefined) result.push(word);
    }
    // splitAt === 0: the whole token is an attached redirect (optionally
    // fd-/`&`-prefixed) with no real word content — dropped entirely, same
    // as a standalone `REDIRECT_WITH_TARGET` token above.
  }
  return { args: result, hasOutputRedirect };
}

interface ResolvedExecutable {
  envAssignments: string[];
  executable?: string;
  /** Index into the segment's token array of `executable`, when found. */
  executableIndex?: number;
}

/**
 * Walk a segment's tokens past leading `FOO=bar` assignments and any known
 * wrapper commands (recursively — `time env FOO=bar nice -n5 make` unwraps
 * all three) to find the meaningful executable.
 */
function resolveExecutable(tokens: readonly string[]): ResolvedExecutable {
  const envAssignments: string[] = [];
  let idx = 0;

  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t !== undefined && ENV_ASSIGNMENT.test(t)) {
      envAssignments.push(t);
      idx += 1;
    } else {
      break;
    }
  }

  for (;;) {
    const t = idx < tokens.length ? tokens[idx] : undefined;
    if (t === undefined || !WRAPPER_COMMANDS.has(t)) break;
    const wrapper = t;
    idx += 1;
    while (idx < tokens.length) {
      const cur = tokens[idx];
      if (cur === undefined) break;
      if (wrapper === "env" && ENV_ASSIGNMENT.test(cur)) {
        envAssignments.push(cur);
        idx += 1;
        continue;
      }
      if (cur.startsWith("-")) {
        if (wrapper === "nice" && NICE_VALUE_FLAGS.has(cur)) {
          idx += 2;
          continue;
        }
        if (wrapper === "xargs" && XARGS_VALUE_FLAGS.has(cur)) {
          idx += 2;
          continue;
        }
        idx += 1;
        continue;
      }
      break;
    }
    // Loop again: the token now at `idx` might itself be another wrapper.
  }

  const executable = idx < tokens.length ? tokens[idx] : undefined;
  return {
    envAssignments,
    ...(executable !== undefined && { executable, executableIndex: idx }),
  };
}

function buildSegment(
  rawTokens: readonly string[],
  tokenSources: readonly string[],
  raw: string,
): ShellSegment {
  if (rawTokens.length === 0) {
    return { raw, envAssignments: [], args: [] };
  }

  const first = rawTokens[0];
  if (first !== undefined && CONTROL_KEYWORDS.has(first)) {
    return { raw, envAssignments: [], args: rawTokens.slice(1), controlKeyword: first };
  }

  const { envAssignments, executable, executableIndex } = resolveExecutable(rawTokens);
  if (executable === undefined || executableIndex === undefined) {
    return { raw, envAssignments, args: [] };
  }

  const { args, hasOutputRedirect } = stripRedirects(
    rawTokens.slice(executableIndex + 1),
    tokenSources.slice(executableIndex + 1),
  );
  const subcommand = KNOWN_COMMAND_FAMILIES.has(executable)
    ? args.find((a) => !a.startsWith("-"))
    : undefined;

  return {
    raw,
    envAssignments,
    executable,
    ...(subcommand !== undefined && { subcommand }),
    args,
    ...(hasOutputRedirect && { hasOutputRedirect: true }),
  };
}

/**
 * Parse a full shell command line into `|`/`&&`/`||`/`;`-delimited segments,
 * each best-effort broken down into env assignments, the meaningful
 * executable, its subcommand (for known families), and remaining args. See
 * the module doc comment for the simplifications this makes.
 */
export function parseShellCommand(command: string): ParsedShellCommand {
  if (command.trim() === "") return { segments: [] };

  const tokens = lex(command);
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  // Raw (pre-dequote) source slice for each entry in `words`, same
  // length/order — lets `stripRedirects` distinguish an unquoted attached
  // redirect from one that only exists inside quoted text.
  let wordSources: string[] = [];
  let segStart: number | undefined;
  let segEnd: number | undefined;

  const flush = () => {
    const raw =
      segStart !== undefined && segEnd !== undefined ? command.slice(segStart, segEnd).trim() : "";
    segments.push(buildSegment(words, wordSources, raw));
    words = [];
    wordSources = [];
    segStart = undefined;
    segEnd = undefined;
  };

  for (const tok of tokens) {
    if (tok.type === "op") {
      flush();
      continue;
    }
    if (segStart === undefined) segStart = tok.start;
    segEnd = tok.end;
    words.push(tok.value);
    wordSources.push(command.slice(tok.start, tok.end));
  }
  flush();

  return { segments };
}

/**
 * The one segment a whole (possibly piped/chained) Bash call should be
 * attributed to. Two-tier selection, applied uniformly whether the segments
 * came from a pipe or a `;`/`&&`/`||` chain — `parseShellCommand` flattens
 * every operator into the same segment list and doesn't record which one
 * separated a given pair, so attribution can't distinguish chain types, and
 * skip-the-trivial-segments-first is the right call for both: a pipe's
 * earlier stages and a sequence's earlier statements are equally capable of
 * being a throwaway `echo`/`cd` ahead of the command that actually produced
 * the result.
 *
 *  1. Prefer the first segment whose `executable` is defined and is NOT in
 *     `NEAR_ZERO_OUTPUT_COMMANDS` — e.g. `cd X; echo "==="; cat -n file`
 *     skips `cd` and `echo` to land on `cat`, and `echo "$x" | jq .foo` skips
 *     `echo` to land on `jq`.
 *  2. If no segment qualifies under (1) — every segment is trivial,
 *     unresolved, or `cd` — fall back to the original rule: the first
 *     segment with a resolved `executable` that isn't `cd`. This keeps a
 *     lone trivial command attributed to itself (`echo hi` alone → `echo`)
 *     rather than falling through to "(unparsed)".
 *
 * Segments that are empty, env-assignment-only, or an unresolved pure
 * wrapper already carry `executable: undefined` (see `resolveExecutable`),
 * so no separate check is needed for those beyond the `cd` exclusion in (2).
 * `undefined` when no segment qualifies under either tier (e.g. `cd /foo`
 * alone, or a control-flow-only command).
 */
export function primaryCommand(parsed: ParsedShellCommand): ShellSegment | undefined {
  const nonTrivial = parsed.segments.find(
    (seg) => seg.executable !== undefined && !NEAR_ZERO_OUTPUT_COMMANDS.has(seg.executable),
  );
  if (nonTrivial !== undefined) return nonTrivial;
  return parsed.segments.find((seg) => seg.executable !== undefined && seg.executable !== "cd");
}

export {
  KNOWN_COMMAND_FAMILIES,
  NEAR_ZERO_OUTPUT_COMMANDS,
  WRAPPER_COMMANDS as KNOWN_WRAPPER_COMMANDS,
};
