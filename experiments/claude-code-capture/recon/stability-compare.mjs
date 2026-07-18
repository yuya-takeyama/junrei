#!/usr/bin/env node
// Compares system-prompt blocks, tools array, and generation params across
// two independent capture runs (of the same CLI version/config), to see how
// much of the "unreconstructable-from-the-log" part of each request (system
// + tools + params) is actually stable and worth capturing once into a
// template and reusing (Goshuin Decision 4).
//
// A generalized port of the original session-scratchpad stability comparer
// (see the README's "Recon workflow" section) — same comparisons, now taking
// any two run dirs rather than being hardcoded to a pair of paths. Plain
// Node.js, no @junrei/* imports (no core reconstruction logic to exercise
// here — just diffing two wire captures against each other).
//
// Usage: node stability-compare.mjs <runDirA> <runDirB>

import { createHash } from "node:crypto";
import { join } from "node:path";
import { classifyCaptureEntry, messagesRequests, readJsonl } from "./lib.mjs";

function sha256(text) {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex");
}

async function loadRun(runDir) {
  const entries = messagesRequests(await readJsonl(join(runDir, "capture.jsonl")));
  const byKind = { main: [], subagent: [], classifier: [] };
  for (const entry of entries) byKind[classifyCaptureEntry(entry)].push(entry);
  return byKind;
}

function systemBlocks(entry) {
  const sys = entry.reqBody?.system;
  if (!sys) return [];
  if (typeof sys === "string") return [sys];
  return sys.map((b) => b.text ?? "");
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return {
    index: i,
    aroundA: a.slice(Math.max(0, i - 60), i + 120),
    aroundB: b.slice(Math.max(0, i - 60), i + 120),
  };
}

function compareSystemBlocks(entryA, entryB, label) {
  const blocksA = systemBlocks(entryA);
  const blocksB = systemBlocks(entryB);
  const out = { label, blockCountA: blocksA.length, blockCountB: blocksB.length, perBlock: [] };
  const n = Math.max(blocksA.length, blocksB.length);
  for (let i = 0; i < n; i += 1) {
    const a = blocksA[i] ?? null;
    const b = blocksB[i] ?? null;
    if (a === null || b === null) {
      out.perBlock.push({
        index: i,
        identical: false,
        note: a === null ? "missing in A" : "missing in B",
      });
      continue;
    }
    const identical = a === b;
    const rec = {
      index: i,
      lenA: a.length,
      lenB: b.length,
      hashA: sha256(a).slice(0, 12),
      hashB: sha256(b).slice(0, 12),
      identical,
    };
    if (!identical) {
      const d = firstDiff(a, b);
      rec.firstDiffIndex = d.index;
      rec.aroundA = d.aroundA;
      rec.aroundB = d.aroundB;
    }
    out.perBlock.push(rec);
  }
  return out;
}

function toolFingerprint(tool) {
  return sha256(JSON.stringify(tool));
}

function compareTools(entryA, entryB, label) {
  const toolsA = entryA.reqBody?.tools ?? [];
  const toolsB = entryB.reqBody?.tools ?? [];
  const namesA = toolsA.map((t) => t.name);
  const namesB = toolsB.map((t) => t.name);
  const sameOrder = JSON.stringify(namesA) === JSON.stringify(namesB);
  const setA = new Set(namesA);
  const setB = new Set(namesB);
  const onlyInA = namesA.filter((n) => !setB.has(n));
  const onlyInB = namesB.filter((n) => !setA.has(n));
  const common = namesA.filter((n) => setB.has(n));
  const perToolHashDiff = [];
  const byNameA = Object.fromEntries(toolsA.map((t) => [t.name, t]));
  const byNameB = Object.fromEntries(toolsB.map((t) => [t.name, t]));
  for (const name of common) {
    const ha = toolFingerprint(byNameA[name]);
    const hb = toolFingerprint(byNameB[name]);
    if (ha !== hb) perToolHashDiff.push({ name, hashA: ha.slice(0, 12), hashB: hb.slice(0, 12) });
  }
  return {
    label,
    countA: toolsA.length,
    countB: toolsB.length,
    sameOrder,
    onlyInA,
    onlyInB,
    commonCount: common.length,
    perToolHashDiff,
    allCommonIdentical: perToolHashDiff.length === 0,
  };
}

function compareParams(entryA, entryB, label) {
  const a = entryA.reqBody ?? {};
  const b = entryB.reqBody ?? {};
  const fields = ["model", "max_tokens", "temperature", "thinking", "stream", "context_management"];
  const out = { label };
  for (const field of fields) {
    const av = JSON.stringify(a[field] ?? null);
    const bv = JSON.stringify(b[field] ?? null);
    out[field] = { a: a[field] ?? null, b: b[field] ?? null, equal: av === bv };
  }
  return out;
}

async function main() {
  const [runDirA, runDirB] = process.argv.slice(2);
  if (!runDirA || !runDirB) throw new Error("usage: stability-compare.mjs <runDirA> <runDirB>");

  const runA = await loadRun(runDirA);
  const runB = await loadRun(runDirB);

  const report = { runDirA, runDirB, counts: { A: {}, B: {} } };
  for (const kind of ["main", "subagent", "classifier"]) {
    report.counts.A[kind] = runA[kind].length;
    report.counts.B[kind] = runB[kind].length;
  }

  // Compare the first main-loop request of each run (both are the "opening"
  // request of a fresh session -> most comparable apples-to-apples).
  if (runA.main[0] && runB.main[0]) {
    report.mainFirstRequestSystem = compareSystemBlocks(
      runA.main[0],
      runB.main[0],
      "main[0] system blocks",
    );
    report.mainFirstRequestTools = compareTools(runA.main[0], runB.main[0], "main[0] tools");
    report.mainFirstRequestParams = compareParams(runA.main[0], runB.main[0], "main[0] params");
  }

  // Classifier requests, if both runs have one.
  if (runA.classifier[0] && runB.classifier[0]) {
    report.classifierSystem = compareSystemBlocks(
      runA.classifier[0],
      runB.classifier[0],
      "classifier system blocks",
    );
    report.classifierTools = compareTools(
      runA.classifier[0],
      runB.classifier[0],
      "classifier tools",
    );
    report.classifierParams = compareParams(
      runA.classifier[0],
      runB.classifier[0],
      "classifier params",
    );
  }

  // Subagent presence note.
  report.subagentNote = {
    Acount: runA.subagent.length,
    Bcount: runB.subagent.length,
    comparable: runA.subagent.length > 0 && runB.subagent.length > 0,
  };
  if (report.subagentNote.comparable) {
    report.subagentSystem = compareSystemBlocks(
      runA.subagent[0],
      runB.subagent[0],
      "subagent[0] system blocks",
    );
    report.subagentTools = compareTools(runA.subagent[0], runB.subagent[0], "subagent[0] tools");
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
