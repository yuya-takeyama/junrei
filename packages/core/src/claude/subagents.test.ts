import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSubagentRefs } from "./subagents.js";

const FIXTURE_PROJECTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/projects",
);
const WORKFLOW_SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/55555555-5555-5555-5555-555555555555.jsonl",
);
const CLASSIC_ONLY_SESSION_FILE = join(
  FIXTURE_PROJECTS,
  "-Users-test-proj/11111111-1111-1111-1111-111111111111.jsonl",
);

describe("listSubagentRefs", () => {
  it("discovers both the classic top-level sidecar and every Workflow-tool agent, tagging the latter with workflowRunId", async () => {
    const refs = await listSubagentRefs(WORKFLOW_SESSION_FILE);
    const byId = new Map(refs.map((r) => [r.agentId, r]));

    expect(refs).toHaveLength(4);

    const classic = byId.get("classic1111111");
    expect(classic?.workflowRunId).toBeUndefined();
    expect(classic?.meta.toolUseId).toBe("toolu_classic1");

    const wf1 = byId.get("wf1111111111111");
    expect(wf1?.workflowRunId).toBe("wf_run1");
    expect(wf1?.meta.agentType).toBe("workflow-subagent");
    // No toolUseId in meta.json for a Workflow-spawned agent — the batch is
    // launched by a single `Workflow` call, not a per-agent Agent/Task call.
    expect(wf1?.meta.toolUseId).toBeUndefined();

    const wf2 = byId.get("wf2222222222222");
    expect(wf2?.workflowRunId).toBe("wf_run1");

    // The orphan agent (no matching workflows/<runId>.json state file) is
    // still discovered — discovery is filesystem-driven, independent of
    // whether a run-state file exists.
    const orphan = byId.get("wf3333333333333");
    expect(orphan?.workflowRunId).toBe("wf_run_orphan");
  });

  it("never surfaces journal.jsonl as an agent ref", async () => {
    const refs = await listSubagentRefs(WORKFLOW_SESSION_FILE);
    expect(refs.some((r) => r.jsonlPath.endsWith("journal.jsonl"))).toBe(false);
  });

  it("still works for a session with only classic sidecars (no subagents/workflows/ dir)", async () => {
    const refs = await listSubagentRefs(CLASSIC_ONLY_SESSION_FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.workflowRunId).toBeUndefined();
  });

  it("returns [] for a session with no subagents directory at all, never throwing", async () => {
    const refs = await listSubagentRefs(
      join(FIXTURE_PROJECTS, "-Users-test-proj/does-not-exist.jsonl"),
    );
    expect(refs).toEqual([]);
  });
});
