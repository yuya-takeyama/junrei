#!/usr/bin/env node
// Drives the PRODUCTION @junrei/core reconstruction (`reconstructRequest`) —
// plus, unless `--no-disk` is given, @junrei/server's own filesystem
// providers — over a capture run's session log, and compares every
// reconstructed block against the REAL captured wire request, bucketing
// matched/total wire bytes by the confidence class the reconstruction
// assigned to the block that produced (or failed to produce) that match.
//
// @junrei/core has no build step (its package.json "build" is a no-op; its
// "exports" map points straight at ./src/index.ts) — every consumer in this
// workspace, including @junrei/server itself, imports the TypeScript source
// directly through a TS-aware runtime. This script does the same: run it
// through `tsx` (already a devDependency of @junrei/server), importing core
// and the server's reconstruction providers via relative paths to their
// source files — see the README for the exact invocation.
//
// Usage:
//   tsx recon/compare.mjs <runDir> --template <templatesDir> [--no-disk]
//                          [--project-dir-name <name>] [--details]
//
//   <runDir>              A capture run directory (manifest.json,
//                          session-log/, capture.jsonl — same layout
//                          run-scenario.mjs produces).
//   --template <dir>      A template library root (see extract-template.mjs)
//                          — REQUIRED (compare.mjs never touches ~/.junrei
//                          itself; pass whatever dir you extracted into).
//   --no-disk              Skip the disk-context provider entirely (system/
//                          message reconstruction still runs; the CLAUDE.md/
//                          memory/email block reports `unknown` instead of
//                          `disk-contingent`).
//   --project-dir-name     Override the munged project dir used to locate
//                          memory/MEMORY.md (default: derived from the
//                          manifest's `sessionLog.sourceDir`).
//   --details               Include a `mismatches` array in the JSON report.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReconstructionInput, reconstructRequest } from "../../../packages/core/src/index.ts";
import {
  createFilesystemDiskContextProvider,
  createFilesystemTemplateProvider,
} from "../../../packages/server/src/sources/reconstruction.ts";
import {
  byteLen,
  classifyCaptureEntry,
  deepEqual,
  detectScratchpadLiteral,
  messagesRequests,
  PARAM_FIELDS,
  readJsonl,
} from "./lib.mjs";

const CLASSES = ["exact", "template", "disk-contingent", "unknown"];

function parseArgs(argv) {
  const args = {
    runDir: undefined,
    templatesDir: undefined,
    disk: true,
    projectDirName: undefined,
    details: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--template") args.templatesDir = argv[++i];
    else if (argv[i] === "--no-disk") args.disk = false;
    else if (argv[i] === "--project-dir-name") args.projectDirName = argv[++i];
    else if (argv[i] === "--details") args.details = true;
    else rest.push(argv[i]);
  }
  args.runDir = rest[0];
  if (args.runDir === undefined || args.templatesDir === undefined) {
    throw new Error(
      "usage: compare.mjs <runDir> --template <templatesDir> [--no-disk] " +
        "[--project-dir-name <name>] [--details]",
    );
  }
  return args;
}

// A minimal `ClaudeSessionStore` (see @junrei/core's store.ts) reading a
// fixed file path directly — capture run dirs live outside ~/.claude/projects/,
// so the production discovery-based store can't resolve them by session id.
async function* readLines(filePath) {
  const text = await readFile(filePath, "utf8");
  for (const line of text.split("\n")) yield line;
}
function runDirStore() {
  return {
    async listSessionFiles() {
      return [];
    },
    async findSessionFileById() {
      return undefined;
    },
    openLines: (filePath) => readLines(filePath),
    readFile: (filePath) => readFile(filePath, "utf8"),
    async listSidecarFiles() {
      return [];
    },
  };
}

function newBuckets() {
  return Object.fromEntries(CLASSES.map((c) => [c, { matched: 0, total: 0 }]));
}
function addBucket(buckets, cls, total, matched) {
  if (buckets[cls] === undefined) buckets[cls] = { matched: 0, total: 0 };
  const bucket = buckets[cls];
  bucket.total += total;
  if (matched) bucket.matched += total;
}

/**
 * `system` array set-matching. Positional comparison doesn't work here: the
 * WIRE always puts the per-launch billing-header block FIRST, but the
 * reconstruction (`buildTemplateSections` in core's `reconstruct.ts`) always
 * appends its one declared-unknown billing placeholder LAST (after every
 * template-derived block, in whatever order the template captured them) —
 * it has no way to know the wire's real position for a block it can't
 * recover any content for. Matching each reconstructed block's exact TEXT
 * against an unclaimed wire block (order-independent) sidesteps that: the
 * billing placeholder carries no `text` at all, so it naturally falls
 * through to "pair with whatever wire block nothing else claimed" — which is
 * exactly the billing header, the only wire block no template text can ever
 * equal.
 */
