/**
 * Repo-local learning ledger — one JSON file per learning under
 * `<repoRoot>/.junrei/learnings/`. One-file-per-learning (rather than a single
 * append-only log) is deliberate: it makes each learning an independently
 * git-diffable, cherry-pickable, merge-friendly unit, so a team can review and
 * commit learnings the same way they review code.
 *
 * The only impure module in the insight layer — every other composition
 * function is pure over injected data. Writes are atomic (write a temp file,
 * then `rename` over the target: `rename` is atomic within a filesystem, so a
 * reader never sees a half-written learning). Reads tolerate corruption: a
 * single unparseable/invalid file is skipped with a warning, never aborting
 * the whole listing.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deriveRepoIdentity } from "../shared/repo.js";
import type { Learning, LearningSource, LearningStatus, LearningVerification } from "./types.js";

/** Path of the learnings directory relative to a repo root. */
const LEARNINGS_SUBDIR = join(".junrei", "learnings");

/** Cap on the slug segment of a generated id — keeps filenames sane. */
const SLUG_MAX_LENGTH = 40;

/**
 * Normalize a session `cwd` to the underlying repository root, stripping a
 * `.claude/worktrees/<name>` (or Codex `.codex/worktrees/<hash>`) suffix so
 * every worktree of the same repo shares ONE learnings ledger — reusing
 * `deriveRepoIdentity` (`shared/repo.ts`), the same normalization the rest of
 * the codebase groups sessions by. When no repo root is derivable (a Codex
 * central worktree, whose parent repo isn't encoded in `cwd`), the `cwd`
 * itself is used unchanged — the caller can override with a known checkout.
 */
export function resolveRepoRoot(cwd: string): string {
  const { repoRoot } = deriveRepoIdentity(cwd);
  return repoRoot ?? (cwd.replace(/\/+$/, "") || cwd);
}

/** `<repoRoot>/.junrei/learnings`. */
function learningsDir(repoRoot: string): string {
  return join(repoRoot, LEARNINGS_SUBDIR);
}

/** Kebab-case slug for an id, derived from free text (finding). */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug === "" ? "learning" : slug;
}

/** `YYYYMMDD` (UTC) for an id, from a Date. */
function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface CreateLearningInput {
  finding: string;
  change: string;
  /** Normalized repo name — defaults to the repo root's basename. */
  repo?: string;
  sourceSessions?: LearningSource[];
  expectedEffect?: string;
  /** Defaults to `"open"`. */
  status?: LearningStatus;
  /** Defaults to `"agent"`. */
  proposedBy?: Learning["proposedBy"];
  /** Explicit id (else derived as `L-YYYYMMDD-<slug(finding)>`, de-duped). */
  id?: string;
  /** Injectable clock — tests pass a fixed Date for deterministic ids/timestamps. */
  now?: Date;
}

export interface UpdateLearningPatch {
  status?: LearningStatus;
  finding?: string;
  change?: string;
  expectedEffect?: string;
  sourceSessions?: LearningSource[];
  verification?: LearningVerification;
  /** Explicit timestamp override — else the two status boundaries are stamped from `now`. */
  appliedAt?: string;
  resolvedAt?: string;
  now?: Date;
}

export interface ListLearningsFilter {
  status?: LearningStatus;
  repo?: string;
}

export interface ListLearningsResult {
  /** Newest-first by `createdAt`. */
  learnings: Learning[];
  /** One entry per file that was skipped because it was unreadable/invalid. */
  warnings: string[];
}

/** Minimal shape check — a parsed file must at least carry these to be a Learning. */
function isLearning(value: unknown): value is Learning {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.finding === "string" &&
    typeof v.change === "string" &&
    typeof v.status === "string"
  );
}

