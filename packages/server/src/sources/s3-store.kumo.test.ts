/**
 * One integration test exercising the S3 store against a REAL S3-compatible
 * server — kumo (https://github.com/sivchari/kumo), a single-binary AWS
 * emulator installed via aqua (see `aqua/kumo-registry.yaml`). Everything
 * else in this package mocks the S3Client at the `send` level
 * (`s3-store.test.ts`); this file is the one place that spawns a real process
 * and drives the store through actual HTTP calls, end to end.
 *
 * Skipped (not failed) when `kumo` isn't on PATH — `aqua i -l` installs it
 * locally and in CI (see `.github/workflows/ci.yaml`), but this test must
 * degrade gracefully anywhere that hasn't run that step.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  analyzeClaudeSession,
  listSubagentRefs,
  listWorkflowRuns,
  parseClaudeTranscriptFile,
} from "@junrei/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3ClaudeSessionStore } from "./s3-store.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../core/test/fixtures/projects",
);
const BUCKET = "junrei-kumo-test";
const PREFIX = "agentcore/";
const WORKFLOW_SESSION_ID = "55555555-5555-5555-5555-555555555555";
const CLASSIC_SESSION_ID = "11111111-1111-1111-1111-111111111111";

function hasKumo(): boolean {
  const result = spawnSync("kumo", ["--help"], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

/** An OS-assigned free TCP port (small race window, acceptable for a test). */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForKumo(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.status < 500) return;
    } catch {
      // Not accepting connections yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`kumo did not become ready on port ${port} within ${timeoutMs}ms`);
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

const kumoAvailable = hasKumo();

describe.skipIf(!kumoAvailable)("createS3ClaudeSessionStore against kumo (integration)", () => {
  let kumoProcess: ChildProcess;
  let port: number;
  let endpoint: string;

  beforeAll(async () => {
    port = await findFreePort();
    endpoint = `http://localhost:${port}`;
    kumoProcess = spawn("kumo", ["serve"], {
      env: { ...process.env, KUMO_PORT: String(port) },
      stdio: "ignore",
    });
    await waitForKumo(port);

    // Dummy static credentials + region, via env — kumo needs no real AWS
    // account, but the SDK's default credential/region chain still requires
    // SOME values to be resolvable.
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_REGION = "us-east-1";

    const setupClient = new S3Client({ endpoint, forcePathStyle: true });
    await setupClient.send(new CreateBucketCommand({ Bucket: BUCKET }));

    // Upload the existing core fixtures verbatim, preserving their relative
    // layout under `<prefix>projects/` — the fixture tree is ALREADY shaped
    // like `-Users-test-proj/<sessionId>.jsonl` (+ sidecar subdirs), which is
    // exactly the `projects/<dir>/<sessionId>...` structure the S3 source
    // expects, so no transformation is needed beyond the key prefix.
    const fixtureFiles = await walkFiles(FIXTURES_DIR);
    await Promise.all(
      fixtureFiles.map(async (filePath) => {
        const rel = relative(FIXTURES_DIR, filePath);
        const body = await readFile(filePath);
        await setupClient.send(
          new PutObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}projects/${rel}`, Body: body }),
        );
      }),
    );
  }, 30_000);

  afterAll(() => {
    kumoProcess?.kill();
  });

  it("lists sessions uploaded to kumo", async () => {
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, endpoint });
    const refs = await store.listSessionFiles();
    const sessionIds = refs.map((r) => r.sessionId);
    expect(sessionIds).toContain(CLASSIC_SESSION_ID);
    expect(sessionIds).toContain(WORKFLOW_SESSION_ID);
  });

  it("parses a transcript end-to-end and analyzes it, reading through kumo", async () => {
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, endpoint });
    const ref = await store.findSessionFileById(CLASSIC_SESSION_ID);
    expect(ref).toBeDefined();
    if (ref === undefined) return;

    const transcript = await parseClaudeTranscriptFile(ref.filePath, store);
    expect(transcript.records.length).toBeGreaterThan(0);

    const analysis = await analyzeClaudeSession(ref.filePath, store);
    expect(analysis.sessionId).toBe(CLASSIC_SESSION_ID);
    expect(analysis.subagentCount).toBe(1);
    expect(analysis.subagents[0]?.agentId).toBe("aaaa111122223333f");
  });

  it("finds subagent and workflow sidecars through kumo", async () => {
    const store = createS3ClaudeSessionStore({ bucket: BUCKET, prefix: PREFIX, endpoint });
    const ref = await store.findSessionFileById(WORKFLOW_SESSION_ID);
    expect(ref).toBeDefined();
    if (ref === undefined) return;

    const subagentRefs = await listSubagentRefs(ref.filePath, store);
    expect(subagentRefs.length).toBeGreaterThan(0);
    expect(subagentRefs.some((r) => r.workflowRunId === "wf_run1")).toBe(true);
    expect(subagentRefs.some((r) => r.agentId === "classic1111111")).toBe(true);

    const runs = await listWorkflowRuns(ref.filePath, store);
    expect(runs.some((r) => r.runId === "wf_run1")).toBe(true);
  });
});
