import { describe, expect, it } from "vitest";
import type { ModelUsageSummary, SubagentNodeJson, WorkflowRunSummaryJson } from "../../api.js";
import {
  activeModels,
  costShare,
  displayName,
  findAgentPath,
  flattenSubagents,
  groupedTreeRows,
  isSessionLive,
  mainDelegatedSplit,
  mainDelegatedTokenSplit,
  nodeStatus,
  SESSION_LIVE_THRESHOLD_MS,
  spawnedByLabel,
  subtreeCost,
  workflowHeaderStatus,
} from "./agentTree.js";

function usage(costUsd: number) {
  return {
    byModel: [],
    total: {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
      costIsComplete: true,
    },
  };
}

function node(
  agentId: string,
  costUsd: number,
  children: SubagentNodeJson[] = [],
): SubagentNodeJson {
  return {
    agentId,
    usage: usage(costUsd),
    toolCallCount: 1,
    toolErrorCount: 0,
    children,
  };
}

describe("flattenSubagents", () => {
  it("box-draws a two-level tree with the right prefixes and depths", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    const research = node("research-agent", 0.94);
    const rows = flattenSubagents([research, testWriter]);

    expect(rows.map((r) => `${r.prefix}${r.id}`)).toEqual([
      "├ research-agent",
      "└ test-writer",
      "  └ lint-fixer",
    ]);
    expect(rows.find((r) => r.id === "lint-fixer")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "lint-fixer")?.nested).toBe(true);
    expect(rows.find((r) => r.id === "research-agent")?.nested).toBe(false);
  });

  it("keeps the connecting bar under a non-last root's nested children", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    const docScanner = node("doc-scanner", 0.11);
    // test-writer is NOT the last root here (doc-scanner follows), so its
    // nested child's prefix carries "│" instead of blank spacing.
    const rows = flattenSubagents([testWriter, docScanner]);
    expect(rows.map((r) => `${r.prefix}${r.id}`)).toEqual([
      "├ test-writer",
      "│ └ lint-fixer",
      "└ doc-scanner",
    ]);
    expect(rows.map((r) => [r.id, r.ancestorIsLast, r.isLast])).toEqual([
      ["test-writer", [], false],
      ["lint-fixer", [false], true],
      ["doc-scanner", [], true],
    ]);
  });

  it("flattens under a base spine at an offset depth, keeping ├ on the last root when more siblings follow", () => {
    const member = node("wf-member", 0.2);

    // Inside a non-last run (base [false]) with another phase group following:
    // the member sits at depth 2, under main's open spine, and keeps ├.
    const midSpine = flattenSubagents([member], [false], true);
    expect(midSpine.map((r) => [r.id, r.depth, r.ancestorIsLast, r.isLast])).toEqual([
      ["wf-member", 2, [false], false],
    ]);
    expect(midSpine[0]?.prefix).toBe("│ ├ ");

    // Inside the LAST run (base [true]) with nothing following: └ closes.
    const closing = flattenSubagents([member], [true]);
    expect(closing.map((r) => [r.id, r.isLast])).toEqual([["wf-member", true]]);
    expect(closing[0]?.prefix).toBe("  └ ");
  });

  it("propagates a moreSiblingsFollow root's open spine to its nested children", () => {
    const child = node("child", 0.1);
    const parent = node("parent", 0.2, [child]);
    const rows = flattenSubagents([parent], [], true);
    // parent keeps ├ (isLast false), so the child's guide column carries │.
    expect(rows.map((r) => `${r.prefix}${r.id}`)).toEqual(["├ parent", "│ └ child"]);
  });
});

describe("subtreeCost", () => {
  it("sums a node's own cost with every descendant's, recursively", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    expect(subtreeCost(testWriter)).toBeCloseTo(1.95, 6);
    expect(subtreeCost(lintFixer)).toBeCloseTo(0.09, 6);
  });
});

describe("costShare", () => {
  it("returns the part/total fraction", () => {
    expect(costShare(25, 100)).toBeCloseTo(0.25, 6);
    expect(costShare(100, 100)).toBeCloseTo(1, 6);
  });

  it("returns undefined rather than dividing by zero (or a negative) total", () => {
    expect(costShare(5, 0)).toBeUndefined();
    expect(costShare(5, -1)).toBeUndefined();
  });
});

