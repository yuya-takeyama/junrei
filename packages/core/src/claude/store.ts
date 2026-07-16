/**
 * Domain-shaped storage abstraction for Claude Code session data — every
 * filesystem touch in this module (`parser.ts`, `subagents.ts`,
 * `workflows.ts`, `analyze.ts`) goes through a `ClaudeSessionStore` instead of
 * calling `node:fs` directly, so a session's transcript/sidecars can live
 * somewhere other than the local `~/.claude/projects/` tree — e.g. an S3
 * bucket a remote Agent SDK environment writes to (see `@junrei/server`'s
 * `sources/s3-store.ts`).
 *
 * `ClaudeSessionFileRef.filePath` is treated as a STORE-SCOPED URI: an
 * absolute local path for `LocalClaudeSessionStore`, an `s3://bucket/key` URI
 * for an S3 store. Every method here takes/returns that same opaque string —
 * callers never construct or parse a `filePath` themselves except by asking
 * the store that owns it (`listSessionFiles`/`findSessionFileById`/
 * `listSidecarFiles`), so a ref from one store can never be silently handed
 * to another.
 */

import { createReadStream, type Dirent } from "node:fs";
import { readFile as fsReadFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  type ClaudeSessionFileRef,
  findClaudeSessionFileById,
  listClaudeSessionFiles,
  resolveClaudeProjectsDirs,
} from "./discovery.js";
import { joinPath, subagentsDirFor, workflowsDirFor } from "./paths.js";

/** One sidecar file's identity — see `ClaudeSessionStore.listSidecarFiles`. */
export interface ClaudeSidecarFileRef {
  /** Store-scoped URI, same convention as `ClaudeSessionFileRef.filePath`. */
  path: string;
  /**
   * Last-modified time, epoch ms — the freshness signal `@junrei/server`'s
   * `getClaudeLastActivityAt` folds in alongside the main transcript's own
   * mtime, so a session with a quiet main transcript but an actively-writing
   * subagent/workflow run still reads as live.
   */
  mtimeMs: number;
  sizeBytes: number;
  /**
   * Opaque change token for cache invalidation — same convention as
   * `ClaudeSessionFileRef.changeToken`. Local: `String(mtimeMs)`. S3:
   * the object's `ETag` (fallback `LastModified:Size`) — 1-second
   * `mtimeMs` precision alone can't distinguish two writes within the same
   * second, which `findAgentRef` in `@junrei/server`'s `sources/claude.ts`
   * relies on this token to do instead.
   */
  changeToken: string;
}

export interface ClaudeSessionStore {
  /**
   * List every session transcript file this store knows about, newest first
   * — a single S3 LIST sweep answers this for an S3-backed store (see
   * `sources/s3-store.ts`), the same sweep `findSessionFileById` and
   * `listSidecarFiles` reuse.
   */
  listSessionFiles(): Promise<ClaudeSessionFileRef[]>;
  /** Resolve one session's file ref by bare session id, `undefined` if unknown. */
  findSessionFileById(sessionId: string): Promise<ClaudeSessionFileRef | undefined>;
  /**
   * Stream a file's lines — the main transcript or a JSONL sidecar. Rejects
   * (on first iteration) if the file doesn't exist or can't be read; callers
   * are expected to handle that the same way they always have (a rejected
   * promise from the consuming `for await`).
   */
  openLines(filePath: string): AsyncIterable<string>;
  /** Read a small file whole — a subagent's `.meta.json` or a workflow run's `<runId>.json`. */
  readFile(filePath: string): Promise<string>;
  /**
   * List every sidecar file for a main session file — everything under
   * `<sessionDir>/subagents/` (recursively, including the nested
   * `subagents/workflows/<runId>/` Workflow-tool layout) and
   * `<sessionDir>/workflows/` (recursively, though only the direct `*.json`
   * children are ever meaningful — see `workflows.ts`'s `listWorkflowRuns`).
   * Flat list; callers interpret path structure themselves (regex on
   * basename/dirname) so the store stays domain-agnostic about what a
   * "subagent" or "workflow run" is. Missing directories contribute no
   * entries — never throws.
   */
  listSidecarFiles(mainFilePath: string): Promise<ClaudeSidecarFileRef[]>;
}

/** Recursively list every FILE (not directory) under `dir`, with mtime. Missing/unreadable `dir` yields `[]`. */
async function walkFiles(dir: string): Promise<ClaudeSidecarFileRef[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: ClaudeSidecarFileRef[] = [];
  for (const entry of entries) {
    const entryPath = joinPath(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      try {
        const info = await stat(entryPath);
        files.push({
          path: entryPath,
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          changeToken: String(info.mtimeMs),
        });
      } catch {
        // Race with deletion — skip.
      }
    }
  }
  return files;
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) yield line;
}

/**
 * The local filesystem implementation — a pure refactor of the discovery/fs
 * code that always ran directly against `~/.claude/projects/` (or
 * `CLAUDE_CONFIG_DIR`); behavior is byte-for-byte unchanged; only the call
 * shape moved behind this interface. `resolveClaudeProjectsDirs()` is called
 * fresh on every `listSessionFiles`/`findSessionFileById` (matching the
 * existing free-function behavior of re-reading `CLAUDE_CONFIG_DIR` etc. on
 * every call, not caching it at construction time).
 */
function createLocalClaudeSessionStore(): ClaudeSessionStore {
  return {
    async listSessionFiles(): Promise<ClaudeSessionFileRef[]> {
      const dirs = await resolveClaudeProjectsDirs();
      return listClaudeSessionFiles(dirs);
    },
    async findSessionFileById(sessionId: string): Promise<ClaudeSessionFileRef | undefined> {
      const dirs = await resolveClaudeProjectsDirs();
      return findClaudeSessionFileById(dirs, sessionId);
    },
    openLines(filePath: string): AsyncIterable<string> {
      return readLines(filePath);
    },
    async readFile(filePath: string): Promise<string> {
      return fsReadFile(filePath, "utf8");
    },
    async listSidecarFiles(mainFilePath: string): Promise<ClaudeSidecarFileRef[]> {
      const [subagentFiles, workflowFiles] = await Promise.all([
        walkFiles(subagentsDirFor(mainFilePath)),
        walkFiles(workflowsDirFor(mainFilePath)),
      ]);
      return [...subagentFiles, ...workflowFiles];
    },
  };
}

/** Singleton local store — the default every core function falls back to when no store is given. */
export const localClaudeSessionStore: ClaudeSessionStore = createLocalClaudeSessionStore();
