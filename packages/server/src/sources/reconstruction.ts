/**
 * Filesystem-backed providers for the Goshuin Phase C "virtual wire"
 * reconstruction layer (`@junrei/core`'s `claude/reconstruction/`). Both
 * providers here are pure I/O adapters over the `ReconstructionTemplateProvider`
 * / `DiskContextProvider` interfaces `reconstructRequest` takes — the
 * reconstruction RULES all live in core; this module only knows how to find
 * bytes on disk.
 *
 * Both constructors take injectable roots so tests never touch the real
 * `~/.junrei`/`~/.claude` — see `FilesystemTemplateProviderOptions` and
 * `FilesystemDiskContextProviderOptions`.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DiskContext,
  type DiskContextFile,
  type DiskContextProvider,
  parseReconstructionTemplate,
  type ReconstructionSessionMeta,
  type ReconstructionTemplate,
  type ReconstructionTemplateProvider,
  resolveClaudeProjectsDirs,
} from "@junrei/core";

/**
 * Default template library root, per Decision 4
 * (docs/milestones/goshuin.md): USER-LOCAL, never the repo.
 * `JUNREI_TEMPLATES_DIR` overrides it — same override-by-env convention as
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, which is also how `mcp.test.ts` injects
 * fixtures for the OTHER session sources, so tests here follow suit.
 */
export function resolveTemplatesDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.JUNREI_TEMPLATES_DIR;
  return fromEnv !== undefined && fromEnv.trim() !== ""
    ? fromEnv
    : join(homedir(), ".junrei", "templates");
}

export interface FilesystemTemplateProviderOptions {
  /** Override the templates root dir — for tests. Defaults to `resolveTemplatesDir()`. */
  templatesDir?: string;
}

/**
 * Reads `<templatesDir>/<cliVersion>/template.json` (Decision 4's documented
 * on-disk layout) and validates it through core's `parseReconstructionTemplate`.
 * A missing, unreadable, or malformed template all degrade to `undefined` —
 * `reconstructRequest` maps that to the `unknown` confidence class for the
 * affected blocks (never invents a template).
 */
