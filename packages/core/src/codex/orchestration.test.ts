import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CodexSessionAnalysis } from "./analyze.js";
import { analyzeCodexSession } from "./analyze.js";
import type { CodexSessionFileRef } from "./discovery.js";
import { buildCodexSubagentForest } from "./orchestration.js";
import { parseCodexTranscriptFile } from "./parser.js";

const SUBAGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/codex/sessions/2026/07/03",
);

async function analyzeAt(fileName: string, sessionId: string): Promise<CodexSessionAnalysis> {
  const filePath = join(SUBAGENT_DIR, fileName);
  const transcript = await parseCodexTranscriptFile(filePath);
  const ref: CodexSessionFileRef = {
    sessionId,
    filePath,
    fileTimestamp: "",
    mtimeMs: 0,
    sizeBytes: 0,
    archived: false,
  };
  return analyzeCodexSession(ref, transcript);
}

async function loadForest() {
  const parent = await analyzeAt(
    "rollout-2026-07-03T09-00-00-77777777-7777-7777-7777-777777777777.jsonl",
    "77777777-7777-7777-7777-777777777777",
  );
  const child = await analyzeAt(
    "rollout-2026-07-03T09-00-05-88888888-8888-8888-8888-888888888888.jsonl",
    "88888888-8888-8888-8888-888888888888",
  );
  const grandchild = await analyzeAt(
    "rollout-2026-07-03T09-00-07-99999999-9999-9999-9999-999999999999.jsonl",
    "99999999-9999-9999-9999-999999999999",
  );
  return { parent, child, grandchild };
}

describe("buildCodexSubagentForest", () => {
  it("returns an empty forest when no analyses chain back to rootId", async () => {
    const { parent } = await loadForest();
    expect(buildCodexSubagentForest([parent], parent.sessionId)).toEqual([]);
  });

  it("nests a direct child under the root, and a grandchild under the child (2-level parentThreadId chain)", async () => {
    const { parent, child, grandchild } = await loadForest();
    const forest = buildCodexSubagentForest([parent, child, grandchild], parent.sessionId);

    expect(forest).toHaveLength(1);
    const childNode = forest[0];
    expect(childNode?.agentId).toBe("88888888-8888-8888-8888-888888888888");
    expect(childNode?.children).toHaveLength(1);
    expect(childNode?.children[0]?.agentId).toBe("99999999-9999-9999-9999-999999999999");
  });

  it("fills SubagentNode fields honestly from the child's own analysis", async () => {
    const { parent, child, grandchild } = await loadForest();
    const [childNode] = buildCodexSubagentForest([parent, child, grandchild], parent.sessionId);
    expect(childNode).toBeDefined();
    if (childNode === undefined) return;

    expect(childNode.agentType).toBe("explorer"); // codex.agentRole
    expect(childNode.description).toBe("Aquinas"); // codex.agentNickname
    expect(childNode.model).toBe("gpt-5.5-explorer"); // child.models[0]
    expect(childNode.promptPreview).toBe("Explore the auth module and report back");
    expect(childNode.usage).toBe(child.usage); // the child's OWN usage, not recursive
    expect(childNode.toolCallCount).toBe(child.codex.toolCallCount);
    expect(childNode.toolErrorCount).toBe(child.codex.toolErrorCount);
    expect(childNode.startedAt).toBe(child.startedAt);
    expect(childNode.endedAt).toBe(child.endedAt);
    expect(childNode.spawnDepth).toBe(1); // from session_meta's thread_spawn.depth
    expect(childNode.spawnedBy).toBe("main"); // parent === rootId
    // Recovered from the parent's collab_agent_spawn_end record.
    expect(childNode.toolUseId).toBe("call_spawn_child");
    expect(childNode.launchLine).toBe(6);
    // The spawn event's timestamp (09:00:05.000Z) differs from the child's
    // own startedAt (09:00:05.500Z, its session_meta timestamp).
    expect(childNode.launchedAt).toBe("2026-07-03T09:00:05.000Z");

    // Fields with no Codex equivalent stay honestly undefined, never fabricated.
    expect(childNode.returnedChars).toBeUndefined();
    expect(childNode.returnedPreview).toBeUndefined();
    expect(childNode.asyncLaunch).toBeUndefined();
  });

  it("falls back to recursion depth for spawnDepth when session_meta carried none (grandchild)", async () => {
    const { parent, child, grandchild } = await loadForest();
    const [childNode] = buildCodexSubagentForest([parent, child, grandchild], parent.sessionId);
    const grandchildNode = childNode?.children[0];
    expect(grandchildNode).toBeDefined();
    if (grandchildNode === undefined) return;

    expect(grandchildNode.agentId).toBe("99999999-9999-9999-9999-999999999999");
    expect(grandchildNode.spawnDepth).toBe(2); // recursion depth — grandchild's own subagentDepth is undefined
    expect(grandchildNode.spawnedBy).toBe("88888888-8888-8888-8888-888888888888"); // parent isn't rootId
    expect(grandchildNode.toolUseId).toBe("call_spawn_grandchild");
    expect(grandchildNode.usage).toBe(grandchild.usage);
  });

  it("omits toolUseId/launchLine/launchedAt when no matching spawnedThreadIds record exists (parent's own analysis missing from the pool)", async () => {
    const { child, grandchild } = await loadForest();
    // Deliberately exclude the parent's own analysis — orchestration.ts can't
    // match child against a collab_agent_spawn_end record it never saw.
    const forest = buildCodexSubagentForest(
      [child, grandchild],
      "77777777-7777-7777-7777-777777777777",
    );
    expect(forest).toHaveLength(1);
    expect(forest[0]?.toolUseId).toBeUndefined();
    expect(forest[0]?.launchLine).toBeUndefined();
    // spawnedBy is still resolvable — it only needs the child's own parentThreadId.
    expect(forest[0]?.spawnedBy).toBe("main");
  });
});
