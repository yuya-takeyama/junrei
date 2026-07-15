import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listWorkflowRuns, workflowsDirFor } from "./workflows.js";

const FIXTURE_PROJECTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/projects",
);
const SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/55555555-5555-5555-5555-555555555555.jsonl",
);
const NO_WORKFLOWS_SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);

describe("listWorkflowRuns", () => {
  it("parses a run's phases and per-agent workflow_agent progress entries", async () => {
    const runs = await listWorkflowRuns(SESSION_FILE);
    // Two extra .json files in the fixture's workflows/ dir are corrupt or
    // missing `runId` (see below) — only the one valid run-state file
    // survives.
    expect(runs).toHaveLength(1);

    const run = runs[0];
    expect(run?.runId).toBe("wf_run1");
    expect(run?.workflowName).toBe("widget-research");
    expect(run?.status).toBe("completed");
    expect(run?.durationMs).toBe(120000);
    expect(run?.filePath).toBe(join(workflowsDirFor(SESSION_FILE), "wf_run1.json"));

    expect(run?.phases).toEqual([
      { title: "Research", detail: "gather info" },
      { title: "Synthesis", detail: "write summary" },
    ]);

    expect(run?.agents.size).toBe(2);
    const agent1 = run?.agents.get("wf1111111111111");
    expect(agent1).toEqual({
      agentId: "wf1111111111111",
      label: "research:foo",
      phaseTitle: "Research",
      phaseIndex: 1,
      model: "claude-sonnet-5",
      state: "done",
      queuedAt: 1783641628000,
      startedAt: 1783641629000,
      promptPreview: "research widgets",
    });
    const agent2 = run?.agents.get("wf2222222222222");
    // The run-state's own `model` field can carry harness decorations
    // (`[1m]`) — kept as-is here; `analyze.ts` is what ignores this in favor
    // of the agent transcript's own clean `message.model`.
    expect(agent2?.model).toBe("claude-opus-4-8[1m]");
    expect(agent2?.phaseTitle).toBe("Synthesis");

    // `workflow_phase` entries in `workflowProgress` are NOT surfaced in
    // `agents` (only `workflow_agent` entries are) — redundant with `phases`.
    expect([...(run?.agents.values() ?? [])].every((a) => a.agentId !== undefined)).toBe(true);
  });

  it("skips a corrupt run-state file and one missing `runId`, without throwing", async () => {
    // wf_corrupt.json (invalid JSON) and no-run-id.json (valid JSON, no
    // `runId`) both live alongside wf_run1.json in the fixture — neither
    // appears in the result, and parsing the good file still succeeds.
    const runs = await listWorkflowRuns(SESSION_FILE);
    expect(runs.map((r) => r.runId)).toEqual(["wf_run1"]);
  });

  it("ignores the scripts/ subdirectory (non-.json entries)", async () => {
    const runs = await listWorkflowRuns(SESSION_FILE);
    expect(runs.every((r) => !r.filePath.includes("/scripts/"))).toBe(true);
  });

  it("returns [] when the session has no workflows/ directory at all", async () => {
    const runs = await listWorkflowRuns(NO_WORKFLOWS_SESSION_FILE);
    expect(runs).toEqual([]);
  });

  it("returns [] for a session file that doesn't exist on disk", async () => {
    const runs = await listWorkflowRuns(
      join(FIXTURE_PROJECTS, "-Users-test-proj/does-not-exist.jsonl"),
    );
    expect(runs).toEqual([]);
  });
});
