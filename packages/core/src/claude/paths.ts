/**
 * Pure path-deriving helpers shared by `store.ts` (which needs them to know
 * WHICH directories to enumerate for `listSidecarFiles`, with no I/O of its
 * own) and `subagents.ts`/`workflows.ts` (which re-export these for external
 * callers — see each module's own doc comment). Kept dependency-free so
 * `store.ts` can import them without a cycle back through the modules that
 * consume the store.
 */

import { basename, dirname } from "node:path";

/**
 * Join path segments like an ordinary absolute path — WITHOUT `node:path`'s
 * `join`, which collapses ANY repeated `/` in the string, including the
 * `://` scheme separator of an `s3://bucket/...` store-scoped URI
 * (`path.join("s3://bucket/x", "y")` => `"s3:/bucket/x/y"`, silently
 * corrupting it). This only trims the boundary between segments and
 * concatenates with a single `/`, leaving anything INSIDE a segment (like a
 * scheme's `//`) untouched. `dirname`/`basename` are safe to use as-is — they
 * only ever look at the LAST `/`, never collapse repeats — so this is the one
 * path helper that needs a from-scratch implementation here.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((segment, i) => {
      let s = segment;
      if (i > 0) s = s.replace(/^\/+/, "");
      if (i < segments.length - 1) s = s.replace(/\/+$/, "");
      return s;
    })
    .filter((s) => s !== "")
    .join("/");
}

/** Sidecar directory holding a session's subagent/workflow data, sibling to the main JSONL file. */
function sessionDirFor(mainFilePath: string): string {
  const sessionId = basename(mainFilePath, ".jsonl");
  return joinPath(dirname(mainFilePath), sessionId);
}

/** Directory containing per-agent sidecar transcripts for a main session file. */
export function subagentsDirFor(mainFilePath: string): string {
  return joinPath(sessionDirFor(mainFilePath), "subagents");
}

/** Directory containing per-run state files for a main session file. */
export function workflowsDirFor(mainFilePath: string): string {
  return joinPath(sessionDirFor(mainFilePath), "workflows");
}