describe("isSessionLive", () => {
  const NOW = Date.parse("2026-07-13T12:00:00.000Z");

  it("is live just inside the threshold", () => {
    const recent = new Date(NOW - (SESSION_LIVE_THRESHOLD_MS - 1000)).toISOString();
    expect(isSessionLive(recent, NOW)).toBe(true);
  });

  it("is not live once the threshold has fully elapsed", () => {
    const stale = new Date(NOW - SESSION_LIVE_THRESHOLD_MS - 1000).toISOString();
    expect(isSessionLive(stale, NOW)).toBe(false);
  });

  it("is not live for an undefined lastActivityAt", () => {
    expect(isSessionLive(undefined, NOW)).toBe(false);
  });

  it("is not live for an unparseable timestamp", () => {
    expect(isSessionLive("not-a-date", NOW)).toBe(false);
  });
});

describe("nodeStatus", () => {
  it("maps completed/failed straight through regardless of session liveness", () => {
    expect(nodeStatus({ status: "completed" }, true)).toBe("done");
    expect(nodeStatus({ status: "completed" }, false)).toBe("done");
    expect(nodeStatus({ status: "failed" }, true)).toBe("fail");
    expect(nodeStatus({ status: "failed" }, false)).toBe("fail");
  });

  it("reads unresolved as run only while the session still looks live", () => {
    expect(nodeStatus({ status: "unresolved" }, true)).toBe("run");
    expect(nodeStatus({ status: "unresolved" }, false)).toBeUndefined();
  });

  it("returns undefined for a Codex node (status never set) regardless of liveness", () => {
    expect(nodeStatus({ status: undefined }, true)).toBeUndefined();
    expect(nodeStatus({ status: undefined }, false)).toBeUndefined();
  });
});

describe("workflowHeaderStatus", () => {
  it("maps a completed run to done regardless of session liveness", () => {
    expect(workflowHeaderStatus("completed", true)).toBe("done");
    expect(workflowHeaderStatus("completed", false)).toBe("done");
  });

  it("maps kill/error/fail/cancel-shaped statuses to fail, case-insensitively", () => {
    expect(workflowHeaderStatus("killed", true)).toBe("fail");
    expect(workflowHeaderStatus("killed", false)).toBe("fail");
    expect(workflowHeaderStatus("error", true)).toBe("fail");
    expect(workflowHeaderStatus("failed", true)).toBe("fail");
    expect(workflowHeaderStatus("cancelled", true)).toBe("fail");
  });

  it("reads an undefined status (no run-state file yet) as run only while the session looks live", () => {
    expect(workflowHeaderStatus(undefined, true)).toBe("run");
    expect(workflowHeaderStatus(undefined, false)).toBeUndefined();
  });

  it("reads any other in-progress status the same live-gated way", () => {
    expect(workflowHeaderStatus("running", true)).toBe("run");
    expect(workflowHeaderStatus("running", false)).toBeUndefined();
  });
});

describe("mainDelegatedSplit", () => {
  it("computes the main/delegated cost share by percent, complementary", () => {
    const session = {
      usage: { total: { costUsd: 17.29 } },
      totalUsage: { costUsd: 23.41 },
    } as never;
    const { mainPct, delegatedPct } = mainDelegatedSplit(session);
    expect(mainPct).toBe(74);
    expect(delegatedPct).toBe(26);
  });

  it("reports 0/0 rather than dividing by zero when there's no priced usage", () => {
    const session = {
      usage: { total: { costUsd: 0 } },
      totalUsage: { costUsd: 0 },
    } as never;
    expect(mainDelegatedSplit(session)).toEqual({ mainPct: 0, delegatedPct: 0 });
  });
});

describe("mainDelegatedTokenSplit", () => {
  it("computes the main/delegated TOKEN share by percent, complementary", () => {
    const session = {
      delegation: {
        main: { tokens: 2260, outputTokens: 0 },
        subagents: { tokens: 7740, outputTokens: 0 },
      },
    } as never;
    const { mainPct, delegatedPct } = mainDelegatedTokenSplit(session);
    expect(mainPct).toBe(23);
    expect(delegatedPct).toBe(77);
  });

  it("reports 0/0 rather than dividing by zero when there are no tokens at all", () => {
    const session = {
      delegation: {
        main: { tokens: 0, outputTokens: 0 },
        subagents: { tokens: 0, outputTokens: 0 },
      },
    } as never;
    expect(mainDelegatedTokenSplit(session)).toEqual({ mainPct: 0, delegatedPct: 0 });
  });

  it("can rank in the opposite direction from the cost split (the inversion the header surfaces)", () => {
    // Same shape as the dogfooding example: main did 55.9% of cost but only
    // 22.6% of tokens — cost and token shares disagree about who did "most"
    // of the work.
    const costSession = {
      usage: { total: { costUsd: 63.18 } },
      totalUsage: { costUsd: 113.02 },
    } as never;
    const tokenSession = {
      delegation: {
        main: { tokens: 2260, outputTokens: 0 },
        subagents: { tokens: 7740, outputTokens: 0 },
      },
    } as never;
    expect(mainDelegatedSplit(costSession).mainPct).toBe(56);
    expect(mainDelegatedTokenSplit(tokenSession).mainPct).toBe(23);
  });
});

