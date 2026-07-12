import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type FileAccessAgg, foldFileAccess, mergeFileAccess } from "../shared/metrics.js";
import { computeFileAccess, computeSkillInvocations, computeUsage } from "./metrics.js";
import { parseClaudeTranscriptFile } from "./parser.js";
import type { ApiMessage, SessionData, ToolCall } from "./session-data.js";
import { buildSessionData } from "./session-data.js";
import type { UserRecord } from "./types.js";

/** Bare `SessionData` with only `apiMessages` populated — mirrors the literal in the "computeSkillInvocations" describe block below, sized for `computeUsage` instead. */
function sessionDataWithMessages(apiMessages: ApiMessage[]): SessionData {
  return {
    records: [],
    apiMessages,
    toolCalls: [],
    userPrompts: [],
    compactions: [],
    backgroundLaunches: [],
    taskNotifications: [],
    apiErrorCount: 0,
    apiErrors: [],
    warningCount: 0,
  };
}

/** Bare `SessionData` with only `records` populated — for the injection-scanning tests, which read `data.records` directly. */
function sessionDataWithRecords(records: SessionData["records"]): SessionData {
  return {
    records,
    apiMessages: [],
    toolCalls: [],
    userPrompts: [],
    compactions: [],
    backgroundLaunches: [],
    taskNotifications: [],
    apiErrorCount: 0,
    apiErrors: [],
    warningCount: 0,
  };
}

const FIXTURE_PROJECTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/projects",
);
const SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);
const SKILL_INJECTION_SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/44444444-4444-4444-4444-444444444445.jsonl",
);

async function loadMainData(): Promise<SessionData> {
  const transcript = await parseClaudeTranscriptFile(SESSION_FILE);
  return buildSessionData(transcript);
}

async function loadSkillInjectionData(): Promise<SessionData> {
  const transcript = await parseClaudeTranscriptFile(SKILL_INJECTION_SESSION_FILE);
  return buildSessionData(transcript);
}

describe("computeUsage", () => {
  it("a zero-usage message on an unpriced model doesn't flip costIsComplete false", () => {
    // Shape mirrors Claude Code's real "<synthetic>" harness stub: a
    // zero-token error-stub message on a model that has no pricing entry
    // (observed in session 52ee641f-6d82-459d-9324-878fcc1037b5's subagent
    // sidecar, agent-a07131f00d4299b4e.jsonl line 20 — "API Error: Connection
    // closed mid-response").
    const priced: ApiMessage = {
      messageId: "msg_priced",
      model: "claude-fable-5",
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
      line: 1,
    };
    const synthetic: ApiMessage = {
      messageId: "msg_synthetic",
      model: "<synthetic>",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      line: 2,
    };
    const data = sessionDataWithMessages([priced, synthetic]);
    const usage = computeUsage(data);

    expect(usage.total.costIsComplete).toBe(true);
    const pricedEntry = usage.byModel.find((m) => m.model === "claude-fable-5");
    expect(usage.total.costUsd).toBe(pricedEntry?.costUsd);

    // Present in byModel (its message still happened) but priced at an exact
    // $0, not left undefined/"unpriced" — see the zero-usage short-circuit in
    // pricing.ts's estimateCostComponents.
    const syntheticEntry = usage.byModel.find((m) => m.model === "<synthetic>");
    expect(syntheticEntry).toBeDefined();
    expect(syntheticEntry?.costUsd).toBe(0);
    expect(syntheticEntry?.messageCount).toBe(1);
  });

  it("an unpriced model WITH nonzero tokens still marks costIsComplete false", () => {
    const message: ApiMessage = {
      messageId: "msg_unpriced",
      model: "totally-unknown-model-xyz",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      line: 1,
    };
    const usage = computeUsage(sessionDataWithMessages([message]));

    expect(usage.total.costIsComplete).toBe(false);
    const entry = usage.byModel.find((m) => m.model === "totally-unknown-model-xyz");
    expect(entry?.costUsd).toBeUndefined();
  });
});

