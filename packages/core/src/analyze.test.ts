import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeSession } from "./analyze.js";
import { listSessionFiles } from "./discovery.js";

const FIXTURE_PROJECTS = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/projects");
const SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);

describe("analyzeSession", () => {
  it("computes the full quantitative summary from a fixture session", async () => {
    const analysis = await analyzeSession(SESSION_FILE);

    // Identity & envelope
    expect(analysis.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(analysis.projectDirName).toBe("-Users-test-proj");
    expect(analysis.cwd).toBe("/Users/test/proj");
    expect(analysis.gitBranch).toBe("main");
    expect(analysis.title).toBe("Fix foo bug");
    expect(analysis.firstUserPrompt).toBe("Fix the bug in foo.ts");

    // Turns & messages: msg_1 spans two JSONL records but counts once, and
    // task-notification records are NOT user turns.
    expect(analysis.userTurnCount).toBe(2);
    expect(analysis.apiMessageCount).toBe(10);
    expect(analysis.models).toEqual(["claude-fable-5"]);

    // Malformed trailing line is a warning, not an error.
    expect(analysis.parseWarningCount).toBe(1);

    // Duration from first to last timestamped record.
    expect(analysis.startedAt).toBe("2026-07-09T01:00:00.000Z");
    expect(analysis.durationMs).toBe(3 * 60 * 1000);
  });

  it("deduplicates usage by message id and prices it", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    const fable = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    expect(fable).toBeDefined();
    // input: 100+120+130+140+150+160+170+180+190+200 = 1540 (msg_1 counted once)
    expect(fable?.inputTokens).toBe(1540);
    expect(fable?.outputTokens).toBe(355);
    expect(fable?.cacheCreationTokens).toBe(715);
    expect(fable?.messageCount).toBe(10);
    expect(fable?.costUsd).toBeGreaterThan(0);
    expect(analysis.usage.total.costIsComplete).toBe(true);
  });

  it("builds the context timeline and captures compaction", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    expect(analysis.contextTimeline).toHaveLength(10);
    const first = analysis.contextTimeline[0];
    expect(first?.contextTokens).toBe(100 + 0 + 200);
    expect(analysis.compactions).toHaveLength(1);
    expect(analysis.compactions[0]?.trigger).toBe("auto");
    expect(analysis.compactions[0]?.preTokens).toBe(150000);
    expect(analysis.compactions[0]?.postTokens).toBe(9000);
  });

  it("computes tool stats with error classification", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    const byName = new Map(analysis.toolStats.map((s) => [s.name, s]));
    expect(byName.get("Read")?.callCount).toBe(4);
    expect(byName.get("Read")?.errorCount).toBe(0);
    expect(byName.get("Bash")?.callCount).toBe(3);
    expect(byName.get("Bash")?.errorCount).toBe(2);
    expect(byName.get("Bash")?.errorCategories["command-failed"]).toBe(2);
    expect(byName.get("Edit")?.errorCategories["string-not-found"]).toBe(1);
    expect(byName.get("Agent")?.callCount).toBe(1);
  });

  it("detects repetitions: identical runs, file re-reads, repeated failures", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    const kinds = analysis.repetitions.map((r) => r.kind);
    expect(kinds).toContain("identical-call-run");
    expect(kinds).toContain("file-reread");
    expect(kinds).toContain("repeated-failure");

    const reread = analysis.repetitions.find((r) => r.kind === "file-reread");
    expect(reread?.subject).toBe("/p/foo.ts");
    expect(reread?.count).toBe(4);

    const failure = analysis.repetitions.find((r) => r.kind === "repeated-failure");
    expect(failure?.tool).toBe("Bash");
    expect(failure?.count).toBe(2);
  });

  it("computes the exploration profile", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    expect(analysis.exploration.readToolCalls).toBe(4);
    expect(analysis.exploration.editToolCalls).toBe(1);
    expect(analysis.exploration.readEditRatio).toBe(4);
    expect(analysis.exploration.distinctFilesRead).toBe(1);
    expect(analysis.exploration.distinctFilesEdited).toBe(1);
    expect(analysis.exploration.firstEditUserTurn).toBe(1);
    expect(analysis.exploration.timeToFirstEditMs).toBe(20_000);
  });

  it("analyzes the subagent sidecar and merges totals", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    expect(analysis.subagentCount).toBe(1);
    const agent = analysis.subagents[0];
    expect(agent?.agentId).toBe("aaaa111122223333f");
    expect(agent?.agentType).toBe("Explore");
    expect(agent?.toolUseId).toBe("toolu_agent1");
    expect(agent?.model).toBe("claude-haiku-4-5-20251001");
    expect(agent?.promptPreview).toBe("explore stuff");
    expect(agent?.usage.total.inputTokens).toBe(110);
    expect(agent?.children).toEqual([]);

    // Total usage = main + subagent.
    expect(analysis.totalUsage.inputTokens).toBe(1540 + 110);
    expect(analysis.totalUsage.costUsd).toBeGreaterThan(analysis.usage.total.costUsd);
  });

  it("reconstructs background task lifecycles from launches and notifications", async () => {
    const analysis = await analyzeSession(SESSION_FILE);
    expect(analysis.backgroundTasks).toHaveLength(2);

    const agentTask = analysis.backgroundTasks.find((t) => t.kind === "agent");
    expect(agentTask?.taskId).toBe("aaaa111122223333f");
    expect(agentTask?.name).toBe("Explore codebase");
    expect(agentTask?.status).toBe("completed");
    expect(agentTask?.durationMs).toBe(28_000);

    const bashTask = analysis.backgroundTasks.find((t) => t.kind === "bash");
    expect(bashTask?.taskId).toBe("bgtask01");
    expect(bashTask?.name).toBe("Build in background");
    expect(bashTask?.status).toBe("completed");
    expect(bashTask?.durationMs).toBe(13_000);
  });
});

describe("analyzeSession with out-of-order tool results", () => {
  it("links tool_result records that appear before their tool_use", async () => {
    const analysis = await analyzeSession(
      join(FIXTURE_PROJECTS, "-Users-test-proj/22222222-2222-2222-2222-222222222222.jsonl"),
    );
    const edit = analysis.toolStats.find((s) => s.name === "Edit");
    // Both parallel edits errored — including the one whose result precedes
    // its tool_use record in file order.
    expect(edit?.callCount).toBe(2);
    expect(edit?.errorCount).toBe(2);
    expect(edit?.missingResultCount).toBe(0);
  });
});

describe("listSessionFiles", () => {
  it("finds session files under a projects dir", async () => {
    const refs = await listSessionFiles([FIXTURE_PROJECTS]);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.sessionId)).toContain("11111111-1111-1111-1111-111111111111");
    expect(refs[0]?.projectDirName).toBe("-Users-test-proj");
  });
});
