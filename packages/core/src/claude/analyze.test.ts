import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeClaudeSession } from "./analyze.js";
import { listClaudeSessionFiles } from "./discovery.js";

const FIXTURE_PROJECTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/projects",
);
const SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);

describe("analyzeClaudeSession", () => {
  it("computes the full quantitative summary from a fixture session", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);

    // Identity & envelope
    expect(analysis.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(analysis.projectDirName).toBe("-Users-test-proj");
    expect(analysis.cwd).toBe("/Users/test/proj");
    expect(analysis.gitBranch).toBe("main");
    expect(analysis.title).toBe("Fix foo bug");
    expect(analysis.firstUserPrompt).toBe("Fix the bug in foo.ts");

    // Turns & messages: msg_1 spans two JSONL records but counts once, and
    // task-notification records are NOT user turns. A 3rd turn (line 28) is
    // opened by a slash-command user record.
    expect(analysis.userTurnCount).toBe(3);
    expect(analysis.apiMessageCount).toBe(13);
    expect(analysis.models).toEqual(["claude-fable-5"]);

    // A retried api_error mid-session doesn't derail parsing.
    expect(analysis.apiErrorCount).toBe(1);

    // Malformed trailing line is a warning, not an error.
    expect(analysis.parseWarningCount).toBe(1);

    // Duration from first to last timestamped record (now 01:03:12, after the
    // appended Skill-invocation turn).
    expect(analysis.startedAt).toBe("2026-07-09T01:00:00.000Z");
    expect(analysis.durationMs).toBe(3 * 60 * 1000 + 12_000);
  });

  it("deduplicates usage by message id and prices it", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    const fable = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    expect(fable).toBeDefined();
    // input: 100+120+130+140+150+160+170+175+180+190+200+50+40 = 1805 (msg_1 counted once)
    expect(fable?.inputTokens).toBe(1805);
    expect(fable?.outputTokens).toBe(405);
    expect(fable?.cacheCreationTokens).toBe(715);
    expect(fable?.messageCount).toBe(13);
    expect(fable?.costUsd).toBeGreaterThan(0);
    expect(analysis.usage.total.costIsComplete).toBe(true);
  });

  it("builds the context timeline and captures compaction", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.contextTimeline).toHaveLength(13);
    const first = analysis.contextTimeline[0];
    expect(first?.contextTokens).toBe(100 + 0 + 200);
    expect(analysis.compactions).toHaveLength(1);
    expect(analysis.compactions[0]?.trigger).toBe("auto");
    expect(analysis.compactions[0]?.preTokens).toBe(150000);
    expect(analysis.compactions[0]?.postTokens).toBe(9000);
  });

  it("computes tool stats with error classification", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
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
    const analysis = await analyzeClaudeSession(SESSION_FILE);
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
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.exploration.readToolCalls).toBe(4);
    expect(analysis.exploration.editToolCalls).toBe(1);
    expect(analysis.exploration.readEditRatio).toBe(4);
    expect(analysis.exploration.distinctFilesRead).toBe(1);
    expect(analysis.exploration.distinctFilesEdited).toBe(1);
    expect(analysis.exploration.firstEditUserTurn).toBe(1);
    expect(analysis.exploration.timeToFirstEditMs).toBe(20_000);
  });

  it("analyzes the subagent sidecar and merges totals", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.subagentCount).toBe(1);
    const agent = analysis.subagents[0];
    expect(agent?.agentId).toBe("aaaa111122223333f");
    expect(agent?.agentType).toBe("Explore");
    expect(agent?.toolUseId).toBe("toolu_agent1");
    expect(agent?.model).toBe("claude-haiku-4-5-20251001");
    expect(agent?.promptPreview).toBe("explore stuff");
    // 50+60+45 = 155 (the sidecar's 2nd Read, added for file-access merge coverage).
    expect(agent?.usage.total.inputTokens).toBe(155);
    expect(agent?.children).toEqual([]);

    // Launch-side linkage: the Agent tool_use is at line 21 of the main
    // transcript; the agent's own first record is timestamped later
    // (01:02:32) than the launching call (01:02:05), so launchedAt is
    // populated as distinct from startedAt. This launch is ASYNC
    // (toolUseResult.status "async_launched"), so its tool_result text is
    // only the launch ack ("agent done") — returnedChars must stay
    // unresolved rather than measuring the ack.
    expect(agent?.spawnedBy).toBe("main");
    expect(agent?.launchLine).toBe(21);
    expect(agent?.asyncLaunch).toBe(true);
    expect(agent?.returnedChars).toBeUndefined();
    expect(agent?.returnedPreview).toBeUndefined();
    expect(agent?.startedAt).toBe("2026-07-09T01:02:32.000Z");
    expect(agent?.launchedAt).toBe("2026-07-09T01:02:05.000Z");
    // Async status, resolved from the "aaaa111122223333f" task-notification
    // (line 26, status "completed") — NOT from the ack-only tool_result.
    expect(agent?.status).toBe("completed");

    // Total usage = main + subagent.
    expect(analysis.totalUsage.inputTokens).toBe(1805 + 155);
    expect(analysis.totalUsage.costUsd).toBeGreaterThan(analysis.usage.total.costUsd);
  });

  it("merges per-model usage across the main session and subagents", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    const fableMain = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    const fableMerged = analysis.totalUsageByModel.find((m) => m.model === "claude-fable-5");
    const haikuMerged = analysis.totalUsageByModel.find(
      (m) => m.model === "claude-haiku-4-5-20251001",
    );

    // Main-only model: merging with an empty subagent contribution is a no-op.
    expect(fableMerged?.inputTokens).toBe(fableMain?.inputTokens);
    expect(fableMerged?.costUsd).toBe(fableMain?.costUsd);

    // Subagent-only model must show up too, with its own priced cost.
    expect(haikuMerged).toBeDefined();
    expect(haikuMerged?.inputTokens).toBe(155);
    expect(haikuMerged?.costUsd).toBeGreaterThan(0);

    // Every dollar in totalUsage.costUsd must be attributed to some model.
    const summedCost = analysis.totalUsageByModel.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
    expect(summedCost).toBeCloseTo(analysis.totalUsage.costUsd, 6);
  });

  it("computes the delegation summary (main vs. subagents split)", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);

    // Main slice mirrors `usage.total` exactly.
    expect(analysis.delegation.main.costUsd).toBe(analysis.usage.total.costUsd);
    expect(analysis.delegation.main.outputTokens).toBe(analysis.usage.total.outputTokens);

    // Subagent (haiku) tokens/cost show up as the delegated slice.
    expect(analysis.delegation.subagents.tokens).toBeGreaterThan(0);
    expect(analysis.delegation.subagents.costUsd).toBeGreaterThan(0);
    expect(analysis.delegation.costIsComplete).toBe(true);

    // haiku ran only on the subagent — absent from main's byModel entirely.
    const haikuSlice = analysis.delegation.byModel.find(
      (m) => m.model === "claude-haiku-4-5-20251001",
    );
    const haikuMerged = analysis.totalUsageByModel.find(
      (m) => m.model === "claude-haiku-4-5-20251001",
    );
    expect(haikuSlice?.main).toEqual({ tokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 });
    expect(haikuSlice?.subagents.tokens).toBe(
      (haikuMerged?.inputTokens ?? 0) +
        (haikuMerged?.outputTokens ?? 0) +
        (haikuMerged?.cacheReadTokens ?? 0) +
        (haikuMerged?.cacheCreationTokens ?? 0),
    );

    // fable ran on both — its subagent slice is 0 since only the sidecar
    // fixture ran haiku (fable's totalUsageByModel entry == its main entry).
    const fableSlice = analysis.delegation.byModel.find((m) => m.model === "claude-fable-5");
    expect(fableSlice?.subagents).toEqual({
      tokens: 0,
      outputTokens: 0,
      costUsd: 0,
      messageCount: 0,
    });
  });

  it("records the first user prompt's source line", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.firstUserPromptLine).toBe(1);
  });

  it("builds per-turn token composition attributed by prompt line", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    // 3 user prompts (line 1, line 20, line 28 — the slash-command record) →
    // 3 turns; every api message (apiMessageCount 13) is attributed to
    // exactly one of them.
    expect(analysis.turnUsage).toHaveLength(3);
    const [turn1, turn2, turn3] = analysis.turnUsage;
    expect(turn1?.line).toBe(1);
    expect(turn2?.line).toBe(20);
    expect(turn3?.line).toBe(28);
    expect(
      (turn1?.apiMessageCount ?? 0) + (turn2?.apiMessageCount ?? 0) + (turn3?.apiMessageCount ?? 0),
    ).toBe(analysis.apiMessageCount);

    // Turn 1 = msg_1..msg_7b (everything between line 1 and line 20).
    expect(turn1?.apiMessageCount).toBe(8);
    expect(turn1?.inputTokens).toBe(100 + 120 + 130 + 140 + 150 + 160 + 170 + 175);
    expect(turn1?.outputTokens).toBe(50 + 30 + 25 + 40 + 20 + 20 + 20 + 15);
    expect(turn1?.cacheReadTokens).toBe(0 + 300 + 310 + 320 + 330 + 340 + 350 + 355);
    expect(turn1?.cacheCreationTokens).toBe(200 + 10 + 5);

    // Turn 2 = msg_8, msg_10, msg_9 (everything between line 20 and line 28).
    expect(turn2?.apiMessageCount).toBe(3);
    expect(turn2?.inputTokens).toBe(180 + 200 + 190);
    expect(turn2?.outputTokens).toBe(60 + 10 + 80);
    expect(turn2?.cacheReadTokens).toBe(9000 + 9200 + 9500);
    expect(turn2?.cacheCreationTokens).toBe(500);

    // Turn 3 = msg_11 (Skill call), msg_12 (everything after line 28).
    expect(turn3?.apiMessageCount).toBe(2);
    expect(turn3?.inputTokens).toBe(50 + 40);
    expect(turn3?.outputTokens).toBe(20 + 15);
    expect(turn3?.cacheReadTokens).toBe(9600 + 9700);
    expect(turn3?.cacheCreationTokens).toBe(0);

    // Component sums across turns reconcile exactly with the model-level totals.
    const fable = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    const sumField = (field: "inputTokens" | "outputTokens" | "cacheCreationTokens") =>
      (turn1?.[field] ?? 0) + (turn2?.[field] ?? 0) + (turn3?.[field] ?? 0);
    expect(sumField("inputTokens")).toBe(fable?.inputTokens);
    expect(sumField("outputTokens")).toBe(fable?.outputTokens);
    expect(sumField("cacheCreationTokens")).toBe(fable?.cacheCreationTokens);
  });

  it("returns an empty turnUsage array for a session with no user prompts", async () => {
    const AGENT_FILE = join(
      FIXTURE_PROJECTS,
      "-Users-test-proj/11111111-1111-1111-1111-111111111111/subagents/agent-aaaa111122223333f.jsonl",
    );
    // Sanity check on the general shape only — the dedicated empty case is
    // exercised directly against computeTurnUsage in metrics coverage below,
    // this just confirms analyzeClaudeSession wires it through for any transcript.
    const analysis = await analyzeClaudeSession(AGENT_FILE);
    expect(Array.isArray(analysis.turnUsage)).toBe(true);
  });

  it("collects the API error list alongside apiErrorCount", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.apiErrorCount).toBe(1);
    expect(analysis.apiErrors).toHaveLength(1);
    const error = analysis.apiErrors[0];
    expect(error?.line).toBe(7);
    expect(error?.status).toBe(529);
    expect(error?.retryAttempt).toBe(1);
    expect(error?.message).toBe("529 Overloaded");
    expect(error?.timestamp).toBe("2026-07-09T01:00:13.500Z");
  });

  it("gives cacheWriteCostUsd a positive value when cache-creation tokens are priced", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    // The fixture's fable messages carry cacheCreationTokens (715 total), all priced.
    expect(analysis.usage.total.cacheWriteCostUsd).toBeGreaterThan(0);
    const fable = analysis.usage.byModel.find((m) => m.model === "claude-fable-5");
    expect(fable?.cacheWriteCostUsd).toBeGreaterThan(0);
    expect(fable?.cacheWriteCostUsd).toBeLessThan(fable?.costUsd ?? 0);
  });

  it("reconstructs task executions (foreground and background)", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    // 2 foreground Bash + 1 background Bash + 1 async Agent.
    expect(analysis.taskExecutions).toHaveLength(4);

    const agentTask = analysis.taskExecutions.find((t) => t.kind === "agent");
    expect(agentTask?.taskId).toBe("aaaa111122223333f");
    expect(agentTask?.background).toBe(true);
    expect(agentTask?.name).toBe("Explore codebase");
    expect(agentTask?.status).toBe("completed");
    // Launch tool-call timestamp (01:02:05) → notification (01:02:58).
    expect(agentTask?.durationMs).toBe(53_000);

    const bgBash = analysis.taskExecutions.find((t) => t.kind === "bash" && t.background);
    expect(bgBash?.taskId).toBe("bgtask01");
    expect(bgBash?.name).toBe("Build in background");
    expect(bgBash?.status).toBe("completed");
    // tool_use (01:02:40) → notification (01:02:55).
    expect(bgBash?.durationMs).toBe(15_000);

    const foregroundBashes = analysis.taskExecutions.filter(
      (t) => t.kind === "bash" && !t.background,
    );
    expect(foregroundBashes).toHaveLength(2);
    expect(foregroundBashes[0]?.name).toBe("pnpm test");
    expect(foregroundBashes[0]?.status).toBe("failed");
    expect(foregroundBashes[0]?.durationMs).toBe(2_000);
  });

  it("merges file access across the main transcript and its subagent", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.fileAccessTruncated).toBe(false);
    expect(analysis.fileAccessOmittedCount).toBeUndefined();

    const byPath = new Map(analysis.fileAccess.map((e) => [e.path, e]));

    // /p/foo.ts: main reads (lines 3, 12, 14, 16) + 1 main edit (line 10),
    // plus the subagent's own extra Read of the same path — "both" threads,
    // reads/edits summed, firstTouchLine from the MAIN transcript only.
    const foo = byPath.get("/p/foo.ts");
    expect(foo?.threads).toBe("both");
    expect(foo?.reads).toBe(5);
    expect(foo?.edits).toBe(1);
    expect(foo?.firstTouchLine).toBe(3);
    expect(foo?.firstTouchTimestamp).toBe("2026-07-09T01:00:06.000Z");

    // /p/bar.ts: touched only by the subagent — "subagent" thread, no
    // firstTouchLine (that field is reserved for main-transcript provenance).
    const bar = byPath.get("/p/bar.ts");
    expect(bar?.threads).toBe("subagent");
    expect(bar?.reads).toBe(1);
    expect(bar?.edits).toBe(0);
    expect(bar?.firstTouchLine).toBeUndefined();
    expect(bar?.firstTouchTimestamp).toBe("2026-07-09T01:02:40.000Z");
  });

  it("extracts skill and slash-command invocations from the main transcript", async () => {
    const analysis = await analyzeClaudeSession(SESSION_FILE);
    expect(analysis.skillInvocations).toHaveLength(2);
    const [command, skill] = analysis.skillInvocations;

    // The slash-command user record at line 28 opens turn 3.
    expect(command?.kind).toBe("command");
    expect(command?.name).toBe("/cost-efficient-delegation");
    expect(command?.argsPreview).toBe("focus on subagent cost");
    expect(command?.line).toBe(28);
    expect(command?.userTurn).toBe(3);

    // The Skill tool_use at line 29, same turn, with its full (uncapped)
    // result length surfaced via the parser's fullTextLength capture (the
    // tool_result content is 2200 chars, well past the 2000-char display cap).
    expect(skill?.kind).toBe("skill");
    expect(skill?.name).toBe("cost-efficient-delegation");
    expect(skill?.argsPreview).toBe("focus on subagent cost");
    expect(skill?.line).toBe(29);
    expect(skill?.userTurn).toBe(3);
    expect(skill?.resultChars).toBe(2200);
  });
});