describe("computeFileAccess", () => {
  it("tallies reads/edits for the main transcript alone, ignoring search tools", async () => {
    const data = await loadMainData();
    const access = computeFileAccess(data);

    // /p/foo.ts: Read at lines 3, 12, 14, 16 (4 reads) + Edit at line 10 (1 edit).
    const foo = access.get("/p/foo.ts");
    expect(foo?.reads).toBe(4);
    expect(foo?.edits).toBe(1);
    expect(foo?.firstLine).toBe(3);
    expect(foo?.firstTimestamp).toBe("2026-07-09T01:00:06.000Z");

    // Grep/Glob/LS calls never appear here — the fixture has none, but
    // confirm no unexpected extra paths snuck in beyond foo.ts.
    expect([...access.keys()]).toEqual(["/p/foo.ts"]);
  });

  // Modeled on the real shape (observed verbatim in a live harness-injected
  // system-reminder): two "Contents of ...:" headers in one turn, wrapped in
  // a <system-reminder> block, each followed by its own file body.
  it("records a CLAUDE.md 'Contents of' system-reminder injection with no reads/edits", () => {
    const header1 =
      "Contents of /Users/test/proj/CLAUDE.md (project instructions, checked into the codebase):";
    const body1 = "\n\n# CLAUDE.md\nSome project instructions here.\n\n";
    const header2 =
      "Contents of /Users/test/.claude/CLAUDE.md (user's private global instructions for all projects):";
    const body2 = "\n\n# About Me\nSome global instructions here.\n";
    const suffix = "</system-reminder>\n\nWhat does CLAUDE.md say?";
    const promptText = `<system-reminder>\n${header1}${body1}${header2}${body2}${suffix}`;

    const record: UserRecord = {
      type: "user",
      line: 1,
      timestamp: "2026-07-10T00:00:00.000Z",
      toolResults: [],
      promptText,
    };
    const access = computeFileAccess(sessionDataWithRecords([record]));

    // First header's injected span stops at the second header — not the end
    // of the message.
    const project = access.get("/Users/test/proj/CLAUDE.md");
    expect(project?.reads).toBe(0);
    expect(project?.edits).toBe(0);
    expect(project?.injectedCount).toBe(1);
    expect(project?.injectedChars).toBe(body1.length);
    expect(project?.firstLine).toBe(1);
    expect(project?.firstTimestamp).toBe("2026-07-10T00:00:00.000Z");

    // Last header's injected span runs to the end of the message (the
    // trailing non-file text is swallowed into it — an approximation, not a
    // per-file guess).
    const global = access.get("/Users/test/.claude/CLAUDE.md");
    expect(global?.reads).toBe(0);
    expect(global?.injectedCount).toBe(1);
    expect(global?.injectedChars).toBe(body2.length + suffix.length);
  });

  it("never fires on ordinary prose that merely mentions 'contents of'", () => {
    const record: UserRecord = {
      type: "user",
      line: 1,
      toolResults: [],
      promptText: "Contents of the box were empty; check the contents of the drawer too.",
    };
    expect(computeFileAccess(sessionDataWithRecords([record])).size).toBe(0);
  });

  it("records a Skill SKILL.md injection alongside its tool call, reusing the PR #39 matching", async () => {
    const data = await loadSkillInjectionData();
    const access = computeFileAccess(data);

    // Same fixture/injection record `computeSkillInvocations`'s "matches a
    // plain (non-namespaced) skill" test asserts injectedChars=188 for.
    const skillMd = access.get("/Users/test/proj4/.claude/skills/solo-skill/SKILL.md");
    expect(skillMd?.reads).toBe(0);
    expect(skillMd?.edits).toBe(0);
    expect(skillMd?.injectedCount).toBe(1);
    expect(skillMd?.injectedChars).toBe(188);
  });
});

