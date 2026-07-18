/**
 * The disk-contingent CLAUDE.md / memory / userEmail / currentDate reminder
 * block (Decision 3). NONE of this block is stored in the session log — every
 * input comes from a local file (global/project `CLAUDE.md`, auto-memory
 * `MEMORY.md`, the account email from `~/.claude.json`) except `currentDate`,
 * which is derived from the request's own recorded log timestamp. The renderer
 * itself is a faithful port of the calibrated reconstruction script; it
 * reproduces the block byte-for-byte WHEN disk hasn't drifted since the session
 * ran. Because that "when" is not guaranteed, the block is labelled
 * `disk-contingent` and carries a machine-readable `driftDetected` flag.
 */

import type { DiskContext, DiskFileProvenance } from "./types.js";

export interface RenderedDiskContextBlock {
  /** The full `<system-reminder>…</system-reminder>` block text. */
  text: string;
  /** Per-file provenance (presence, path, mtime, per-file drift). */
  files: DiskFileProvenance[];
  /** True when ANY contributing file may have drifted since the session started. */
  driftDetected: boolean;
}

/**
 * currentDate line value. Derived from the target request's own recorded log
 * timestamp (a log-derived input), rendered as an ISO calendar date in UTC. The
 * wire uses the harness machine's LOCAL date, which can differ by a day at
 * timezone boundaries — that residual uncertainty is folded into the block's
 * `disk-contingent` label rather than asserted away.
 */
export function deriveCurrentDate(isoTimestamp: string | undefined): string | undefined {
  if (isoTimestamp === undefined || isoTimestamp === "") return undefined;
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

/** A file's mtime is after session start ⇒ it may differ from what the session saw. */
function fileDrift(mtimeMs: number | undefined, sessionStartMs: number | undefined): boolean {
  if (mtimeMs === undefined || sessionStartMs === undefined) return false;
  return mtimeMs > sessionStartMs;
}

/**
 * Rebuild the reminder block from current disk state. Returns `undefined` when
 * the block is unrecoverable — the global `CLAUDE.md` or the account email is
 * missing (both always present on the wire) — so the caller can declare the
 * block `unknown` instead of emitting a partial one.
 */
export function renderClaudeMdContextBlock(
  ctx: DiskContext,
  opts: { dateStr: string; sessionStartMs?: number },
): RenderedDiskContextBlock | undefined {
  const { globalClaudeMd, projectClaudeMd, memoryMd, email } = ctx;
  if (globalClaudeMd === undefined) return undefined;
  if (email === undefined || email === "") return undefined;

  const files: DiskFileProvenance[] = [];
  const globalDrift = fileDrift(globalClaudeMd.mtimeMs, opts.sessionStartMs);
  files.push({
    role: "global-claude-md",
    path: globalClaudeMd.path,
    present: true,
    ...(globalClaudeMd.mtimeMs !== undefined && { mtimeMs: globalClaudeMd.mtimeMs }),
    driftDetected: globalDrift,
  });

  let body = "# claudeMd\n";
  body +=
    "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n";
  body += `Contents of ${globalClaudeMd.path} (user's private global instructions for all projects):\n\n`;
  body += globalClaudeMd.content;

  let anyDrift = globalDrift;

  if (projectClaudeMd !== undefined) {
    if (!body.endsWith("\n")) body += "\n";
    body += `\nContents of ${projectClaudeMd.path} (project instructions, checked into the codebase):\n\n`;
    body += projectClaudeMd.content;
    const drift = fileDrift(projectClaudeMd.mtimeMs, opts.sessionStartMs);
    anyDrift = anyDrift || drift;
    files.push({
      role: "project-claude-md",
      path: projectClaudeMd.path,
      present: true,
      ...(projectClaudeMd.mtimeMs !== undefined && { mtimeMs: projectClaudeMd.mtimeMs }),
      driftDetected: drift,
    });
  }

  if (memoryMd !== undefined) {
    if (!body.endsWith("\n")) body += "\n";
    body += `\nContents of ${memoryMd.path} (user's auto-memory, persists across conversations):\n\n`;
    body += memoryMd.content;
    const drift = fileDrift(memoryMd.mtimeMs, opts.sessionStartMs);
    anyDrift = anyDrift || drift;
    files.push({
      role: "memory",
      path: memoryMd.path,
      present: true,
      ...(memoryMd.mtimeMs !== undefined && { mtimeMs: memoryMd.mtimeMs }),
      driftDetected: drift,
    });
  }

  if (!body.endsWith("\n")) body += "\n";
  body += `# userEmail\nThe user's email address is ${email}.\n`;
  body += `# currentDate\nToday's date is ${opts.dateStr}.\n`;
  body +=
    "\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n";

  const emailDrift = fileDrift(ctx.emailMtimeMs, opts.sessionStartMs);
  anyDrift = anyDrift || emailDrift;
  files.push({
    role: "email",
    present: true,
    ...(ctx.emailMtimeMs !== undefined && { mtimeMs: ctx.emailMtimeMs }),
    driftDetected: emailDrift,
  });

  const text = `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${body}</system-reminder>\n\n`;
  return { text, files, driftDetected: anyDrift };
}
