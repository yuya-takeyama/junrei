/**
 * Template library plumbing (Decision 4). Templates are USER-LOCAL artifacts —
 * a per-CLI-version capture of the non-log-derived request parts (system
 * prompt, tools, generation params) plus the run-specific literals that must be
 * substituted per session. This module defines the pure validator that turns
 * on-disk JSON into a typed `ReconstructionTemplate`, and the deterministic
 * substitution used to specialise a captured system block to a target session.
 * The filesystem provider that reads `~/.junrei/templates/<cli-version>/
 * template.json` is deliberately NOT here (server side, a later phase); this
 * pure layer makes that provider trivial.
 */

import type { ReconstructionTemplate } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === "string");
}

/**
 * Validate untyped JSON (e.g. the parsed contents of a template file) into a
 * `ReconstructionTemplate`. Returns `undefined` on any structural violation, so
 * a filesystem provider can map a malformed/absent template to the same
 * "no template ⇒ unknown" degradation as a missing one. Strict about the
 * required fields (`cliVersion`, `capturedValues.cwd`/`sessionId`, a `system`
 * array of `{ text }`); lenient/pass-through for the optional `tools`/`params`.
 */
export function parseReconstructionTemplate(json: unknown): ReconstructionTemplate | undefined {
  if (!isObject(json)) return undefined;

  const { cliVersion, capturedValues, system, tools, params } = json;
  if (typeof cliVersion !== "string" || cliVersion === "") return undefined;

  if (!isObject(capturedValues)) return undefined;
  const { cwd, sessionId, extra } = capturedValues;
  if (typeof cwd !== "string" || typeof sessionId !== "string") return undefined;
  if (extra !== undefined && !isStringRecord(extra)) return undefined;

  if (!Array.isArray(system) || system.length === 0) return undefined;
  const systemBlocks: ReconstructionTemplate["system"] = [];
  for (const block of system) {
    if (!isObject(block) || typeof block.text !== "string") return undefined;
    systemBlocks.push({ text: block.text });
  }

  if (tools !== undefined && !Array.isArray(tools)) return undefined;
  if (params !== undefined && !isObject(params)) return undefined;

  return {
    cliVersion,
    capturedValues: {
      cwd,
      sessionId,
      ...(extra !== undefined && { extra }),
    },
    system: systemBlocks,
    ...(tools !== undefined && { tools }),
    ...(params !== undefined && { params }),
  };
}

export interface SubstitutionValues {
  /** Absent when the session log recorded no cwd — its captured literal then stays. */
  cwd?: string;
  sessionId: string;
  /** Target values for the template's `capturedValues.extra` keys. */
  extra?: Record<string, string>;
}

export interface SubstitutionResult {
  text: string;
  /** Captured keys whose literal was replaced with a target value. */
  substituted: string[];
  /** Captured keys with no target value available — their literals remain verbatim. */
  unsubstituted: string[];
}

/**
 * Specialise one captured system block to a target session by replacing each
 * captured literal with the corresponding target value. DETERMINISTIC: the
 * replacements are applied most-specific-first (by descending captured-literal
 * length) so a longer literal that contains a shorter one — e.g. a scratchpad
 * path containing the `sessionId` — is replaced before its substring, never
 * corrupted by it. `cwd`/`sessionId` come from the session log; any `extra`
 * key without a provided target value is left as-is and reported in
 * `unsubstituted` so the gap is declared rather than silently wrong.
 */
export function substituteTemplateText(
  text: string,
  captured: ReconstructionTemplate["capturedValues"],
  target: SubstitutionValues,
): SubstitutionResult {
  const pairs: { key: string; from: string; to: string | undefined }[] = [
    { key: "cwd", from: captured.cwd, to: target.cwd },
    { key: "sessionId", from: captured.sessionId, to: target.sessionId },
  ];
  for (const [key, from] of Object.entries(captured.extra ?? {})) {
    pairs.push({ key, from, to: target.extra?.[key] });
  }
  // Most-specific-first: longer captured literals replaced before shorter ones.
  pairs.sort((a, b) => b.from.length - a.from.length);

  const substituted: string[] = [];
  const unsubstituted: string[] = [];
  let out = text;
  for (const { key, from, to } of pairs) {
    if (to === undefined) {
      unsubstituted.push(key);
      continue;
    }
    if (from === "") continue;
    if (out.includes(from)) {
      out = out.split(from).join(to);
      substituted.push(key);
    }
  }
  return { text: out, substituted, unsubstituted };
}