describe("mergeFileAccess", () => {
  function agg(overrides: Partial<FileAccessAgg> & { path: string }): FileAccessAgg {
    return { reads: 0, edits: 0, ...overrides };
  }

  it("marks a path touched only by main as 'main', keeping firstLine", () => {
    const main = new Map([
      ["/a.ts", agg({ path: "/a.ts", reads: 2, edits: 1, firstLine: 5, firstTimestamp: "t1" })],
    ]);
    const { fileAccess, fileAccessTruncated } = mergeFileAccess(main, new Map());
    expect(fileAccessTruncated).toBe(false);
    expect(fileAccess).toEqual([
      {
        path: "/a.ts",
        reads: 2,
        edits: 1,
        firstTouchTimestamp: "t1",
        firstTouchLine: 5,
        threads: "main",
      },
    ]);
  });

  it("marks a path touched only by a subagent as 'subagent', omitting firstTouchLine", () => {
    const subagents = new Map([
      ["/b.ts", agg({ path: "/b.ts", reads: 1, edits: 0, firstLine: 9, firstTimestamp: "t2" })],
    ]);
    const { fileAccess } = mergeFileAccess(new Map(), subagents);
    expect(fileAccess).toEqual([
      { path: "/b.ts", reads: 1, edits: 0, firstTouchTimestamp: "t2", threads: "subagent" },
    ]);
  });

  it("merges a path touched by both, summing counts and taking the earliest timestamp", () => {
    const main = new Map([
      [
        "/c.ts",
        agg({
          path: "/c.ts",
          reads: 2,
          edits: 1,
          firstLine: 3,
          firstTimestamp: "2026-01-01T00:00:05.000Z",
        }),
      ],
    ]);
    const subagents = new Map([
      [
        "/c.ts",
        agg({
          path: "/c.ts",
          reads: 1,
          edits: 0,
          firstLine: 40,
          firstTimestamp: "2026-01-01T00:00:01.000Z",
        }),
      ],
    ]);
    const { fileAccess } = mergeFileAccess(main, subagents);
    expect(fileAccess).toEqual([
      {
        path: "/c.ts",
        reads: 3,
        edits: 1,
        // Earliest across both transcripts, even though it's the subagent's.
        firstTouchTimestamp: "2026-01-01T00:00:01.000Z",
        // firstTouchLine still comes from MAIN only.
        firstTouchLine: 3,
        threads: "both",
      },
    ]);
  });

  it("caps at 500 paths, keeping the highest reads+edits and reporting the omitted count", () => {
    const main = new Map<string, FileAccessAgg>();
    for (let i = 0; i < 600; i += 1) {
      const path = `/file-${String(i).padStart(4, "0")}.ts`;
      // Give the first 100 paths a high score so they're guaranteed to survive the cap.
      const reads = i < 100 ? 10 : 1;
      main.set(path, agg({ path, reads, edits: 0, firstLine: i + 1 }));
    }

    const { fileAccess, fileAccessTruncated, fileAccessOmittedCount } = mergeFileAccess(
      main,
      new Map(),
    );

    expect(fileAccessTruncated).toBe(true);
    expect(fileAccessOmittedCount).toBe(100);
    expect(fileAccess).toHaveLength(500);
    // Every high-score path survived the cap.
    for (let i = 0; i < 100; i += 1) {
      expect(fileAccess.some((e) => e.path === `/file-${String(i).padStart(4, "0")}.ts`)).toBe(
        true,
      );
    }
    // Kept entries are sorted back to path order for display.
    const sorted = [...fileAccess].sort((a, b) => a.path.localeCompare(b.path));
    expect(fileAccess).toEqual(sorted);
  });

  it("merges injectedCount/injectedChars across main and subagent, summing both", () => {
    const main = new Map([
      [
        "/CLAUDE.md",
        agg({ path: "/CLAUDE.md", reads: 0, edits: 0, injectedCount: 1, injectedChars: 500 }),
      ],
    ]);
    const subagents = new Map([
      [
        "/CLAUDE.md",
        agg({ path: "/CLAUDE.md", reads: 0, edits: 0, injectedCount: 2, injectedChars: 300 }),
      ],
    ]);
    const { fileAccess } = mergeFileAccess(main, subagents);
    expect(fileAccess[0]?.injectedCount).toBe(3);
    expect(fileAccess[0]?.injectedChars).toBe(800);
    expect(fileAccess[0]?.reads).toBe(0);
    expect(fileAccess[0]?.edits).toBe(0);
  });

  it("omits injectedCount/injectedChars for a plain read/edit entry with no injections", () => {
    const main = new Map([["/a.ts", agg({ path: "/a.ts", reads: 1, edits: 0, firstLine: 1 })]]);
    const { fileAccess } = mergeFileAccess(main, new Map());
    expect(fileAccess[0]).not.toHaveProperty("injectedCount");
    expect(fileAccess[0]).not.toHaveProperty("injectedChars");
  });

  it("counts injections toward the keep-score when capping, so an injected-only file isn't dropped first", () => {
    const main = new Map<string, FileAccessAgg>();
    for (let i = 0; i < 501; i += 1) {
      const path = `/file-${String(i).padStart(4, "0")}.ts`;
      main.set(path, agg({ path, reads: 1, edits: 0, firstLine: i + 1 }));
    }
    // Zero reads/edits, but a higher injection count than every reads:1 path
    // above (score 1) — under a reads+edits-only score this would always be
    // the first dropped; it must survive instead.
    main.set(
      "/CLAUDE.md",
      agg({ path: "/CLAUDE.md", reads: 0, edits: 0, injectedCount: 5, firstLine: 999 }),
    );

    const { fileAccess, fileAccessTruncated, fileAccessOmittedCount } = mergeFileAccess(
      main,
      new Map(),
    );
    expect(fileAccessTruncated).toBe(true);
    expect(fileAccessOmittedCount).toBe(2);
    expect(fileAccess.some((e) => e.path === "/CLAUDE.md")).toBe(true);
  });
});