function compareSystemBlocks(wireSystem, reconSystem, buckets, mismatches) {
  const wirePool = (wireSystem ?? []).map((b, i) => ({
    text: b.text ?? "",
    claimed: false,
    index: i,
  }));
  const unmatchedRecon = [];
  for (const rb of reconSystem) {
    if (rb.text === undefined) {
      unmatchedRecon.push(rb);
      continue;
    }
    const hit = wirePool.find((w) => !w.claimed && w.text === rb.text);
    if (hit !== undefined) {
      hit.claimed = true;
      addBucket(buckets, rb.confidence, byteLen(hit.text), true);
    } else {
      unmatchedRecon.push(rb);
    }
  }
  for (const w of wirePool.filter((w) => !w.claimed)) {
    const rb = unmatchedRecon.shift();
    addBucket(buckets, rb?.confidence ?? "unknown", byteLen(w.text), false);
    mismatches.push({
      section: "system",
      wireIndex: w.index,
      confidence: rb?.confidence ?? "unknown",
      reason: rb?.note ?? "no matching reconstructed block (text differs or none available)",
    });
  }
}

/** Strip the wire-only `cache_control` key before comparing — the production reconstruction always strips it too (RULE_CACHE_CONTROL_STRIP), folded into `exact` confidence, not a separate class. */
function normalizeWireBlock(block) {
  if (block === null || typeof block !== "object") return block;
  const { cache_control, ...rest } = block;
  return rest;
}

function blocksEqual(wireBlock, reconValue) {
  if (reconValue === undefined) return false;
  return deepEqual(normalizeWireBlock(wireBlock), reconValue);
}

/** `messages` — positional per-turn/per-block comparison (replay preserves wire order; see replay.ts). */
function compareMessages(wireMessages, reconMessages, buckets, mismatches) {
  const n = wireMessages.length;
  for (let i = 0; i < n; i += 1) {
    const wireMsg = wireMessages[i];
    const reconMsg = reconMessages[i];
    const wireContent = Array.isArray(wireMsg.content)
      ? wireMsg.content
      : [{ type: "text", text: wireMsg.content }];
    for (let j = 0; j < wireContent.length; j += 1) {
      const wireBlock = wireContent[j];
      const bytes = byteLen(wireBlock);
      const reconBlock = reconMsg?.content?.[j];
      if (reconBlock === undefined) {
        addBucket(buckets, "unknown", bytes, false);
        mismatches.push({
          section: "messages",
          messageIndex: i,
          blockIndex: j,
          confidence: "unknown",
          reason: "reconstruction produced no block at this position",
        });
        continue;
      }
      const matched = blocksEqual(wireBlock, reconBlock.value);
      addBucket(buckets, reconBlock.confidence, bytes, matched);
      if (!matched) {
        mismatches.push({
          section: "messages",
          messageIndex: i,
          blockIndex: j,
          confidence: reconBlock.confidence,
          reason:
            reconBlock.note ??
            (reconBlock.confidence === "unknown" ? "declared unknown" : "content differs"),
        });
      }
    }
  }
  if (reconMessages.length > wireMessages.length) {
    mismatches.push({
      section: "messages",
      reason: `reconstruction produced ${reconMessages.length} messages, wire had ${wireMessages.length} (extra messages contribute no wire bytes and aren't counted)`,
    });
  }
}

/** Whole-value comparison for `tools` — always counted against the FULL wire value, even when the reconstruction has nothing (declared `unknown`). */
function compareSection(name, wireValue, reconSection, buckets, mismatches) {
  if (wireValue === undefined) return;
  const bytes = byteLen(wireValue);
  const matched = reconSection.value !== undefined && deepEqual(reconSection.value, wireValue);
  addBucket(buckets, reconSection.confidence, bytes, matched);
  if (!matched) {
    mismatches.push({
      section: name,
      confidence: reconSection.confidence,
      reason:
        reconSection.note ??
        (reconSection.confidence === "unknown" ? "declared unknown" : "value differs"),
    });
  }
}

/**
 * `params` — PER-KEY comparison (the reconstruction now labels each generation
 * param separately in `params.entries`, overlaying the log-recorded `model`
 * (exact) over the template defaults (template)). Each wire param field's bytes
 * are bucketed by the confidence of the entry that produced it — falling back
 * to the section-level confidence (the "no template params" case) when no
 * per-key entry exists — and counted matched only when the entry's value
 * deep-equals the wire value. NOTE: `model` now comes from the log line, so in
 * a capture run whose log echoes the RESOLVED, date-suffixed model id
 * (`claude-haiku-4-5-20251001`) while the request carried the alias
 * (`claude-haiku-4-5`), the `model` bytes count as exact-but-unmatched — a
 * capture-run artifact, not a reconstruction defect.
 */
