import { describe, expect, it } from "vitest";
import { deriveCurrentDate, renderClaudeMdContextBlock } from "./disk-context.js";
import type { DiskContext } from "./types.js";

// All content synthetic — invented CLAUDE.md/memory text, path, and email.

const SESSION_START = Date.parse("2026-07-18T00:00:00.000Z");

function baseContext(): DiskContext {
  return {
    globalClaudeMd: {
      path: "/home/u/.claude/CLAUDE.md",
      content: "# About\n- be helpful\n",
      mtimeMs: SESSION_START - 60_000, // written before the session started
    },
    email: "user@example.test",
    emailMtimeMs: SESSION_START - 60_000,
  };
}

describe("deriveCurrentDate", () => {
  it("renders the ISO calendar date (UTC) from a log timestamp", () => {
    expect(deriveCurrentDate("2026-07-18T09:42:37.000Z")).toBe("2026-07-18");
  });

  it("returns undefined for a missing or unparseable timestamp", () => {
    expect(deriveCurrentDate(undefined)).toBeUndefined();
    expect(deriveCurrentDate("")).toBeUndefined();
    expect(deriveCurrentDate("not a date")).toBeUndefined();
  });
});

describe("renderClaudeMdContextBlock", () => {
  it("assembles the reminder block byte-for-byte from disk + date", () => {
    const rendered = renderClaudeMdContextBlock(baseContext(), {
      dateStr: "2026-07-18",
      sessionStartMs: SESSION_START,
    });
    expect(rendered?.text).toBe(
      "<system-reminder>\n" +
        "As you answer the user's questions, you can use the following context:\n" +
        "# claudeMd\n" +
        "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n" +
        "Contents of /home/u/.claude/CLAUDE.md (user's private global instructions for all projects):\n\n" +
        "# About\n- be helpful\n" +
        "# userEmail\nThe user's email address is user@example.test.\n" +
        "# currentDate\nToday's date is 2026-07-18.\n" +
        "\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n" +
        "</system-reminder>\n\n",
    );
    expect(rendered?.driftDetected).toBe(false);
  });

  it("includes project CLAUDE.md and memory blocks when present", () => {
    const ctx = baseContext();
    ctx.projectClaudeMd = {
      path: "/proj/CLAUDE.md",
      content: "# Project\n- run tests\n",
      mtimeMs: SESSION_START - 1000,
    };
    ctx.memoryMd = {
      path: "/home/u/.claude/memory/MEMORY.md",
      content: "# Memory\n- remembers\n",
      mtimeMs: SESSION_START - 1000,
    };
    const rendered = renderClaudeMdContextBlock(ctx, {
      dateStr: "2026-07-18",
      sessionStartMs: SESSION_START,
    });
    expect(rendered?.text).toContain(
      "Contents of /proj/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\n- run tests\n",
    );
    expect(rendered?.text).toContain(
      "Contents of /home/u/.claude/memory/MEMORY.md (user's auto-memory, persists across conversations):\n\n# Memory\n- remembers\n",
    );
    expect(rendered?.files.map((f) => f.role)).toEqual([
      "global-claude-md",
      "project-claude-md",
      "memory",
      "email",
    ]);
  });

  it("flags driftDetected when a contributing file's mtime is after the session start", () => {
    const ctx = baseContext();
    // global CLAUDE.md was edited AFTER the session began.
    ctx.globalClaudeMd = {
      path: "/home/u/.claude/CLAUDE.md",
      content: "# About\n- be helpful\n",
      mtimeMs: SESSION_START + 5000,
    };
    const rendered = renderClaudeMdContextBlock(ctx, {
      dateStr: "2026-07-18",
      sessionStartMs: SESSION_START,
    });
    expect(rendered?.driftDetected).toBe(true);
    expect(rendered?.files.find((f) => f.role === "global-claude-md")?.driftDetected).toBe(true);
  });

  it("returns undefined (declared unknown) when the global CLAUDE.md is missing", () => {
    const ctx = baseContext();
    delete ctx.globalClaudeMd;
    expect(
      renderClaudeMdContextBlock(ctx, { dateStr: "2026-07-18", sessionStartMs: SESSION_START }),
    ).toBeUndefined();
  });

  it("returns undefined when the account email is missing", () => {
    const ctx = baseContext();
    delete ctx.email;
    expect(
      renderClaudeMdContextBlock(ctx, { dateStr: "2026-07-18", sessionStartMs: SESSION_START }),
    ).toBeUndefined();
  });
});
