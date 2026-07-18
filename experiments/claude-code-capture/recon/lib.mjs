// Shared helpers for the recon/ scripts (extract-template.mjs, compare.mjs,
// stability-compare.mjs). No @junrei/* imports here on purpose — this module
// stays a plain, dependency-free reader of capture-run files so every script
// that only needs classification/parsing (not the production reconstruction
// itself) can use it without pulling in tsx's TypeScript loader.

import { readFile } from "node:fs/promises";

/** Read a JSONL file into an array of parsed objects. Blank lines are skipped. */
export async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Classify one capture.jsonl `/v1/messages` entry the same way the original
 * reconstruction/stability comparer scripts did: the request body's `system`
 * blocks carry a deterministic marker — `cc_is_subagent=true` on the
 * billing-header block for a Task-tool subagent turn, or a
 * "kicked off a Claude Code agent" phrase for the background task-state
 * classifier calls — everything else is a main-loop turn.
 */
export function classifyCaptureEntry(entry) {
  const sysText = JSON.stringify(entry.reqBody?.system ?? "");
  if (sysText.includes("kicked off a Claude Code agent")) return "classifier";
  if (sysText.includes("cc_is_subagent=true")) return "subagent";
  return "main";
}

/** Only the `/v1/messages` POST entries from a capture.jsonl (drops the health-check HEAD etc). */
export function messagesRequests(entries) {
  return entries.filter((e) => String(e.path ?? "").split("?")[0] === "/v1/messages");
}

/** Byte length of a value as it would appear on the wire, JSON-encoded. */
export function byteLen(value) {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value ?? null),
    "utf8",
  );
}

/**
 * The generation-param field names measured for cross-run stability
 * (docs/milestones/goshuin.md, "Cross-run stability") — the same set both
 * `extract-template.mjs` (what to capture into `template.params`) and
 * `compare.mjs` (what to compare against the wire) use, so a template's
 * params section and its calibration measurement are always talking about
 * the same fields. `model` is included even though it's not itself a
 * "generation param" in the strict sense — it's still part of what a
 * template pins per CLI version/config.
 */
export const PARAM_FIELDS = [
  "model",
  "max_tokens",
  "temperature",
  "thinking",
  "stream",
  "context_management",
];

/**
 * Best-effort extraction of Claude Code's "# Scratchpad Directory" backtick-
 * quoted path — a run-specific literal distinct from `cwd` (harness-computed
 * from cwd + sessionId + a munging scheme, with a further per-agent-run
 * suffix) that appears in the system prompt's instruction block whenever the
 * session runs under an orchestrating harness that sets one up. Returns
 * `undefined` when the section isn't present (most sessions don't have one)
 * — never invented.
 */
export function detectScratchpadLiteral(systemText) {
  const match = /# Scratchpad Directory[\s\S]*?`([^`]+)`/.exec(systemText ?? "");
  return match?.[1];
}

/** Deep-equality that ignores object key ORDER (unlike naive `JSON.stringify` comparison). */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function deepEqual(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