function compareParams(wireParams, reconParams, buckets, mismatches) {
  const entries = reconParams.entries ?? {};
  for (const [key, wireValue] of Object.entries(wireParams)) {
    const bytes = byteLen(wireValue);
    const entry = entries[key];
    const confidence = entry?.confidence ?? reconParams.confidence ?? "unknown";
    const matched = entry?.value !== undefined && deepEqual(entry.value, wireValue);
    addBucket(buckets, confidence, bytes, matched);
    if (!matched) {
      mismatches.push({
        section: "params",
        key,
        confidence,
        reason: entry?.note ?? (confidence === "unknown" ? "declared unknown" : "value differs"),
      });
    }
  }
}

function pct(matched, total) {
  return total > 0 ? Number(((100 * matched) / total).toFixed(2)) : null;
}

function collectDriftFiles(blocks) {
  const files = [];
  for (const block of blocks) {
    if (block.confidence === "disk-contingent" && block.provenance?.kind === "disk") {
      for (const file of block.provenance.files) {
        if (file.driftDetected) files.push(file.role);
      }
    }
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const manifest = JSON.parse(await readFile(join(args.runDir, "manifest.json"), "utf8"));
  const sessionId = manifest.sessionId;
  const mainLogPath = join(args.runDir, "session-log", `${sessionId}.jsonl`);

  const captureEntries = await readJsonl(join(args.runDir, "capture.jsonl"));
  const mainRequests = messagesRequests(captureEntries).filter(
    (e) => classifyCaptureEntry(e) === "main",
  );

  const scratchpadDir = detectScratchpadLiteral(
    (mainRequests[0]?.reqBody.system ?? []).map((b) => b.text).join("\n"),
  );
  const overrides = scratchpadDir !== undefined ? { substitutions: { scratchpadDir } } : {};

  const store = runDirStore();
  const input = await loadReconstructionInput(sessionId, mainLogPath, store, overrides);

  const projectDirName =
    args.projectDirName ??
    (typeof manifest.sessionLog?.sourceDir === "string"
      ? manifest.sessionLog.sourceDir.split("/").filter(Boolean).pop()
      : undefined);

  const providers = {
    template: createFilesystemTemplateProvider({ templatesDir: args.templatesDir }),
    ...(args.disk && { diskContext: createFilesystemDiskContextProvider({ projectDirName }) }),
  };

  const buckets = newBuckets();
  const mismatches = [];
  const perRequest = [];
  const driftFiles = new Set();

  for (const entry of mainRequests) {
    const requestId = entry.resHeaders?.["request-id"];
    if (requestId === undefined) {
      perRequest.push({ status: "NO_REQUEST_ID" });
      continue;
    }
    const reconstructed = await reconstructRequest(input, requestId, providers);
    if (reconstructed === undefined) {
      perRequest.push({ requestId, status: "NO_RECONSTRUCTION" });
      continue;
    }

    compareSystemBlocks(entry.reqBody.system, reconstructed.system, buckets, mismatches);
    compareMessages(entry.reqBody.messages, reconstructed.messages, buckets, mismatches);
    compareSection("tools", entry.reqBody.tools, reconstructed.tools, buckets, mismatches);
    const wireParams = Object.fromEntries(
      PARAM_FIELDS.filter((f) => f in entry.reqBody).map((f) => [f, entry.reqBody[f]]),
    );
    compareParams(wireParams, reconstructed.params, buckets, mismatches);

    for (const file of collectDriftFiles(reconstructed.system)) driftFiles.add(file);
    for (const msg of reconstructed.messages) {
      for (const file of collectDriftFiles(msg.content)) driftFiles.add(file);
    }

    perRequest.push({ requestId, ordinal: reconstructed.ordinal, status: "OK" });
  }

  const perClass = Object.fromEntries(
    CLASSES.map((c) => [
      c,
      { ...buckets[c], matchRatePct: pct(buckets[c].matched, buckets[c].total) },
    ]),
  );
  const exactTemplateMatchedBytes = buckets.exact.matched + buckets.template.matched;
  const totalBytes = CLASSES.reduce((sum, c) => sum + buckets[c].total, 0);

  const report = {
    runDir: args.runDir,
    sessionId,
    mainRequestsInCapture: mainRequests.length,
    mainRequestsCompared: perRequest.filter((r) => r.status === "OK").length,
    perClass,
    totalBytes,
    exactTemplateMatchedBytes,
    headlinePct: pct(exactTemplateMatchedBytes, totalBytes),
    diskContingent: {
      enabled: args.disk,
      driftDetected: driftFiles.size > 0,
      driftFiles: [...driftFiles],
    },
    perRequest,
    ...(args.details && { mismatches }),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
