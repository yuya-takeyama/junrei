import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCodexSessionIndexTitles } from "./session-index.js";

describe("loadCodexSessionIndexTitles", () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), "junrei-codex-index-"));
  });

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  async function writeIndex(lines: string[]): Promise<void> {
    await writeFile(join(codexHome, "session_index.jsonl"), `${lines.join("\n")}\n`);
  }

  it("maps session id to thread_name", async () => {
    await writeIndex([
      '{"id":"aaaaaaaa-1111-1111-1111-111111111111","thread_name":"Fix the parser","updated_at":"2026-07-01T00:00:00Z"}',
      '{"id":"bbbbbbbb-2222-2222-2222-222222222222","thread_name":"Update online.csv talk content","updated_at":"2026-07-02T00:00:00Z"}',
    ]);
    const titles = await loadCodexSessionIndexTitles(codexHome);
    expect(titles.get("aaaaaaaa-1111-1111-1111-111111111111")).toBe("Fix the parser");
    expect(titles.get("bbbbbbbb-2222-2222-2222-222222222222")).toBe(
      "Update online.csv talk content",
    );
  });

  it("later lines win for a duplicated id (append-style renames)", async () => {
    await writeIndex([
      '{"id":"aaaaaaaa-1111-1111-1111-111111111111","thread_name":"First name","updated_at":"2026-07-01T00:00:00Z"}',
      '{"id":"aaaaaaaa-1111-1111-1111-111111111111","thread_name":"Renamed later","updated_at":"2026-07-03T00:00:00Z"}',
    ]);
    const titles = await loadCodexSessionIndexTitles(codexHome);
    expect(titles.get("aaaaaaaa-1111-1111-1111-111111111111")).toBe("Renamed later");
  });

  it("skips malformed JSON, missing fields, and empty values without failing the rest", async () => {
    await writeIndex([
      "not json at all",
      '{"id":"aaaaaaaa-1111-1111-1111-111111111111"}',
      '{"thread_name":"No id"}',
      '{"id":"","thread_name":"Empty id"}',
      '{"id":"bbbbbbbb-2222-2222-2222-222222222222","thread_name":""}',
      '{"id":42,"thread_name":"Numeric id"}',
      '{"id":"cccccccc-3333-3333-3333-333333333333","thread_name":"Survives"}',
    ]);
    const titles = await loadCodexSessionIndexTitles(codexHome);
    expect(titles.size).toBe(1);
    expect(titles.get("cccccccc-3333-3333-3333-333333333333")).toBe("Survives");
  });

  it("returns an empty map when the index file is missing", async () => {
    const titles = await loadCodexSessionIndexTitles(codexHome);
    expect(titles.size).toBe(0);
  });

  it("re-reads the index when its mtime changes (rename picked up)", async () => {
    await writeIndex([
      '{"id":"aaaaaaaa-1111-1111-1111-111111111111","thread_name":"Before rename"}',
    ]);
    const filePath = join(codexHome, "session_index.jsonl");
    // Distinct stamps so the mtime-keyed cache can't mistake the rewrite for
    // the version it already parsed.
    await utimes(filePath, 1_700_000_000, 1_700_000_000);
    const before = await loadCodexSessionIndexTitles(codexHome);
    expect(before.get("aaaaaaaa-1111-1111-1111-111111111111")).toBe("Before rename");

    await writeIndex([
      '{"id":"aaaaaaaa-1111-1111-1111-111111111111","thread_name":"After rename"}',
    ]);
    await utimes(filePath, 1_700_000_100, 1_700_000_100);
    const after = await loadCodexSessionIndexTitles(codexHome);
    expect(after.get("aaaaaaaa-1111-1111-1111-111111111111")).toBe("After rename");
  });
});
