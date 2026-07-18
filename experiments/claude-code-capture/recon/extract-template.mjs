#!/usr/bin/env node
// Builds a per-CLI-version reconstruction template (Goshuin Decision 4) from
// a capture run's first main-loop /v1/messages request, in the exact on-disk
// shape @junrei/core's `parseReconstructionTemplate` validates:
//   <out>/<cliVersion>/template.json
//
// Templates are USER-LOCAL, Anthropic-authored-text artifacts and are NEVER
// written into the repo — the default `--out` is `~/.junrei/templates`; this
// script refuses to write anywhere inside the repo checkout (see `assertNotInRepo`).
//
// Validates the result through @junrei/core's own `parseReconstructionTemplate`
// before writing — a template this script produces but core itself would
// reject is a bug here, not something a filesystem provider should have to
// discover later. Run via tsx (core is TypeScript source with no build
// step — see the README):
//   ../../packages/server/node_modules/.bin/tsx recon/extract-template.mjs <runDir>

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReconstructionTemplate } from "../../../packages/core/src/index.ts";
import {
  classifyCaptureEntry,
  detectScratchpadLiteral,
  messagesRequests,
  PARAM_FIELDS,
  readJsonl,
} from "./lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function parseArgs(argv) {
  const args = { runDir: undefined, out: join(homedir(), ".junrei", "templates") };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
    else rest.push(argv[i]);
  }
  args.runDir = rest[0];
  if (args.runDir === undefined) {
    throw new Error("usage: extract-template.mjs <runDir> [--out <dir>]");
  }
  return args;
}

/** Never let `--out` land inside the repo checkout — templates must stay user-local. */
function assertNotInRepo(outDir) {
  const resolved = resolve(outDir);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}/`)) {
    throw new Error(
      `refusing to write a template under the repo checkout (${REPO_ROOT}): ${resolved}. ` +
        "Templates are user-local, Anthropic-authored-text artifacts and must never be committed " +
        "— pass --out pointing outside the repo (default: ~/.junrei/templates).",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNotInRepo(args.out);

  const manifest = JSON.parse(await readFile(join(args.runDir, "manifest.json"), "utf8"));
  const sessionId = manifest.sessionId;
  const mainLogPath = join(args.runDir, "session-log", `${sessionId}.jsonl`);
  const records = await readJsonl(mainLogPath);

  const cliVersion = records.find((r) => typeof r.version === "string")?.version;
  if (cliVersion === undefined) {
    throw new Error(`no record with a "version" field found in ${mainLogPath}`);
  }
  const cwd = records.find((r) => typeof r.cwd === "string")?.cwd ?? manifest.projectDir;
  if (cwd === undefined) throw new Error("could not determine the session's cwd");

  const captureEntries = await readJsonl(join(args.runDir, "capture.jsonl"));
  const mainRequests = messagesRequests(captureEntries).filter(
    (e) => classifyCaptureEntry(e) === "main",
  );
  const first = mainRequests[0];
  if (first === undefined) {
    throw new Error("no main-loop /v1/messages request found in capture.jsonl");
  }

  // Exclude the per-launch billing-header block (a fixed
  // "x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;" system
  // block whose build-suffix varies per launch — see core's `reconstruct.ts`
  // `BILLING_REASON`). It is DELIBERATELY not part of the template: core's
  // `buildTemplateSections` always appends its own single declared-unknown
  // placeholder for it — a template that also captured it verbatim would
  // wrongly claim "template" confidence for content that's not actually
  // recoverable/reproducible per launch.
  const system = (first.reqBody.system ?? [])
    .filter((block) => !(block.text ?? "").startsWith("x-anthropic-billing-header:"))
    .map((block) => ({ text: block.text }));
  const tools = first.reqBody.tools;
  const params = Object.fromEntries(
    PARAM_FIELDS.filter((field) => field in first.reqBody).map((field) => [
      field,
      first.reqBody[field],
    ]),
  );

  const extra = {};
  const scratchpadDir = detectScratchpadLiteral(system.map((block) => block.text).join("\n"));
  if (scratchpadDir !== undefined) extra.scratchpadDir = scratchpadDir;

  const template = {
    cliVersion,
    capturedValues: { cwd, sessionId, ...(Object.keys(extra).length > 0 && { extra }) },
    system,
    tools,
    params,
  };

  if (parseReconstructionTemplate(template) === undefined) {
    throw new Error(
      "extracted template failed @junrei/core's parseReconstructionTemplate validation " +
        "— this is a bug in extract-template.mjs, not a reason to write an invalid template.",
    );
  }

  const outDir = join(args.out, cliVersion);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "template.json");
  await writeFile(outPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  console.log(`Wrote template: ${outPath}`);
  console.log(`  cliVersion: ${cliVersion}`);
  console.log(`  capturedValues.cwd: ${cwd}`);
  console.log(`  capturedValues.sessionId: ${sessionId}`);
  console.log(`  system blocks: ${system.length}`);
  console.log(`  tools: ${Array.isArray(tools) ? tools.length : 0}`);
  console.log(`  params fields: ${Object.keys(params).join(", ") || "(none)"}`);
  console.log(`  extra literals: ${Object.keys(extra).join(", ") || "(none)"}`);
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