describe("foldFileAccess", () => {
  it("sums injectedCount/injectedChars alongside reads/edits, keeping the earliest timestamp/line", () => {
    const target = new Map<string, FileAccessAgg>([
      [
        "/CLAUDE.md",
        {
          path: "/CLAUDE.md",
          reads: 0,
          edits: 0,
          injectedCount: 1,
          injectedChars: 100,
          firstLine: 5,
          firstTimestamp: "t2",
        },
      ],
    ]);
    const source = new Map<string, FileAccessAgg>([
      [
        "/CLAUDE.md",
        {
          path: "/CLAUDE.md",
          reads: 0,
          edits: 0,
          injectedCount: 2,
          injectedChars: 50,
          firstLine: 1,
          firstTimestamp: "t1",
        },
      ],
    ]);
    foldFileAccess(target, source);
    const merged = target.get("/CLAUDE.md");
    expect(merged?.injectedCount).toBe(3);
    expect(merged?.injectedChars).toBe(150);
    expect(merged?.firstLine).toBe(1);
    expect(merged?.firstTimestamp).toBe("t1");
  });

  it("copies injectedCount/injectedChars through untouched when the path is new to target", () => {
    const target = new Map<string, FileAccessAgg>();
    const source = new Map<string, FileAccessAgg>([
      [
        "/MEMORY.md",
        {
          path: "/MEMORY.md",
          reads: 0,
          edits: 0,
          injectedCount: 1,
          injectedChars: 42,
          firstLine: 1,
        },
      ],
    ]);
    foldFileAccess(target, source);
    expect(target.get("/MEMORY.md")).toEqual({
      path: "/MEMORY.md",
      reads: 0,
      edits: 0,
      injectedCount: 1,
      injectedChars: 42,
      firstLine: 1,
    });
  });
});