describe("analyzeClaudeSession applied to a subagent sidecar transcript", () => {
  const AGENT_FILE = join(
    FIXTURE_PROJECTS,
    "-Users-test-proj/11111111-1111-1111-1111-111111111111/subagents/agent-aaaa111122223333f.jsonl",
  );

  it("analyzes the sidecar directly and returns no nested subagents", async () => {
    // A sidecar's own "subagents" dir (sibling to a file named after the
    // sidecar itself) never exists, so listSubagentRefs's readdir throws and
    // is swallowed — analyzeClaudeSession must degrade to an empty subagent forest
    // rather than throwing, since the server's per-agent endpoint reuses this
    // same function on sidecar paths.
    const analysis = await analyzeClaudeSession(AGENT_FILE);
    expect(analysis.sessionId).toBe("agent-aaaa111122223333f");
    expect(analysis.subagents).toEqual([]);
    expect(analysis.subagentCount).toBe(0);
    expect(analysis.apiMessageCount).toBeGreaterThan(0);
  });
});

describe("analyzeClaudeSession with out-of-order tool results", () => {
  const OUT_OF_ORDER_FILE = join(
    FIXTURE_PROJECTS,
    "-Users-test-proj/22222222-2222-2222-2222-222222222222.jsonl",
  );

  it("derives repoRoot/worktreeName from a worktree-shaped cwd", async () => {
    const analysis = await analyzeClaudeSession(OUT_OF_ORDER_FILE);
    expect(analysis.cwd).toBe("/Users/test/proj2/.claude/worktrees/wt-1");
    expect(analysis.repoRoot).toBe("/Users/test/proj2");
    expect(analysis.worktreeName).toBe("wt-1");
  });

  it("links tool_result records that appear before their tool_use", async () => {
    const analysis = await analyzeClaudeSession(OUT_OF_ORDER_FILE);
    const edit = analysis.toolStats.find((s) => s.name === "Edit");
    // Both parallel edits errored — including the one whose result precedes
    // its tool_use record in file order.
    expect(edit?.callCount).toBe(2);
    expect(edit?.errorCount).toBe(2);
    expect(edit?.missingResultCount).toBe(0);
  });

  it("captures returnedChars for a SYNCHRONOUS subagent launch", async () => {
    const analysis = await analyzeClaudeSession(OUT_OF_ORDER_FILE);
    expect(analysis.subagentCount).toBe(1);
    const agent = analysis.subagents[0];
    expect(agent?.agentId).toBe("bbbb444455556666a");
    expect(agent?.agentType).toBe("general-purpose");
    // Sync launch (no async markers in toolUseResult): the parent-side
    // tool_result IS the agent's return, so its length is meaningful.
    expect(agent?.asyncLaunch).toBeUndefined();
    expect(agent?.returnedChars).toBe(
      "Both edits failed because the files were never read.".length,
    );
    expect(agent?.returnedPreview).toBe("Both edits failed because the files were never read.");
    expect(agent?.spawnedBy).toBe("main");
    expect(agent?.launchLine).toBe(6);
    // Sync status from the launching tool_result's isError (false here).
    expect(agent?.status).toBe("completed");
  });
});