/** Atomic write: temp file in the same dir, then rename over the target. */
async function writeAtomic(dir: string, fileName: string, learning: Learning): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, fileName);
  // Unique temp name (pid + hi-res time) so concurrent writers never collide
  // on the temp file itself before the atomic rename resolves the target.
  const tmp = join(
    dir,
    `.${fileName}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await writeFile(tmp, `${JSON.stringify(learning, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/**
 * Create a learning and persist it. The id is `L-YYYYMMDD-<slug>` unless
 * `input.id` is given; a collision with an existing file bumps a numeric
 * suffix (`-2`, `-3`, …) so no create ever silently overwrites another
 * learning.
 */
export async function createLearning(
  repoRoot: string,
  input: CreateLearningInput,
): Promise<Learning> {
  const now = input.now ?? new Date();
  const dir = learningsDir(repoRoot);
  const id = input.id ?? (await allocateId(dir, `L-${dateStamp(now)}-${slugify(input.finding)}`));

  const learning: Learning = {
    id,
    createdAt: now.toISOString(),
    repo: input.repo ?? (basename(repoRoot) || repoRoot),
    sourceSessions: input.sourceSessions ?? [],
    finding: input.finding,
    change: input.change,
    status: input.status ?? "open",
    proposedBy: input.proposedBy ?? "agent",
    ...(input.expectedEffect !== undefined && { expectedEffect: input.expectedEffect }),
  };
  await writeAtomic(dir, `${id}.json`, learning);
  return learning;
}

/** First non-colliding id from `base`, then `base-2`, `base-3`, … */
async function allocateId(dir: string, base: string): Promise<string> {
  const existing = new Set(await listJsonBaseNames(dir));
  if (!existing.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Basenames (no `.json`) of every learning file present, or `[]` if the dir is absent. */
async function listJsonBaseNames(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(".json")).map((n) => basename(n, ".json"));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Read, patch, and re-persist one learning. Throws if the id doesn't exist
 * (an update targeting a missing learning is a caller bug, not a silent
 * no-op). `status` transitions timestamp their structural boundary once:
 * moving to `applied` sets `appliedAt` (if not already set / overridden),
 * moving to `verified`/`rejected` sets `resolvedAt`.
 */
export async function updateLearning(
  repoRoot: string,
  id: string,
  patch: UpdateLearningPatch,
): Promise<Learning> {
  const dir = learningsDir(repoRoot);
  const file = join(dir, `${id}.json`);
  let existing: Learning;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isLearning(parsed)) throw new Error(`learning ${id} is not a valid learning file`);
    existing = parsed;
  } catch (err) {
    if (isEnoent(err)) throw new Error(`learning ${id} not found under ${dir}`);
    throw err;
  }

  const now = patch.now ?? new Date();
  const next: Learning = {
    ...existing,
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.finding !== undefined && { finding: patch.finding }),
    ...(patch.change !== undefined && { change: patch.change }),
    ...(patch.expectedEffect !== undefined && { expectedEffect: patch.expectedEffect }),
    ...(patch.sourceSessions !== undefined && { sourceSessions: patch.sourceSessions }),
    ...(patch.verification !== undefined && { verification: patch.verification }),
  };

  if (patch.status === "applied" && next.appliedAt === undefined) {
    next.appliedAt = patch.appliedAt ?? now.toISOString();
  } else if (patch.appliedAt !== undefined) {
    next.appliedAt = patch.appliedAt;
  }
  if (
    (patch.status === "verified" || patch.status === "rejected") &&
    next.resolvedAt === undefined
  ) {
    next.resolvedAt = patch.resolvedAt ?? now.toISOString();
  } else if (patch.resolvedAt !== undefined) {
    next.resolvedAt = patch.resolvedAt;
  }

  await writeAtomic(dir, `${id}.json`, next);
  return next;
}

/**
 * List every learning under the repo's ledger, newest-first. A file that
 * fails to parse (or parses to something that isn't a learning) is SKIPPED
 * with a `warnings` entry — one bad file never blocks reading the rest. An
 * absent ledger directory yields an empty result, not an error.
 */
export async function listLearnings(
  repoRoot: string,
  filter: ListLearningsFilter = {},
): Promise<ListLearningsResult> {
  const dir = learningsDir(repoRoot);
  let fileNames: string[];
  try {
    fileNames = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    if (isEnoent(err)) return { learnings: [], warnings: [] };
    throw err;
  }

  const learnings: Learning[] = [];
  const warnings: string[] = [];
  for (const name of fileNames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch (err) {
      warnings.push(`skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isLearning(parsed)) {
      warnings.push(`skipped ${name}: not a valid learning file`);
      continue;
    }
    if (filter.status !== undefined && parsed.status !== filter.status) continue;
    if (filter.repo !== undefined && parsed.repo !== filter.repo) continue;
    learnings.push(parsed);
  }

  learnings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { learnings, warnings };
}
