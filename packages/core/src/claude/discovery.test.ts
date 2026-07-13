import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClaudeSessionFileById } from "./discovery.js";

// Git doesn't preserve file mtimes, so the tie-break assertion builds its own
// temp tree with explicit `utimes` instead of relying on checked-in fixtures.
describe("findClaudeSessionFileById", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junrei-claude-discovery-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(path: string, mtime: Date): Promise<void> {
    await writeFile(path, "{}\n");
    await utimes(path, mtime, mtime);
  }

  it("finds a session file by bare id across multiple project dirs", async () => {
    const projA = join(root, "-Users-a-proj");
    const projB = join(root, "-Users-b-proj");
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });
    const target = join(projB, "11111111-1111-1111-1111-111111111111.jsonl");
    await touch(join(projA, "22222222-2222-2222-2222-222222222222.jsonl"), new Date());
    await touch(target, new Date());

    const ref = await findClaudeSessionFileById([root], "11111111-1111-1111-1111-111111111111");

    expect(ref?.filePath).toBe(target);
    expect(ref?.projectDirName).toBe("-Users-b-proj");
    expect(ref?.sessionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("returns undefined for an unknown session id", async () => {
    const proj = join(root, "-Users-a-proj");
    await mkdir(proj, { recursive: true });
    await touch(join(proj, "22222222-2222-2222-2222-222222222222.jsonl"), new Date());

    const ref = await findClaudeSessionFileById([root], "does-not-exist");
    expect(ref).toBeUndefined();
  });

  it("returns undefined when the projects dir itself doesn't exist", async () => {
    const ref = await findClaudeSessionFileById(
      [join(root, "does-not-exist")],
      "11111111-1111-1111-1111-111111111111",
    );
    expect(ref).toBeUndefined();
  });

  it("picks the newest-mtime file when the same session id exists under two project dirs", async () => {
    const projOld = join(root, "-Users-old-proj");
    const projNew = join(root, "-Users-new-proj");
    await mkdir(projOld, { recursive: true });
    await mkdir(projNew, { recursive: true });
    const id = "11111111-1111-1111-1111-111111111111";
    const oldFile = join(projOld, `${id}.jsonl`);
    const newFile = join(projNew, `${id}.jsonl`);
    await touch(oldFile, new Date("2026-01-01T00:00:00Z"));
    await touch(newFile, new Date("2026-06-01T00:00:00Z"));

    const ref = await findClaudeSessionFileById([root], id);

    expect(ref?.filePath).toBe(newFile);
    expect(ref?.projectDirName).toBe("-Users-new-proj");
  });
});
