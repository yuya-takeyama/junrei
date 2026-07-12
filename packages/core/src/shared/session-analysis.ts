import type { DelegationSummary } from "./delegation.js";
import type {
  ContextPoint,
  FileAccessEntry,
  ModelUsageSummary,
  SkillInvocation,
  TokenTotals,
  UsageSummary,
} from "./metrics.js";

/** Which harness produced a session transcript. */
export type SessionSource = "claude-code" | "codex";

/**
 * One compaction event — a context-window compaction boundary, wherever a
 * harness records one (Claude Code's `compact_boundary` system record, a
 * Codex `compacted` envelope). Plain data, agent-agnostic, so both
 * `claude/session-data.ts` and `codex/analyze.ts` populate the exact same
 * shape onto `SessionAnalysisCore.compactions` below.
 */
export interface CompactionEvent {
  line: number;
  timestamp?: string;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

/**
 * Fields genuinely shared between Claude Code and Codex CLI session
 * analyses. Harness-specific detail — Claude's subagent tree and per-tool
 * breakdowns, Codex's turn/tool-call metadata — lives on the discriminated
 * `ClaudeSessionAnalysis` / `CodexSessionAnalysis` variants (see
 * `analyze.ts` and `codex/analyze.ts`) instead of being faked here with
 * empty placeholders.
 *
 * `fileAccess`/`skillInvocations` are promoted here (rather than kept as
 * Claude-only fields, the way `subagents`/`toolStats` are) because both
 * harnesses can honestly populate the exact same shape — a path with
 * read/edit tallies, a named skill invocation — and doing so lets the Files
 * & skills lens (web) render either source through one code path instead of
 * branching on `session.source`. See `codex/files-skills.ts` for how Codex
 * derives them (deterministic `apply_patch` parsing for edits, a heuristic
 * for shell-command reads, markdown-link parsing for skill invocations).
 */
export interface SessionAnalysisCore {
  sessionId: string;
  filePath: string;
  cwd?: string;
  /**
   * Repo-level grouping key derived from `cwd` — see `deriveRepoIdentity`
   * (`repo.ts`). Undefined when `cwd` itself is undefined.
   */
  repoRoot?: string;
  /** Set alongside `repoRoot` only when `cwd` was under a `.claude/worktrees/<name>` path. */
  worktreeName?: string;
  gitBranch?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  userTurnCount: number;
  models: string[];
  /** Main transcript only — Codex sessions have no subagent concept, so this equals `totalUsage`'s token side. */
  usage: UsageSummary;
  /** Main + all subagents (Claude) or just the session itself (Codex). */
  totalUsage: TokenTotals & { costUsd: number; costIsComplete: boolean };
  /** Per-model usage, merged (recursively for Claude) by model id. */
  totalUsageByModel: ModelUsageSummary[];
  /**
   * Main-vs-subagents split of `totalUsage`/`totalUsageByModel` — see
   * `DelegationSummary`. Claude computes this once, at parse time
   * (`analyze.ts`), over the already-resolved subagent forest. Codex can't:
   * a session's own rollout never sees its descendants' files, so
   * `analyzeCodexSession` populates this with an own-thread-only value
   * (`subagents` all zero, same as its own `totalUsage` before the serve-time
   * rollup) and `getCodexSession` (server) OVERRIDES it once the sub-agent
   * forest is known — same override pattern as `totalUsage`/
   * `totalUsageByModel` there.
   */
  delegation: DelegationSummary;
  contextTimeline: ContextPoint[];
  compactions: CompactionEvent[];
  firstUserPrompt?: string;
  /** Source line of the first user prompt (provenance for the Overview lens's "L<n>" ref). */
  firstUserPromptLine?: number;
  parseWarningCount: number;
  /**
   * Per-file read/edit/injection tally. Claude: main + every subagent, merged
   * (see `analyze.ts`) — includes paths whose content entered context without
   * a Read/Edit call at all (CLAUDE.md/MEMORY.md system-reminders, Skill
   * `SKILL.md` loads), see `FileAccessEntry.injectedCount`. Codex: this
   * session's own transcript, merged with every descendant sub-agent thread
   * at serve time (see `getCodexSession`/`mergeCodexFileAccess` on the
   * server) — same main/subagent/both `threads` vocabulary either way, but no
   * injection tracking (see `codex/files-skills.ts`).
   */
  fileAccess: FileAccessEntry[];
  /** True when the merged path count exceeded the cap (500) and entries were dropped. */
  fileAccessTruncated: boolean;
  /** Present only when `fileAccessTruncated` — number of distinct paths dropped by the cap. */
  fileAccessOmittedCount?: number;
  /** Skill/slash-command invocations, main transcript only — see `SkillInvocation`. */
  skillInvocations: SkillInvocation[];
}
