import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchSessions } from "./search.js";

const SESSION_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SESSION_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PROJECT_ALPHA = "-Users-alpha-proj";
const PROJECT_BETA = "-Users-beta-proj";
const CODEX_PARENT = "11111111-2222-3333-4444-555555550001";
const CODEX_CHILD = "11111111-2222-3333-4444-555555550002";
const CODEX_SOLO = "11111111-2222-3333-4444-555555550003";

const LONG_TOOL_RESULT = `${"x".repeat(2400)}NEEDLE_BEYOND_LIMIT${"y".repeat(300)}`;

function jsonl(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function claudeUser(uuid: string, timestamp: string, content: unknown, cwd?: string) {
  return {
    type: "user",
    uuid,
    parentUuid: null,
    timestamp,
    isSidechain: false,
    ...(cwd !== undefined && { cwd }),
    message: { role: "user", content },
  };
}

let claudeHome: string;
let codexHome: string;
let previousConfigDir: string | undefined;
let previousCodexHome: string | undefined;

beforeAll(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousCodexHome = process.env.CODEX_HOME;
  claudeHome = await mkdtemp(join(tmpdir(), "junrei-search-claude-"));
  codexHome = await mkdtemp(join(tmpdir(), "junrei-search-codex-"));
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;

  const alphaDir = join(claudeHome, "projects", PROJECT_ALPHA);
  const betaDir = join(claudeHome, "projects", PROJECT_BETA);
  await mkdir(alphaDir, { recursive: true });
  await mkdir(betaDir, { recursive: true });

  await writeFile(
    join(alphaDir, `${SESSION_A}.jsonl`),
    jsonl([
      claudeUser(
        "u1",
        "2026-07-10T01:00:00.000Z",
        'Please fix the aqua-checksums drift\nsecond line with "quoted" text',
        "/Users/alpha/proj",
      ),
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-07-10T01:00:05.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-fable-5",
          content: [
            { type: "thinking", thinking: "hidden thinking gold", signature: "sig" },
            { type: "text", text: "I will regenerate the checksums" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "aqua update && aqua i -l", description: "Update tools" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      claudeUser("u2", "2026-07-10T01:00:10.000Z", [
        { type: "tool_result", tool_use_id: "toolu_1", content: LONG_TOOL_RESULT },
      ]),
      { type: "summary", summary: "Aqua tooling session", leafUuid: "u1" },
    ]),
  );

  const subagentsDir = join(alphaDir, SESSION_A, "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(
    join(subagentsDir, "agent-subag001.jsonl"),
    jsonl([claudeUser("s1", "2026-07-10T01:01:00.000Z", "subagent secret phrase inside sidecar")]),
  );

  await writeFile(
    join(alphaDir, `${SESSION_B}.jsonl`),
    jsonl([
      claudeUser(
        "u1",
        "2026-07-09T01:00:00.000Z",
        "unrelated content here entirely",
        "/Users/alpha/proj",
      ),
    ]),
  );

  await writeFile(
    join(betaDir, `${SESSION_C}.jsonl`),
    jsonl([
      claudeUser(
        "u1",
        "2026-07-08T01:00:00.000Z",
        "aqua mention in beta project",
        "/Users/beta/proj/.claude/worktrees/wt-1",
      ),
    ]),
  );

  const codexDay = join(codexHome, "sessions", "2026", "07", "10");
  await mkdir(codexDay, { recursive: true });
  await writeFile(
    join(codexDay, `rollout-2026-07-10T10-00-00-${CODEX_PARENT}.jsonl`),
    jsonl([
      {
        timestamp: "2026-07-10T10:00:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_PARENT, cwd: "/Users/gamma/codexproj", source: "exec" },
      },
      {
        timestamp: "2026-07-10T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "codex parent aqua question" },
      },
      {
        timestamp: "2026-07-10T10:00:01.500Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "codex parent aqua question" }],
        },
      },
      {
        timestamp: "2026-07-10T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "c1",
          arguments: '{"command":["rg","aqua-grep-needle"]}',
        },
      },
      {
        timestamp: "2026-07-10T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: { content: "aqua result line found", success: true },
        },
      },
    ]),
  );
  await writeFile(
    join(codexDay, `rollout-2026-07-10T10-05-00-${CODEX_CHILD}.jsonl`),
    jsonl([
      {
        timestamp: "2026-07-10T10:05:00.000Z",
        type: "session_meta",
        payload: {
          id: CODEX_CHILD,
          cwd: "/Users/gamma/codexproj",
          source: { subagent: { thread_spawn: { parent_thread_id: CODEX_PARENT, depth: 1 } } },
        },
      },
      {
        timestamp: "2026-07-10T10:05:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "child thread aqua needle" },
      },
    ]),
  );
  await writeFile(
    join(codexDay, `rollout-2026-07-10T10-10-00-${CODEX_SOLO}.jsonl`),
    jsonl([
      {
        timestamp: "2026-07-10T10:10:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_SOLO, cwd: "/Users/gamma/solo", source: "exec" },
      },
      {
        timestamp: "2026-07-10T10:10:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "solo response aqua prompt" }],
        },
      },
    ]),
  );

  // Session B's "last activity" is pinned to 2020 for the since/until tests.
  const oldDate = new Date("2020-06-01T00:00:00.000Z");
  await utimes(join(alphaDir, `${SESSION_B}.jsonl`), oldDate, oldDate);
});