export function createFilesystemTemplateProvider(
  opts: FilesystemTemplateProviderOptions = {},
): ReconstructionTemplateProvider {
  const templatesDir = opts.templatesDir ?? resolveTemplatesDir();
  return {
    async getTemplate(cliVersion: string): Promise<ReconstructionTemplate | undefined> {
      const filePath = join(templatesDir, cliVersion, "template.json");
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        return undefined;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return undefined;
      }
      return parseReconstructionTemplate(json);
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read one disk-context file whole, with its mtime — `undefined` when missing/unreadable. */
async function readDiskFile(path: string): Promise<DiskContextFile | undefined> {
  try {
    const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { path, content, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/** `~/.claude.json` → `oauthAccount.emailAddress` + that file's own mtime, for drift detection. */
async function readAccountEmail(
  accountFilePath: string,
): Promise<{ email?: string; emailMtimeMs?: number }> {
  try {
    const [raw, info] = await Promise.all([
      readFile(accountFilePath, "utf8"),
      stat(accountFilePath),
    ]);
    const parsed: unknown = JSON.parse(raw);
    const email =
      typeof parsed === "object" && parsed !== null && "oauthAccount" in parsed
        ? (parsed as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress
        : undefined;
    return typeof email === "string" && email !== "" ? { email, emailMtimeMs: info.mtimeMs } : {};
  } catch {
    return {};
  }
}

export interface FilesystemDiskContextProviderOptions {
  /**
   * The session's own munged project directory name under `projects/`
   * (`ClaudeSessionFileRef.projectDirName` / `ClaudeSessionAnalysis
   * .projectDirName`) — needed to locate `memory/MEMORY.md`. Bound once at
   * construction time since `DiskContextProvider.getDiskContext`'s own
   * argument (`ReconstructionSessionMeta`) carries no project-dir field (only
   * `cwd`/`sessionId`/`cliVersion` — none of which are reversible to the
   * munged form; see `discovery.ts`'s doc comment on `projectDirName`).
   * `memoryMd` stays absent when omitted.
   */
  projectDirName?: string;
  /**
   * Override candidate Claude config dirs' `projects/` resolution — for
   * tests, so they never touch the real `~/.claude`. Defaults to core's
   * `resolveClaudeProjectsDirs` (which itself already respects
   * `CLAUDE_CONFIG_DIR`, the SAME env var `mcp.test.ts` already overrides for
   * every other Claude source — no separate seam needed for the common case).
   */
  resolveProjectsDirs?: () => Promise<string[]>;
  /** Override `~/.claude.json`'s path — for tests. */
  accountFilePath?: string;
}

/**
 * Rebuilds the disk-contingent CLAUDE.md/memory/userEmail/currentDate
 * `<system-reminder>` block's INPUTS from current disk state (Decision 3):
 * global `~/.claude/CLAUDE.md`, the project's own `CLAUDE.md` (at the
 * session's `cwd`), the auto-memory `MEMORY.md`, and the account email from
 * `~/.claude.json`. `currentDate` itself is NOT read here — it's derived
 * from the request's own log timestamp (`disk-context.ts`'s
 * `deriveCurrentDate`, a log-derived input, not a disk one).
 *
 * Every file carries its own mtime so `reconstructRequest`
 * (`disk-context.ts`'s `renderClaudeMdContextBlock`) can flag
 * `driftDetected` when a contributing file was modified after the session
 * started — this provider itself never compares timestamps, it only reports
 * them.
 *
 * Never returns `undefined` — an empty/partial `DiskContext` (e.g. no global
 * CLAUDE.md found) still degrades correctly downstream (the block declares
 * itself `unknown` with a specific reason); `undefined` from
 * `DiskContextProvider.getDiskContext` is reserved for "no provider was
 * injected at all", a distinct case this provider is never in.
 */
export function createFilesystemDiskContextProvider(
  opts: FilesystemDiskContextProviderOptions = {},
): DiskContextProvider {
  const resolveProjectsDirs = opts.resolveProjectsDirs ?? (() => resolveClaudeProjectsDirs());
  const accountFilePath = opts.accountFilePath ?? join(homedir(), ".claude.json");
  const projectDirName = opts.projectDirName;

  return {
    async getDiskContext(session: ReconstructionSessionMeta): Promise<DiskContext> {
      const projectsDirs = await resolveProjectsDirs();

      // Pick the candidate `projects/` dir that actually contains this
      // session's own project dir, when we know which one that is — a
      // `CLAUDE_CONFIG_DIR` with multiple comma-separated entries (see
      // `resolveClaudeProjectsDirs`) can otherwise point `claudeHomeDir` at
      // the wrong sibling. Falls back to the first candidate so a global
      // CLAUDE.md/email lookup still works even when the project dir can't
      // be located (memory alone degrades to absent in that case).
      let projectsDir = projectsDirs[0];
      if (projectDirName !== undefined) {
        for (const candidate of projectsDirs) {
          if (await pathExists(join(candidate, projectDirName))) {
            projectsDir = candidate;
            break;
          }
        }
      }

      const [globalClaudeMd, projectClaudeMd, memoryMd, account] = await Promise.all([
        projectsDir !== undefined
          ? readDiskFile(join(dirname(projectsDir), "CLAUDE.md"))
          : Promise.resolve(undefined),
        session.cwd !== undefined
          ? readDiskFile(join(session.cwd, "CLAUDE.md"))
          : Promise.resolve(undefined),
        projectsDir !== undefined && projectDirName !== undefined
          ? readDiskFile(join(projectsDir, projectDirName, "memory", "MEMORY.md"))
          : Promise.resolve(undefined),
        readAccountEmail(accountFilePath),
      ]);

      return {
        ...(globalClaudeMd !== undefined && { globalClaudeMd }),
        ...(projectClaudeMd !== undefined && { projectClaudeMd }),
        ...(memoryMd !== undefined && { memoryMd }),
        ...(account.email !== undefined && { email: account.email }),
        ...(account.emailMtimeMs !== undefined && { emailMtimeMs: account.emailMtimeMs }),
      };
    },
  };
}
