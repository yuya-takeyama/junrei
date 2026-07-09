import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexSessionFileRef {
  /** Session UUID, parsed from the rollout filename. */
  sessionId: string;
  filePath: string;
  /** Parsed from the filename (`rollout-<fileTimestamp>-<uuid>.jsonl`) — local-time-ish, not RFC3339. */
  fileTimestamp: string;
  mtimeMs: number;
  sizeBytes: number;
  /** True when found under `archived_sessions/` rather than `sessions/YYYY/MM/DD/`. */
  archived: boolean;
}

const ROLLOUT_FILENAME = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$/;

/** Resolve `$CODEX_HOME`, defaulting to `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME;
  if (configured !== undefined && configured.trim() !== "") {
    return configured.replace(/^~/, homedir());
  }
  return join(homedir(), ".codex");
}

function parseRolloutFilename(
  entry: string,
): { fileTimestamp: string; sessionId: string } | undefined {
  const match = ROLLOUT_FILENAME.exec(entry);
  if (match === null) return undefined;
  const fileTimestamp = match[1];
  const sessionId = match[2];
  if (fileTimestamp === undefined || sessionId === undefined) return undefined;
  return { fileTimestamp, sessionId };
}

async function listRolloutFiles(dir: string, archived: boolean): Promise<CodexSessionFileRef[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const refs: CodexSessionFileRef[] = [];
  for (const entry of entries) {
    const parsed = parseRolloutFilename(entry);
    if (parsed === undefined) continue;
    const filePath = join(dir, entry);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      refs.push({
        sessionId: parsed.sessionId,
        filePath,
        fileTimestamp: parsed.fileTimestamp,
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        archived,
      });
    } catch {
      // Race with deletion — skip.
    }
  }
  return refs;
}

/** List numeric-named subdirectories of `dir` (year/month/day buckets), skipping anything else. */
async function listNumericSubdirs(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => /^\d+$/.test(entry));
}

/**
 * List all Codex rollout session files under `codexHome`: the date-bucketed
 * `sessions/YYYY/MM/DD/` tree plus the flat `archived_sessions/` dir. Missing
 * directories are treated as empty rather than thrown — a fresh or
 * Codex-less machine should just report no sessions.
 */
export async function listCodexSessionFiles(codexHome: string): Promise<CodexSessionFileRef[]> {
  const refs: CodexSessionFileRef[] = [];

  const sessionsDir = join(codexHome, "sessions");
  for (const year of await listNumericSubdirs(sessionsDir)) {
    const yearDir = join(sessionsDir, year);
    for (const month of await listNumericSubdirs(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of await listNumericSubdirs(monthDir)) {
        refs.push(...(await listRolloutFiles(join(monthDir, day), false)));
      }
    }
  }

  refs.push(...(await listRolloutFiles(join(codexHome, "archived_sessions"), true)));

  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