afterAll(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  await rm(claudeHome, { recursive: true, force: true });
  await rm(codexHome, { recursive: true, force: true });
});

describe("searchSessions", () => {
  it("matches decoded text that JSON escaping would split in the raw line", async () => {
    const response = await searchSessions({ query: 'with "quoted" text' });
    expect(response.results).toHaveLength(1);
    const result = response.results[0];
    expect(result?.sessionId).toBe(SESSION_A);
    expect(result?.project).toBe(PROJECT_ALPHA);
    expect(result?.matches[0]?.field).toBe("user");
    expect(result?.matches[0]?.snippet).toContain('with "quoted" text');
  });

  it("finds fast-path-eligible queries and reports session metadata", async () => {
    const response = await searchSessions({ query: "aqua-checksums drift" });
    expect(response.results).toHaveLength(1);
    const result = response.results[0];
    expect(result?.source).toBe("claude-code");
    expect(result?.sessionId).toBe(SESSION_A);
    expect(result?.repoRoot).toBe("/Users/alpha/proj");
    expect(result?.matches[0]?.line).toBe(1);
    expect(result?.matches[0]?.timestamp).toBe("2026-07-10T01:00:00.000Z");
  });

  it("searches tool results past the analyzer's 2000-char truncation", async () => {
    const response = await searchSessions({ query: "NEEDLE_BEYOND_LIMIT" });
    expect(response.results).toHaveLength(1);
    const match = response.results[0]?.matches[0];
    expect(match?.field).toBe("tool_result");
    // The needle sits deep inside a huge blob: both ends must be elided.
    expect(match?.snippet.startsWith("…")).toBe(true);
    expect(match?.snippet.endsWith("…")).toBe(true);
    expect(match?.snippet).toContain("NEEDLE_BEYOND_LIMIT");
  });

  it("excludes thinking by default and searches it on opt-in", async () => {
    const byDefault = await searchSessions({ query: "hidden thinking gold" });
    expect(byDefault.results).toHaveLength(0);
    const optIn = await searchSessions({ query: "hidden thinking gold", fields: ["thinking"] });
    expect(optIn.results).toHaveLength(1);
    expect(optIn.results[0]?.matches[0]?.field).toBe("thinking");
  });

  it("matches tool inputs with the tool name attached", async () => {
    const response = await searchSessions({ query: "aqua update && aqua i -l" });
    expect(response.results).toHaveLength(1);
    const match = response.results[0]?.matches[0];
    expect(match?.field).toBe("tool_input");
    expect(match?.toolName).toBe("Bash");
  });

  it("matches session titles", async () => {
    const response = await searchSessions({ query: "Aqua tooling session" });
    expect(response.results[0]?.matches[0]?.field).toBe("title");
  });

  it("is case-insensitive by default and exact with caseSensitive", async () => {
    const insensitive = await searchSessions({ query: "AQUA-CHECKSUMS" });
    expect(insensitive.results).toHaveLength(1);
    const sensitive = await searchSessions({ query: "AQUA-CHECKSUMS", caseSensitive: true });
    expect(sensitive.results).toHaveLength(0);
  });

  it("filters by project, sessionId, repo, and source", async () => {
    const byProject = await searchSessions({ query: "aqua", project: PROJECT_BETA });
    expect(byProject.results.map((r) => r.sessionId)).toEqual([SESSION_C]);

    const bySession = await searchSessions({ query: "aqua", sessionId: SESSION_A });
    expect(bySession.results.map((r) => r.sessionId)).toEqual([SESSION_A]);

    // Worktree cwd collapses into the parent repo key (see deriveRepoIdentity).
    const byRepo = await searchSessions({ query: "aqua", repo: "/Users/beta/proj" });
    expect(byRepo.results.map((r) => r.sessionId)).toEqual([SESSION_C]);
    expect(byRepo.results[0]?.worktreeName).toBe("wt-1");

    const bySource = await searchSessions({ query: "aqua", source: "codex" });
    expect(bySource.results.length).toBeGreaterThan(0);
    expect(bySource.results.every((r) => r.source === "codex")).toBe(true);
  });

  it("stops at maxSessions and flags the truncation", async () => {
    const response = await searchSessions({ query: "aqua", maxSessions: 1 });
    expect(response.results).toHaveLength(1);
    expect(response.resultsTruncated).toBe(true);
  });

  it("caps snippets per session while keeping matchCount exact", async () => {
    const response = await searchSessions({
      query: "aqua",
      sessionId: SESSION_A,
      maxMatchesPerSession: 1,
    });
    const result = response.results[0];
    expect(result?.matches).toHaveLength(1);
    // user prompt + tool_use input + summary title all contain "aqua".
    expect(result?.matchCount).toBe(3);
    expect(result?.matchesTruncated).toBe(true);
  });

  it("searches Claude subagent sidecars only on opt-in, tagging agentId", async () => {
    const byDefault = await searchSessions({ query: "subagent secret phrase" });
    expect(byDefault.results).toHaveLength(0);
    const optIn = await searchSessions({ query: "subagent secret phrase", includeSubagents: true });
    expect(optIn.results.map((r) => r.sessionId)).toEqual([SESSION_A]);
    expect(optIn.results[0]?.matches[0]?.agentId).toBe("subag001");
  });

  it("counts a Codex prompt mirrored as event + response_item exactly once", async () => {
    const response = await searchSessions({ query: "codex parent aqua question" });
    expect(response.results.map((r) => r.sessionId)).toEqual([CODEX_PARENT]);
    expect(response.results[0]?.matchCount).toBe(1);
    expect(response.results[0]?.matches[0]?.field).toBe("user");
  });

  it("falls back to response_item prompts when a rollout has no user_message events", async () => {
    const response = await searchSessions({ query: "solo response aqua prompt" });
    expect(response.results.map((r) => r.sessionId)).toEqual([CODEX_SOLO]);
    expect(response.results[0]?.matchCount).toBe(1);
    expect(response.results[0]?.matches[0]?.field).toBe("user");
  });

  it("matches decoded Codex function_call arguments", async () => {
    const response = await searchSessions({ query: "aqua-grep-needle" });
    expect(response.results.map((r) => r.sessionId)).toEqual([CODEX_PARENT]);
    const match = response.results[0]?.matches[0];
    expect(match?.field).toBe("tool_input");
    expect(match?.toolName).toBe("shell");
  });

  it("attributes Codex sub-agent thread matches to the parent session on opt-in", async () => {
    const byDefault = await searchSessions({ query: "child thread aqua needle" });
    expect(byDefault.results).toHaveLength(0);
    const optIn = await searchSessions({
      query: "child thread aqua needle",
      includeSubagents: true,
    });
    expect(optIn.results.map((r) => r.sessionId)).toEqual([CODEX_PARENT]);
    expect(optIn.results[0]?.matches[0]?.agentId).toBe(CODEX_CHILD);
  });

  it("filters by last-activity time (file mtime) via since/until", async () => {
    const since = await searchSessions({
      query: "unrelated content here",
      since: "2026-01-01T00:00:00Z",
    });
    // Only session B (mtime pinned to 2020) is excluded; the rest still scan.
    expect(since.results).toHaveLength(0);
    const until = await searchSessions({
      query: "unrelated content here",
      until: "2021-01-01T00:00:00Z",
    });
    expect(until.results.map((r) => r.sessionId)).toEqual([SESSION_B]);
  });
});
