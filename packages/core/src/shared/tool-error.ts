/**
 * Harness-neutral vocabulary for classifying a failed tool call, promoted
 * here (out of `claude/metrics.ts`, its original home) so the shared
 * cross-tool analytics engine (`./tool-usage-stats.ts`) can tally
 * `byTool[].errorCategories` without importing from the `claude/` tree — same
 * "shared data shape, one canonical export site" convention `FileAccessEntry`/
 * `BashStats` already follow. `claude/metrics.ts` re-exports this type (and
 * owns the regex-based `classifyToolError` that produces it) so existing
 * `@junrei/core` importers see no change.
 */
export type ToolErrorCategory =
  | "file-not-found"
  | "string-not-found"
  | "command-failed"
  | "permission-denied"
  | "interrupted"
  | "timeout"
  | "other";
