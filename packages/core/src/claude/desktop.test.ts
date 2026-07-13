import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadClaudeDesktopTitles, resolveClaudeDesktopSessionsDirs } from "./desktop.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/claude-desktop",
);

describe("resolveClaudeDesktopSessionsDirs", () => {
  it("honors JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR and keeps only existing dirs", async () => {
    const dirs = await resolveClaudeDesktopSessionsDirs({
      JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR: `${FIXTURE_DIR},/does/not/exist`,
    });
    expect(dirs).toEqual([FIXTURE_DIR]);
  });

  it("returns [] when the override points at nothing", async () => {
    const dirs = await resolveClaudeDesktopSessionsDirs({
      JUNREI_CLAUDE_DESKTOP_SESSIONS_DIR: "/does/not/exist",
    });
    expect(dirs).toEqual([]);
  });
});

describe("loadClaudeDesktopTitles", () => {
  it("maps cliSessionId -> title from nested local_*.json meta files", async () => {
    const titles = await loadClaudeDesktopTitles([FIXTURE_DIR]);
    expect(titles.get("44444444-4444-4444-4444-444444444445")).toBe("Desktop-titled session");
    expect(titles.get("11111111-1111-1111-1111-111111111111")).toBe("Desktop title must lose");
    // The title-less and cliSessionId-less meta files, and the valid-shaped
    // file whose name doesn't match local_*.json, must all be skipped.
    expect(titles.size).toBe(2);
  });

  it("returns an empty map for missing dirs", async () => {
    expect(await loadClaudeDesktopTitles(["/does/not/exist"])).toEqual(new Map());
  });
});