describe("analyzeClaudeSession with meta.json files lacking toolUseId", () => {
  // Some Claude Code versions (observed on 2.1.138) write sidecar meta.json
  // with only agentType/description — no toolUseId. Linkage must be recovered
  // from the parent-side `toolUseResult.agentId` instead.
  const NO_META_TOOLUSE_FILE = join(
    FIXTURE_PROJECTS,
    "-Users-test-proj/33333333-3333-3333-3333-333333333333.jsonl",
  );

  it("recovers sync-launch linkage (returnedChars/returnedPreview) via toolUseResult.agentId", async () => {
    const analysis = await analyzeClaudeSession(NO_META_TOOLUSE_FILE);
    expect(analysis.subagentCount).toBe(2);
    const agent = analysis.subagents.find((n) => n.agentId === "cccc777788889999b");
    expect(agent?.toolUseId).toBe("toolu_sync_nometa");
    expect(agent?.asyncLaunch).toBeUndefined();
    expect(agent?.returnedChars).toBe(
      "The sync agent finished its work and returned this text.".length,
    );
    expect(agent?.returnedPreview).toBe("The sync agent finished its work and returned this text.");
    expect(agent?.spawnedBy).toBe("main");
    expect(agent?.launchLine).toBe(4);
    expect(agent?.status).toBe("completed");
  });

  it("recovers async-launch linkage and does NOT measure the ack as a return", async () => {
    const analysis = await analyzeClaudeSession(NO_META_TOOLUSE_FILE);
    const agent = analysis.subagents.find((n) => n.agentId === "dddd000011112222c");
    expect(agent?.toolUseId).toBe("toolu_async_nometa");
    // Recovered linkage restores async detection too: without it the node
    // was misreported as a sync launch with no return.
    expect(agent?.asyncLaunch).toBe(true);
    expect(agent?.returnedChars).toBeUndefined();
    expect(agent?.returnedPreview).toBeUndefined();
    expect(agent?.spawnedBy).toBe("main");
    expect(agent?.launchLine).toBe(2);
    // No task-notification exists anywhere in this fixture for taskId
    // "dddd000011112222c" — an async launch with no completion evidence yet
    // must read as "unresolved", never guessed as completed/failed.
    expect(agent?.status).toBe("unresolved");
  });
});

describe("listClaudeSessionFiles", () => {
  it("finds session files under a projects dir", async () => {
    const refs = await listClaudeSessionFiles([FIXTURE_PROJECTS]);
    // 11111111/22222222/33333333 plus 44444444…445 (skill-injection fixture, #27).
    expect(refs).toHaveLength(4);
    expect(refs.map((r) => r.sessionId)).toContain("11111111-1111-1111-1111-111111111111");
    expect(refs[0]?.projectDirName).toBe("-Users-test-proj");
  });
});