describe("computeSkillInvocations", () => {
  it("extracts Skill tool calls and slash-command records, in line order", async () => {
    const data = await loadMainData();
    const invocations = computeSkillInvocations(data);
    expect(invocations).toHaveLength(2);
    expect(invocations.map((i) => i.kind)).toEqual(["command", "skill"]);
    expect(
      invocations.every((i, idx, arr) => idx === 0 || (arr[idx - 1]?.line ?? 0) <= i.line),
    ).toBe(true);
  });

  it("skips a Skill tool_use whose input carries no skill id", () => {
    const call: ToolCall = {
      toolUseId: "toolu_x",
      name: "Skill",
      input: { args: "no skill field" },
      line: 5,
    };
    const data: SessionData = {
      records: [],
      apiMessages: [],
      toolCalls: [call],
      userPrompts: [],
      compactions: [],
      backgroundLaunches: [],
      taskNotifications: [],
      apiErrorCount: 0,
      apiErrors: [],
      warningCount: 0,
    };
    expect(computeSkillInvocations(data)).toEqual([]);
  });

  // Fixture: 44444444-4444-4444-4444-444444444444.jsonl — modeled on the real
  // "Base directory for this skill:" isMeta-injection shape (see issue #27),
  // covering: a plain skill, a namespaced (plugin) skill, two skills invoked
  // in one turn with their injection records in reversed order, the same
  // skill invoked twice, and a skill with no injection record at all.
  describe("injectedChars / injectionLine (the isMeta SKILL.md payload)", () => {
    it("matches a plain (non-namespaced) skill to its injection record", async () => {
      const data = await loadSkillInjectionData();
      const invocations = computeSkillInvocations(data);
      const solo = invocations.find((i) => i.name === "solo-skill");
      expect(solo?.resultChars).toBe(27); // "Launching skill: solo-skill"
      expect(solo?.injectedChars).toBe(188);
      expect(solo?.injectionLine).toBe(4);
    });

    it("matches a namespaced (plugin:skill) skill by its trailing path segment", async () => {
      const data = await loadSkillInjectionData();
      const invocations = computeSkillInvocations(data);
      // Base directory observed in real transcripts for a plugin skill:
      // ".../local-agent-mode-sessions/skills-plugin/<uuid>/<uuid>/skills/docx"
      // — no "anthropic-skills:" segment anywhere in the path.
      const docx = invocations.find((i) => i.name === "anthropic-skills:docx");
      expect(docx?.injectedChars).toBe(304);
      expect(docx?.injectionLine).toBe(7);
    });

    it("attributes each of two skills invoked in one turn to its OWN injection, regardless of record order", async () => {
      const data = await loadSkillInjectionData();
      const invocations = computeSkillInvocations(data);
      // skill-beta's injection record (line 10) appears BEFORE skill-alpha's
      // (line 11) even though alpha was invoked first — matching keys off
      // the base-directory name, not proximity/order.
      const alpha = invocations.find((i) => i.name === "skill-alpha");
      const beta = invocations.find((i) => i.name === "skill-beta");
      expect(beta?.injectionLine).toBe(10);
      expect(beta?.injectedChars).toBe(222);
      expect(alpha?.injectionLine).toBe(11);
      expect(alpha?.injectedChars).toBe(162);
    });

    it("consumes each injection at most once when the same skill is invoked twice", async () => {
      const data = await loadSkillInjectionData();
      const invocations = computeSkillInvocations(data);
      const repeats = invocations.filter((i) => i.name === "repeat-skill");
      expect(repeats).toHaveLength(2);
      // First invocation (tool_use at line 12) gets the first injection...
      expect(repeats[0]?.injectionLine).toBe(14);
      expect(repeats[0]?.injectedChars).toBe(110);
      // ...and the second invocation (line 15) gets the second injection —
      // NOT a re-attribution of the first (already-`consumed`) record.
      expect(repeats[1]?.injectionLine).toBe(17);
      expect(repeats[1]?.injectedChars).toBe(184);
    });

    it("leaves injectedChars/injectionLine undefined when no injection record follows", async () => {
      const data = await loadSkillInjectionData();
      const invocations = computeSkillInvocations(data);
      const none = invocations.find((i) => i.name === "no-injection-skill");
      expect(none?.resultChars).toBe(35); // "Launching skill: no-injection-skill"
      expect(none?.injectedChars).toBeUndefined();
      expect(none?.injectionLine).toBeUndefined();
    });
  });
});