describe("findAgentPath", () => {
  it("returns the root-first ancestor chain, inclusive of the target", () => {
    const lintFixer = node("lint-fixer", 0.09);
    const testWriter = node("test-writer", 1.86, [lintFixer]);
    const research = node("research-agent", 0.94);

    expect(findAgentPath([research, testWriter], "lint-fixer")?.map((n) => n.agentId)).toEqual([
      "test-writer",
      "lint-fixer",
    ]);
    expect(findAgentPath([research, testWriter], "research-agent")?.map((n) => n.agentId)).toEqual([
      "research-agent",
    ]);
  });

  it("returns undefined when the agentId isn't anywhere in the forest", () => {
    const research = node("research-agent", 0.94);
    expect(findAgentPath([research], "does-not-exist")).toBeUndefined();
  });
});

function modelUsage(model: string, overrides: Partial<ModelUsageSummary> = {}): ModelUsageSummary {
  return {
    model,
    messageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe("activeModels", () => {
  it("returns every model with real activity, cost descending — the SendMessage override case", () => {
    // Mirrors the dogfooding example (session acca8a8c-36c7-42d2-be69-46fa1473ab2b,
    // subagent a4a92f13): a subagent silently switched from its assigned
    // sonnet to the expensive session model (fable) mid-run, so usage.byModel
    // carries both — a single-model badge used to hide the fable side
    // entirely.
    const sonnet = modelUsage("claude-sonnet-4-5", {
      messageCount: 149,
      outputTokens: 12000,
      costUsd: 6.72,
    });
    const fable = modelUsage("claude-fable-5", {
      messageCount: 57,
      outputTokens: 9000,
      costUsd: 18.21,
    });
    expect(activeModels([sonnet, fable]).map((m) => m.model)).toEqual([
      "claude-fable-5",
      "claude-sonnet-4-5",
    ]);
  });

  it("returns the single entry unchanged for a single-model node", () => {
    const sonnet = modelUsage("claude-sonnet-4-5", { outputTokens: 500, costUsd: 0.42 });
    expect(activeModels([sonnet])).toEqual([sonnet]);
  });

  it("excludes a zero-usage entry even when messageCount > 0 — a logged '<synthetic>' stub must never count as an active model", () => {
    // Shape mirrors Claude Code's real "<synthetic>" harness stub (see
    // @junrei/core's metrics.test.ts): the message happened (messageCount: 1)
    // but moved no tokens and billed nothing, so `messageCount` alone can't
    // be the activity signal — only token volume / cost qualifies.
    const sonnet = modelUsage("claude-sonnet-4-5", { outputTokens: 500, costUsd: 0.42 });
    const synthetic = modelUsage("<synthetic>", { messageCount: 1, costUsd: 0 });
    expect(activeModels([sonnet, synthetic]).map((m) => m.model)).toEqual(["claude-sonnet-4-5"]);
  });

  it("returns [] when every entry is zero-usage (no active model at all)", () => {
    const synthetic = modelUsage("<synthetic>", { messageCount: 1, costUsd: 0 });
    expect(activeModels([synthetic])).toEqual([]);
  });

  it("returns [] for an empty byModel — the Codex-safety no-data case", () => {
    expect(activeModels([])).toEqual([]);
  });
});

describe("spawnedByLabel", () => {
  it("resolves to the parent's display name, or 'main' at the root", () => {
    const lintFixer: SubagentNodeJson = { ...node("lint-fixer", 0.09), spawnedBy: "test-writer" };
    const testWriter: SubagentNodeJson = {
      ...node("test-writer", 1.86, [lintFixer]),
      description: "test-writer",
      spawnedBy: "main",
    };
    expect(spawnedByLabel(lintFixer, [testWriter])).toBe("test-writer");
    expect(spawnedByLabel(testWriter, [testWriter])).toBe("main");
  });
});

describe("groupedTreeRows", () => {
  it("synthesizes a workflow header for a member whose runId has no entry in workflowRuns, instead of dropping it", () => {
    // Mirrors the still-running-workflow bug: Claude Code writes agent
    // sidecars under subagents/workflows/<runId>/ immediately, but
    // workflows/<runId>.json only once the run completes — `workflowRuns`
    // can be `[]` (or just missing this run) while the member node is
    // already discovered.
    const orphanMember: SubagentNodeJson = {
      ...node("wf-agent-1", 0.5),
      workflowRunId: "wf_run_orphan",
      startedAt: "2026-07-10T00:05:00.000Z",
    };
    const rows = groupedTreeRows([orphanMember], []);
    expect(rows.map((r) => r.kind)).toEqual(["workflow-header", "agent"]);

    const header = rows[0];
    if (header?.kind !== "workflow-header") throw new Error("expected a workflow-header row");
    expect(header.runId).toBe("wf_run_orphan");
    expect(header.name).toBeUndefined();
    expect(header.status).toBeUndefined();
    expect(header.agentCount).toBe(1);

    const agentRow = rows[1];
    if (agentRow?.kind !== "agent") throw new Error("expected an agent row");
    expect(agentRow.row.id).toBe("wf-agent-1");
  });

  it("interleaves orphan and known run groups chronologically instead of always trailing orphans behind known runs", () => {
    // Regression coverage for the old behavior this replaces: `known` and
    // `orphan` used to render in that fixed order (workflowRuns first,
    // orphans after) regardless of when either actually started. Here the
    // orphan starts EARLIER, so it must render FIRST.
    const known: SubagentNodeJson = {
      ...node("wf-known", 0.1),
      workflowRunId: "wf_run1",
      startedAt: "2026-07-10T01:00:00.000Z",
    };
    const orphan: SubagentNodeJson = {
      ...node("wf-orphan", 0.2),
      workflowRunId: "wf_run_orphan",
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    const knownRun: WorkflowRunSummaryJson = {
      runId: "wf_run1",
      name: "widget-research",
      agentCount: 1,
      phases: [],
    };
    const rows = groupedTreeRows([known, orphan], [knownRun]);
    const headers = rows.filter((r) => r.kind === "workflow-header");
    expect(headers.map((h) => h.runId)).toEqual(["wf_run_orphan", "wf_run1"]);
    expect(headers[0]?.name).toBeUndefined();
    expect(headers[1]?.name).toBe("widget-research");
  });

  it("orders multiple orphan runs by their earliest member's startedAt, undefined-started runs last", () => {
    const later: SubagentNodeJson = {
      ...node("wf-b", 0.1),
      workflowRunId: "wf_run_b",
      startedAt: "2026-07-10T01:00:00.000Z",
    };
    const earlier: SubagentNodeJson = {
      ...node("wf-a", 0.1),
      workflowRunId: "wf_run_a",
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    const noStart: SubagentNodeJson = { ...node("wf-c", 0.1), workflowRunId: "wf_run_c" };
    const rows = groupedTreeRows([later, earlier, noStart], []);
    const headerRunIds = rows.filter((r) => r.kind === "workflow-header").map((r) => r.runId);
    expect(headerRunIds).toEqual(["wf_run_a", "wf_run_b", "wf_run_c"]);
  });

  it("orders workflow run groups by start time, even when that's the exact reverse of runId lexicographic order", () => {
    // Reproduces the real bug (session 77bd3b76-fa3a-4ad2-b3e4-d05e375c7ad2):
    // runs wf_a3ec... and wf_d2a6... rendered out of launch order because
    // 'a3ec…' < 'd2a6…' lexicographically even though wf_d2a6 actually
    // started first. Here three runIds sort alphabetically as
    // wf_a, wf_b, wf_c but must render in the OPPOSITE order chronologically.
    const runC: SubagentNodeJson = {
      ...node("agent-c", 0.1),
      workflowRunId: "wf_c",
      startedAt: "2026-07-10T00:00:00.000Z", // earliest
    };
    const runB: SubagentNodeJson = {
      ...node("agent-b", 0.1),
      workflowRunId: "wf_b",
      startedAt: "2026-07-10T01:00:00.000Z", // middle
    };
    const runA: SubagentNodeJson = {
      ...node("agent-a", 0.1),
      workflowRunId: "wf_a",
      startedAt: "2026-07-10T02:00:00.000Z", // latest
    };
    const runs: WorkflowRunSummaryJson[] = [
      { runId: "wf_a", agentCount: 1, phases: [] },
      { runId: "wf_b", agentCount: 1, phases: [] },
      { runId: "wf_c", agentCount: 1, phases: [] },
    ];
    const rows = groupedTreeRows([runA, runB, runC], runs);
    const headerRunIds = rows.filter((r) => r.kind === "workflow-header").map((r) => r.runId);
    expect(headerRunIds).toEqual(["wf_c", "wf_b", "wf_a"]);
  });

  it("slots a synthesized in-progress run (no sidecar, phases: [], no status) chronologically between two sidecar-backed runs, not appended after both", () => {
    // `analyze.ts`'s `buildWorkflowRunSummaries` appends synthesized (still
    // in-flight, no `workflows/<runId>.json` yet) entries AFTER every parsed
    // entry in `workflowRuns` — so the raw input order here mirrors that
    // real shape: two sidecar-backed runs first, the synthesized run last.
    // Its members started in between the other two, so it must render in
    // between them too.
    const early: SubagentNodeJson = {
      ...node("agent-early", 0.1),
      workflowRunId: "wf_early",
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    const mid: SubagentNodeJson = {
      ...node("agent-mid", 0.1),
      workflowRunId: "wf_mid_synthesized",
      startedAt: "2026-07-10T01:00:00.000Z",
    };
    const late: SubagentNodeJson = {
      ...node("agent-late", 0.1),
      workflowRunId: "wf_late",
      startedAt: "2026-07-10T02:00:00.000Z",
    };
    const runs: WorkflowRunSummaryJson[] = [
      { runId: "wf_early", status: "completed", agentCount: 1, phases: [] },
      { runId: "wf_late", status: "completed", agentCount: 1, phases: [] },
      // Synthesized shape: no status/durationMs, empty phases, listed last.
      { runId: "wf_mid_synthesized", agentCount: 1, phases: [] },
    ];
    const rows = groupedTreeRows([early, mid, late], runs);
    const headerRunIds = rows.filter((r) => r.kind === "workflow-header").map((r) => r.runId);
    expect(headerRunIds).toEqual(["wf_early", "wf_mid_synthesized", "wf_late"]);
  });

  it("sorts a run with no start-time evidence at all last, tie-broken by runId among other unknown-start runs", () => {
    const knownStart: SubagentNodeJson = {
      ...node("agent-known", 0.1),
      workflowRunId: "wf_known",
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    const unknownZ: SubagentNodeJson = { ...node("agent-z", 0.1), workflowRunId: "wf_zzz_unknown" };
    const unknownA: SubagentNodeJson = { ...node("agent-a", 0.1), workflowRunId: "wf_aaa_unknown" };
    const runs: WorkflowRunSummaryJson[] = [
      { runId: "wf_known", agentCount: 1, phases: [] },
      { runId: "wf_zzz_unknown", agentCount: 1, phases: [] },
      { runId: "wf_aaa_unknown", agentCount: 1, phases: [] },
    ];
    const rows = groupedTreeRows([knownStart, unknownZ, unknownA], runs);
    const headerRunIds = rows.filter((r) => r.kind === "workflow-header").map((r) => r.runId);
    expect(headerRunIds).toEqual(["wf_known", "wf_aaa_unknown", "wf_zzz_unknown"]);
  });

  it("falls back to the run summary's earliestAgentStartMs when no member node carries a startedAt", () => {
    // A run whose members exist (so the group still renders) but whose
    // sidecar transcripts carry no usable startedAt at all — the run-state
    // file's own workflowProgress-derived earliestAgentStartMs is the only
    // remaining start-time evidence, and it must still slot the run
    // chronologically rather than sorting it as "unknown".
    const knownStart: SubagentNodeJson = {
      ...node("agent-known", 0.1),
      workflowRunId: "wf_known",
      startedAt: "2026-07-10T02:00:00.000Z",
    };
    const noMemberStart: SubagentNodeJson = {
      ...node("agent-no-start", 0.1),
      workflowRunId: "wf_fallback",
    };
    const runs: WorkflowRunSummaryJson[] = [
      { runId: "wf_known", agentCount: 1, phases: [] },
      {
        runId: "wf_fallback",
        agentCount: 1,
        phases: [],
        earliestAgentStartMs: Date.parse("2026-07-10T00:00:00.000Z"),
      },
    ];
    const rows = groupedTreeRows([knownStart, noMemberStart], runs);
    const headerRunIds = rows.filter((r) => r.kind === "workflow-header").map((r) => r.runId);
    expect(headerRunIds).toEqual(["wf_fallback", "wf_known"]);
  });

  it("still returns [] for a session with no subagents and no workflow runs at all", () => {
    expect(groupedTreeRows([], [])).toEqual([]);
  });

  it("computes the header duration from the member span, not the run-state durationMs, on a killed-and-resumed run", () => {
    // Motivating case, modeled on a real session (87da72a3-5ecf-4688-8ff8-3ff833be7013,
    // run wf_9bbab5e3-d95 "pr1-core-mcp"): the run-state file's durationMs
    // (275223ms) only covers the FINAL execution segment after a
    // kill+resume that reuses the runId — the state file is overwritten and
    // startTime resets. Member timestamps accumulate across every segment,
    // so the header must use their span instead.
    const memberA: SubagentNodeJson = {
      ...node("implement", 1),
      workflowRunId: "wf_9bbab5e3-d95",
      startedAt: "2026-07-19T06:45:42.784Z",
      endedAt: "2026-07-19T07:07:57.260Z",
    };
    const memberB: SubagentNodeJson = {
      ...node("verify", 1),
      workflowRunId: "wf_9bbab5e3-d95",
      startedAt: "2026-07-19T07:29:37.140Z",
      endedAt: "2026-07-19T07:31:26.104Z",
    };
    const run: WorkflowRunSummaryJson = {
      runId: "wf_9bbab5e3-d95",
      name: "pr1-core-mcp",
      agentCount: 2,
      durationMs: 275223,
      phases: [],
    };
    const rows = groupedTreeRows([memberA, memberB], [run]);
    const header = rows.find((r) => r.kind === "workflow-header");
    if (header?.kind !== "workflow-header") throw new Error("expected a workflow-header row");

    const expectedSpanMs =
      Date.parse("2026-07-19T07:31:26.104Z") - Date.parse("2026-07-19T06:45:42.784Z");
    expect(header.durationMs).toBe(expectedSpanMs);
    expect(header.durationMs).not.toBe(275223);
  });

  it("falls back to the run summary's durationMs when no member has usable timestamps", () => {
    const memberA: SubagentNodeJson = { ...node("wf-a", 0.1), workflowRunId: "wf_run1" };
    const run: WorkflowRunSummaryJson = {
      runId: "wf_run1",
      agentCount: 1,
      durationMs: 12345,
      phases: [],
    };
    const rows = groupedTreeRows([memberA], [run]);
    const header = rows.find((r) => r.kind === "workflow-header");
    if (header?.kind !== "workflow-header") throw new Error("expected a workflow-header row");
    expect(header.durationMs).toBe(12345);
  });

  it("omits durationMs entirely when neither member timestamps nor a run-state value are available", () => {
    // Orphan run: no workflowRuns entry at all, and its member has no
    // startedAt/endedAt either.
    const memberA: SubagentNodeJson = { ...node("wf-a", 0.1), workflowRunId: "wf_run_orphan" };
    const rows = groupedTreeRows([memberA], []);
    const header = rows.find((r) => r.kind === "workflow-header");
    if (header?.kind !== "workflow-header") throw new Error("expected a workflow-header row");
    expect(header.durationMs).toBeUndefined();
    expect("durationMs" in header).toBe(false);
  });

  it("extends the member span into descendants, not just root members", () => {
    const child: SubagentNodeJson = {
      ...node("nested-child", 0.1),
      startedAt: "2026-07-19T06:50:00.000Z",
      endedAt: "2026-07-19T08:00:00.000Z",
    };
    const rootMember: SubagentNodeJson = {
      ...node("root-member", 0.1, [child]),
      workflowRunId: "wf_run1",
      startedAt: "2026-07-19T06:45:00.000Z",
      endedAt: "2026-07-19T07:00:00.000Z",
    };
    const run: WorkflowRunSummaryJson = { runId: "wf_run1", agentCount: 1, phases: [] };
    const rows = groupedTreeRows([rootMember], [run]);
    const header = rows.find((r) => r.kind === "workflow-header");
    if (header?.kind !== "workflow-header") throw new Error("expected a workflow-header row");

    const expectedSpanMs =
      Date.parse("2026-07-19T08:00:00.000Z") - Date.parse("2026-07-19T06:45:00.000Z");
    expect(header.durationMs).toBe(expectedSpanMs);
  });

  it("spans from the earliest start to the latest end when one member is still in flight (no endedAt)", () => {
    const finished: SubagentNodeJson = {
      ...node("finished", 0.1),
      workflowRunId: "wf_run1",
      startedAt: "2026-07-19T06:50:00.000Z",
      endedAt: "2026-07-19T07:10:00.000Z",
    };
    // Still running: earlier startedAt, no endedAt yet.
    const inFlight: SubagentNodeJson = {
      ...node("in-flight", 0.1),
      workflowRunId: "wf_run1",
      startedAt: "2026-07-19T06:40:00.000Z",
    };
    const run: WorkflowRunSummaryJson = { runId: "wf_run1", agentCount: 2, phases: [] };
    const rows = groupedTreeRows([finished, inFlight], [run]);
    const header = rows.find((r) => r.kind === "workflow-header");
    if (header?.kind !== "workflow-header") throw new Error("expected a workflow-header row");

    const expectedSpanMs =
      Date.parse("2026-07-19T07:10:00.000Z") - Date.parse("2026-07-19T06:40:00.000Z");
    expect(header.durationMs).toBe(expectedSpanMs);
  });

  it("renders run groups as depth-1 siblings after the classic roots — last classic keeps ├, only the final run header closes with └", () => {
    const classic = node("classic-1", 0.1);
    const memberA: SubagentNodeJson = { ...node("wf-a", 0.2), workflowRunId: "wf_run_a" };
    const memberB: SubagentNodeJson = { ...node("wf-b", 0.3), workflowRunId: "wf_run_b" };
    const runs: WorkflowRunSummaryJson[] = [
      { runId: "wf_run_a", name: "a", agentCount: 1, phases: [] },
      { runId: "wf_run_b", name: "b", agentCount: 1, phases: [] },
    ];
    const rows = groupedTreeRows([classic, memberA, memberB], runs);

    const classicRow = rows[0];
    if (classicRow?.kind !== "agent") throw new Error("expected an agent row first");
    // Run groups follow at the same sibling level, so the last classic root
    // no longer closes main's spine.
    expect(classicRow.row.isLast).toBe(false);

    const headers = rows.filter((r) => r.kind === "workflow-header");
    expect(headers.map((h) => [h.runId, h.isLast])).toEqual([
      ["wf_run_a", false],
      ["wf_run_b", true],
    ]);
  });

  it("nests phase members at depth 3 under their band — each phase closes its own spine, bands are the run's depth-2 children", () => {
    const imp: SubagentNodeJson = {
      ...node("imp", 0.2),
      workflowRunId: "wf_run1",
      workflowPhase: "Implement",
    };
    const ship: SubagentNodeJson = {
      ...node("ship", 0.1),
      workflowRunId: "wf_run1",
      workflowPhase: "Ship",
    };
    const run: WorkflowRunSummaryJson = {
      runId: "wf_run1",
      name: "r",
      agentCount: 2,
      phases: [{ title: "Implement" }, { title: "Ship" }],
    };
    const rows = groupedTreeRows([imp, ship], [run]);
    expect(rows.map((r) => (r.kind === "agent" ? r.row.id : r.kind))).toEqual([
      "workflow-header",
      "phase-header",
      "imp",
      "phase-header",
      "ship",
    ]);

    const bands = rows.filter((r) => r.kind === "phase-header");
    // Bands are siblings on the run's spine: only the final one closes it.
    expect(bands.map((band) => [band.phaseTitle, band.isLast])).toEqual([
      ["Implement", false],
      ["Ship", true],
    ]);

    const impRow = rows[2];
    const shipRow = rows[4];
    if (impRow?.kind !== "agent" || shipRow?.kind !== "agent") {
      throw new Error("expected agent rows at indexes 2 and 4");
    }
    // Members sit one level under their band: depth 3, ancestor spine
    // [runIsLast, phaseIsLast], and each phase's last member gets └ of its
    // own — no cross-phase member spine anymore.
    expect(impRow.row.depth).toBe(3);
    expect(impRow.row.ancestorIsLast).toEqual([true, false]);
    expect(impRow.row.isLast).toBe(true);
    expect(shipRow.row.depth).toBe(3);
    expect(shipRow.row.ancestorIsLast).toEqual([true, true]);
    expect(shipRow.row.isLast).toBe(true);
  });

  it("quarantines phase-less members under an untracked pseudo-band — but only when a named band rendered above", () => {
    const imp: SubagentNodeJson = {
      ...node("imp", 0.2),
      workflowRunId: "wf_run1",
      workflowPhase: "Implement",
    };
    const stray: SubagentNodeJson = { ...node("stray", 0.1), workflowRunId: "wf_run1" };
    const run: WorkflowRunSummaryJson = {
      runId: "wf_run1",
      name: "r",
      agentCount: 2,
      phases: [{ title: "Implement" }],
    };
    const rows = groupedTreeRows([imp, stray], [run]);
    expect(
      rows.map((r) => {
        if (r.kind === "agent") return r.row.id;
        if (r.kind === "phase-header") return `phase:${r.phaseTitle ?? "untracked"}`;
        return r.kind;
      }),
    ).toEqual(["workflow-header", "phase:Implement", "imp", "phase:untracked", "stray"]);

    // An orphan run has no named phases at all — members hang straight under
    // the header, no pseudo-band (nothing to misattribute them to).
    const orphan: SubagentNodeJson = { ...node("only", 0.1), workflowRunId: "wf_orphan" };
    expect(groupedTreeRows([orphan], []).map((r) => r.kind)).toEqual(["workflow-header", "agent"]);
  });

  it("gives phase bands the run's guide spine — outer main spine open unless the run is the last sibling", () => {
    const a: SubagentNodeJson = { ...node("a", 0.1), workflowRunId: "wf_a", workflowPhase: "P" };
    const b: SubagentNodeJson = { ...node("b", 0.1), workflowRunId: "wf_b", workflowPhase: "P" };
    const runs: WorkflowRunSummaryJson[] = [
      { runId: "wf_a", name: "a", agentCount: 1, phases: [{ title: "P" }] },
      { runId: "wf_b", name: "b", agentCount: 1, phases: [{ title: "P" }] },
    ];
    const rows = groupedTreeRows([a, b], runs);
    const bands = rows.filter((r) => r.kind === "phase-header");
    expect(bands.map((band) => [band.ancestorIsLast, band.isLast])).toEqual([
      [[false], true],
      [[true], true],
    ]);
    // Members inherit both spines: [runIsLast, phaseIsLast].
    const agents = rows.filter((r) => r.kind === "agent");
    expect(agents.map((r) => r.row.ancestorIsLast)).toEqual([
      [false, true],
      [true, true],
    ]);
  });
});

describe("displayName", () => {
  it("prefers workflowLabel, then description, for a workflow-subagent node", () => {
    const withLabel: SubagentNodeJson = {
      ...node("wf1", 0.1),
      agentType: "workflow-subagent",
      workflowLabel: "research:agentcore",
      description: "should not win",
    };
    expect(displayName(withLabel)).toBe("research:agentcore");

    const withDescription: SubagentNodeJson = {
      ...node("wf2", 0.1),
      agentType: "workflow-subagent",
      description: "Refactor foo",
    };
    expect(displayName(withDescription)).toBe("Refactor foo");
  });

  it("falls back to the first line of promptPreview, truncated to ~48 chars, for an unlabeled workflow-subagent", () => {
    // Regression coverage: before this fallback, every unlabeled workflow
    // agent rendered as the literal string "workflow-subagent" (its
    // `agentType`) — indistinguishable from one another in the tree.
    const short: SubagentNodeJson = {
      ...node("wf3", 0.1),
      agentType: "workflow-subagent",
      promptPreview: "orphaned task",
    };
    expect(displayName(short)).toBe("orphaned task");

    const multiline: SubagentNodeJson = {
      ...node("wf4", 0.1),
      agentType: "workflow-subagent",
      promptPreview: "first line only\nsecond line never shows",
    };
    expect(displayName(multiline)).toBe("first line only");

    const long: SubagentNodeJson = {
      ...node("wf5", 0.1),
      agentType: "workflow-subagent",
      promptPreview: "x".repeat(80),
    };
    expect(displayName(long)).toBe(`${"x".repeat(48)}…`);
  });

  it("falls back to agentId when a workflow-subagent has neither label, description, nor promptPreview", () => {
    const bare: SubagentNodeJson = { ...node("wf6", 0.1), agentType: "workflow-subagent" };
    expect(displayName(bare)).toBe("wf6");
  });

  it("keeps the classic subagent chain unchanged: description, then agentType, then agentId", () => {
    const withDescription: SubagentNodeJson = {
      ...node("classic1", 0.1),
      agentType: "general-purpose",
      description: "Refactor foo",
    };
    expect(displayName(withDescription)).toBe("Refactor foo");

    const withTypeOnly: SubagentNodeJson = {
      ...node("classic2", 0.1),
      agentType: "general-purpose",
    };
    expect(displayName(withTypeOnly)).toBe("general-purpose");

    expect(displayName(node("classic3", 0.1))).toBe("classic3");
  });
});
