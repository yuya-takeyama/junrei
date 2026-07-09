import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCodexSessionFiles, resolveCodexHome } from "./discovery.js";

// Git doesn't preserve file mtimes, so the sort-order assertions build their
// own temp tree with explicit `utimes` instead of relying on checked-in
// fixtures (see test/fixtures/codex for the content-focused parser/analyze
// fixtures, which don't care about mtime).
describe("listCodexSessionFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junrei-codex-discovery-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(path: string, mtime: Date): Promise<void> {
    await writeFile(path, "{}\n");
    await utimes(path, mtime, mtime);
  }

  it("finds sessions nested under sessions/YYYY/MM/DD and archived_sessions", async () => {
    const dayDir = join(root, "sessions", "2026", "07", "01");
    await mkdir(dayDir, { recursive: true });
    const archivedDir = join(root, "archived_sessions");
    await mkdir(archivedDir, { recursive: true });

    const oldest = join(
      dayDir,
      "rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
    );
    const newest = join(
      dayDir,
      "rollout-2026-07-01T12-00-00-22222222-2222-2222-2222-222222222222.jsonl",
    );
    const archived = join(
      archivedDir,
      "rollout-2026-06-01T08-00-00-33333333-3333-3333-3333-333333333333.jsonl",
    );

    await touch(oldest, new Date("2026-07-01T10:05:00Z"));
    await touch(newest, new Date("2026-07-01T12:05:00Z"));
    await touch(archived, new Date("2026-06-01T08:05:00Z"));

    const refs = await listCodexSessionFiles(root);

    expect(refs).toHaveLength(3);
    // Newest mtime first.
    expect(refs.map((r) => r.sessionId)).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "11111111-1111-1111-1111-111111111111",
      "33333333-3333-3333-3333-333333333333",
    ]);

    const newestRef = refs[0];
    expect(newestRef?.filePath).toBe(newest);
    expect(newestRef?.fileTimestamp).toBe("2026-07-01T12-00-00");
    expect(newestRef?.archived).toBe(false);

    const archivedRef = refs.find((r) => r.sessionId === "33333333-3333-3333-3333-333333333333");
    expect(archivedRef?.archived).toBe(true);
  });

  it("ignores non-numeric subdirectories and non-rollout filenames", async () => {
    const notADateDir = join(root, "sessions", "not-a-year");
    await mkdir(notADateDir, { recursive: true });
    await touch(
      join(notADateDir, "rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl"),
      new Date(),
    );

    const dayDir = join(root, "sessions", "2026", "07", "01");
    await mkdir(dayDir, { recursive: true });
    await touch(join(dayDir, "not-a-rollout-file.jsonl"), new Date());
    await touch(join(dayDir, "README.md"), new Date());

    const refs = await listCodexSessionFiles(root);
    expect(refs).toEqual([]);
  });

  it("returns [] when codexHome (or its sessions/archived_sessions dirs) doesn't exist", async () => {
    const refs = await listCodexSessionFiles(join(root, "does-not-exist"));
    expect(refs).toEqual([]);
  });
});

describe("resolveCodexHome", () => {
  it("uses CODEX_HOME when set", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/custom/codex-home" })).toBe("/custom/codex-home");
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", () => {
    const home = resolveCodexHome({});
    expect(home.endsWith(`${"/"}.codex`)).toBe(true);
  });
});
