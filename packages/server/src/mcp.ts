import type { ClaudeSessionAnalysis } from "@junrei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRepoOverview } from "./overview.js";
import {
  DEFAULT_MAX_MATCHES_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  MAX_MATCHES_PER_SESSION,
  MAX_MAX_SESSIONS,
  searchSessions,
} from "./search.js";
import {
  type CodexSessionAnalysisWithSubagents,
  getCodexSession,
  getSession,
  listSessions,
  MAX_LIST_LIMIT,
} from "./sessions.js";

const sessionRef = {
  source: z.enum(["claude-code", "codex"]).describe("Which harness the session came from"),
  sessionId: z.string().describe("Session UUID (from list_sessions)"),
};

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function notFound(sessionId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Session not found: ${sessionId}. Use list_sessions to discover sessions.`,
      },
    ],
    isError: true,
  };
}

/**
 * `repo` blank/whitespace-only. A `repo` that's well-formed but simply
 * matches no session is NOT an error — `computeRepoOverview` returns a
 * zeroed overview for that case (see its doc comment), so an agent can
 * safely probe candidate keys without a not-found round-trip.
 */
function missingRepo() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "repo is required — pass a repoRoot path or fallback bucket key " +
          "(claude-project:<projectDirName> / codex-repo:<repoUrl> / codex-cwd:<cwd>) " +
          "from list_sessions items.",
      },
    ],
    isError: true,
  };
}

/**
 * Claude-only tools (repetition detection, task executions) have no Codex
 * analog. `get_subagent_tree` USED to be Claude-only too, but Codex sub-agent
 * threads (`codex/orchestration.ts` in `@junrei/core`) now have a real tree
 * — see `resolveAnalysis`/`get_subagent_tree` below.
 */
function notAvailableForCodex() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "not available for Codex sessions (source: codex) — Codex CLI has no repetition " +
          "detection or task-execution log in Junrei today.",
      },
    ],
    isError: true,
  };
}

type SessionRefArgs = {
  source: "claude-code" | "codex";
  sessionId: string;
};

type ResolvedAnalysis =
  | { source: "claude-code"; analysis: ClaudeSessionAnalysis }
  | { source: "codex"; analysis: CodexSessionAnalysisWithSubagents }
  | { error: ReturnType<typeof notFound> };

/**
 * Resolve either harness's analysis from `{source, sessionId}` — both sources
 * now look up by bare session id alone (Claude used to also require
 * `project`, but session ids are UUIDv4, so a bare id resolves unambiguously;
 * see `ClaudeSessionKey`'s doc comment in `sources/claude.ts`).
 */
async function resolveAnalysis(args: SessionRefArgs): Promise<ResolvedAnalysis> {
  if (args.source === "codex") {
    const analysis = await getCodexSession(args.sessionId);
    return analysis === undefined
      ? { error: notFound(args.sessionId) }
      : { source: "codex", analysis };
  }
  const analysis = await getSession(args.sessionId);
  return analysis === undefined
    ? { error: notFound(args.sessionId) }
    : { source: "claude-code", analysis };
}

/** Compact summary: the full analysis minus bulky series (fetch those via dedicated tools). */
function toSummary(analysis: ClaudeSessionAnalysis) {
  const {
    contextTimeline,
    subagents,
    toolStats,
    repetitions,
    taskExecutions,
    turnUsage,
    apiErrors,
    ...rest
  } = analysis;
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const task of taskExecutions) {
    byKind[task.kind] = (byKind[task.kind] ?? 0) + 1;
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  }
  const errorsByStatus: Record<string, number> = {};
  for (const error of apiErrors) {
    const key = error.status === undefined ? "unknown" : String(error.status);
    errorsByStatus[key] = (errorsByStatus[key] ?? 0) + 1;
  }
  return {
    ...rest,
    toolStats,
    repetitionCount: repetitions.length,
    taskExecutions: { total: taskExecutions.length, byKind, byStatus },
    contextTimeline: {
      points: contextTimeline.length,
      peakContextTokens: Math.max(0, ...contextTimeline.map((p) => p.contextTokens)),
      lastContextTokens: contextTimeline.at(-1)?.contextTokens ?? 0,
    },
    turnUsage: {
      turns: turnUsage.length,
      totalApiMessages: turnUsage.reduce((sum, t) => sum + t.apiMessageCount, 0),
      peakOutputTokens: Math.max(0, ...turnUsage.map((t) => t.outputTokens)),
      peakApiMessages: Math.max(0, ...turnUsage.map((t) => t.apiMessageCount)),
    },
    // apiErrorCount (in ...rest) keeps counting past the list cap; this
    // histogram covers only the listed entries.
    apiErrors: { listed: apiErrors.length, byStatus: errorsByStatus },
  };
}

/**
 * Codex analog of `toSummary` — same "trim the bulky series" shape, over
 * Codex's own fields. `subagents` (the full tree) is trimmed the same way
 * Claude's `toSummary` trims it — `subagentCount` stays in `...rest` for the
 * cheap "does this session delegate at all" signal; use `get_subagent_tree`
 * for the full tree.
 */
function toCodexSummary(analysis: CodexSessionAnalysisWithSubagents) {
  const { contextTimeline, codex, subagents, ...rest } = analysis;
  const { turns, ...codexRest } = codex;
  return {
    ...rest,
    contextTimeline: {
      points: contextTimeline.length,
      peakContextTokens: Math.max(0, ...contextTimeline.map((p) => p.contextTokens)),
      lastContextTokens: contextTimeline.at(-1)?.contextTokens ?? 0,
    },
    codex: {
      ...codexRest,
      turns: {
        count: turns.length,
        totalOutputTokens: turns.reduce((sum, t) => sum + t.outputTokens, 0),
        peakOutputTokens: Math.max(0, ...turns.map((t) => t.outputTokens)),
      },
    },
  };
}

/**
 * Junrei's MCP interface: a small set of high-leverage tools that expose
 * quantitative session data. Junrei never evaluates — interpretation is the
 * caller's job.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "junrei", version: "0.1.0" });

  server.registerTool(
    "list_sessions",
    {
      description:
        "List recent Claude Code and/or Codex CLI sessions (newest first) with quantitative " +
        "overview: turns, tool calls/errors, subagents (Claude only), compactions, tokens, " +
        'estimated cost (USD). Each item\'s `source` field is "claude-code" or "codex". Each ' +
        "item also carries `repoRoot`/`worktreeName` (repo-level grouping key — see " +
        "get_repo_overview), a per-model `usageByModel` breakdown, and a `delegation` " +
        "main-vs-subagents split, so a repo- or model-level rollup can be built without " +
        "fetching every session's full summary.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Max sessions (default 20)"),
        source: z
          .enum(["claude-code", "codex", "all"])
          .optional()
          .describe(
            "Restrict to one harness; omit for both, merged and sorted by start time (newest first)",
          ),
      },
    },
    // Omitted source = merged view, same default as the HTTP API — items
    // self-describe via `source`. The tool keeps returning a bare array
    // (not the HTTP route's `{ sessions, total }` page envelope) so existing
    // MCP consumers' parsing doesn't break.
    async ({ limit, source }) =>
      jsonResult((await listSessions(limit ?? 20, source ?? "all")).sessions),
  );

  server.registerTool(
    "search_sessions",
    {
      description:
        "Substring search across session transcripts (both harnesses, newest session first). " +
        "The query is plain text (not regex), matched case-insensitively by default against " +
        "DECODED string values — user prompts, assistant text, tool inputs, tool results, " +
        "titles — never against raw JSON, so quotes/newlines in the query need no escaping " +
        "and JSON escaping in the log can never split a match. Use it to find WHICH past " +
        "session mentioned something while spending minimal context: each result carries the " +
        "session ref fields (`source`/`sessionId`) the session-scoped tools take, " +
        "a short snippet per matched record with its source line number, an exact per-session " +
        "`matchCount`, and explicit truncation flags (`matchesTruncated`/`resultsTruncated` — " +
        "a capped list is never silently complete). Drill into a hit with get_session_summary " +
        "/ get_first_prompt / get_context_timeline.",
      inputSchema: {
        query: z.string().min(2).describe("Substring to find (plain text, not regex)"),
        source: z
          .enum(["claude-code", "codex", "all"])
          .optional()
          .describe("Restrict to one harness; omit for both"),
        project: z
          .string()
          .optional()
          .describe("Claude only: restrict to one munged project dir (from list_sessions)"),
        repo: z
          .string()
          .optional()
          .describe(
            "Restrict to one repo: a repoRoot path or fallback bucket key " +
              "(claude-project:<dir> / codex-repo:<repoUrl> / codex-cwd:<cwd>) — same " +
              "semantics as get_repo_overview",
          ),
        sessionId: z
          .string()
          .optional()
          .describe("Restrict to one session (locate where inside it something was said)"),
        fields: z
          .array(z.enum(["user", "assistant", "thinking", "tool_input", "tool_result", "title"]))
          .optional()
          .describe(
            'Record fields to search. Default: every field except "thinking" ' +
              "(opt in explicitly — thinking text is noisy).",
          ),
        caseSensitive: z.boolean().optional().describe("Default false"),
        since: z
          .string()
          .optional()
          .describe("ISO 8601 — only sessions last active at/after this time"),
        until: z
          .string()
          .optional()
          .describe("ISO 8601 — only sessions last active at/before this time"),
        scanLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(
            `How many most-recent sessions to scan after filtering (default ${MAX_LIST_LIMIT} ` +
              "= everything listable)",
          ),
        maxSessions: z
          .number()
          .int()
          .min(1)
          .max(MAX_MAX_SESSIONS)
          .optional()
          .describe(`Max matched sessions returned (default ${DEFAULT_MAX_SESSIONS})`),
        maxMatchesPerSession: z
          .number()
          .int()
          .min(1)
          .max(MAX_MATCHES_PER_SESSION)
          .optional()
          .describe(
            `Max snippets per session (default ${DEFAULT_MAX_MATCHES_PER_SESSION}; ` +
              "matchCount stays exact past the cap)",
          ),
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            "Also search subagent transcripts (Claude sidecars / Codex sub-agent threads), " +
              "attributed to the parent session with agentId on each match. Default false",
          ),
      },
    },
    async (args) => {
      if (args.query.trim().length < 2) {
        return {
          content: [
            {
              type: "text" as const,
              text: "query must contain at least 2 non-whitespace-only characters.",
            },
          ],
          isError: true,
        };
      }
      for (const key of ["since", "until"] as const) {
        const value = args[key];
        if (value !== undefined && Number.isNaN(Date.parse(value))) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${key} is not a parseable ISO 8601 timestamp: ${value}`,
              },
            ],
            isError: true,
          };
        }
      }
      return jsonResult(await searchSessions(args));
    },
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "Full quantitative summary of one session: usage/cost per model (main + subagents), " +
        "a `delegation` split (main-thread vs. subagents share of tokens and cost — overall and " +
        "per model, e.g. to spot a session where the main model took most of the DOLLARS but " +
        "subagents moved most of the TOKENS), tool stats with error categories, exploration " +
        "profile, compactions, and counts. Works for both Claude Code sessions and Codex CLI " +
        'sessions (source: "codex"). Use get_context_timeline / find_repetitions / ' +
        "get_subagent_tree for the detailed series. A model-usage entry's `cacheWriteCostUsd` " +
        "(on `usage`/`totalUsageByModel`) is a component already included in `costUsd` — never " +
        "add them. `costIsComplete: false` (on `totalUsage`/`delegation`) means at least one " +
        "nonzero-usage model had no pricing entry, so the cost is a lower bound, shown as " +
        '"estimated" in the UI.',
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        resolved.source === "codex"
          ? toCodexSummary(resolved.analysis)
          : toSummary(resolved.analysis),
      );
    },
  );

  server.registerTool(
    "get_context_timeline",
    {
      description:
        "Context-size series for one session: effective context tokens " +
        "(input + cache_read + cache_creation) per API message, plus compaction events " +
        "with pre/post token counts. Each point carries its source line number for provenance. " +
        'Works for both Claude Code sessions and Codex CLI sessions (source: "codex").',
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult({
        contextTimeline: resolved.analysis.contextTimeline,
        compactions: resolved.analysis.compactions,
      });
    },
  );

  server.registerTool(
    "find_repetitions",
    {
      description:
        "Repetition/loop findings for one session: consecutive identical tool calls, " +
        "same-file re-reads, and repeated failing calls. Includes source line numbers. " +
        "These are observations, not judgments — whether a repetition was wasteful " +
        "depends on the task. Claude Code sessions only.",
      inputSchema: sessionRef,
    },
    async ({ source, sessionId }) => {
      if (source === "codex") return notAvailableForCodex();
      const analysis = await getSession(sessionId);
      return analysis === undefined
        ? notFound(sessionId)
        : jsonResult({ repetitions: analysis.repetitions });
    },
  );

  server.registerTool(
    "get_subagent_tree",
    {
      description:
        "Subagent/sub-agent execution tree for one session: per-agent type, model, prompt " +
        "preview, token usage, estimated cost, tool call/error counts, and nesting. Each node's " +
        "`usage.byModel` breaks that agent's own tokens/cost down per model, same shape as the " +
        "session-level `totalUsageByModel`. Works for both Claude Code sessions and Codex CLI " +
        'sessions (source: "codex") — a Codex sub-agent is its own rollout file rather than a ' +
        "sidecar transcript, but resolves into the same tree shape. As with get_session_summary: " +
        "a `byModel` entry's `cacheWriteCostUsd` is already included in `costUsd` (never add " +
        "them), and `usage.total.costIsComplete: false` means at least one nonzero-usage model " +
        'in that node had no pricing entry — the cost is a lower bound, shown as "estimated" in ' +
        "the UI. Claude Code sessions only also carry `workflowRuns`: one entry per Workflow-tool " +
        "run (name, status, phases, agentCount), for making sense of any tree node tagged with a " +
        "matching `workflowRunId` — those nodes are flat root-level entries in `subagents`, not a " +
        "separate nested structure.",
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult({
        subagentCount: resolved.analysis.subagentCount,
        subagents: resolved.analysis.subagents,
        ...(resolved.source === "claude-code" && { workflowRuns: resolved.analysis.workflowRuns }),
      });
    },
  );

  server.registerTool(
    "get_task_executions",
    {
      description:
        "All task executions of a session, as Claude Code's Background-tasks panel counts " +
        "them: every Bash command and Agent run (foreground and background) plus preview " +
        "servers — with start time, duration, and outcome (completed/failed/stopped/unresolved). " +
        "Claude Code sessions only.",
      inputSchema: sessionRef,
    },
    async ({ source, sessionId }) => {
      if (source === "codex") return notAvailableForCodex();
      const analysis = await getSession(sessionId);
      return analysis === undefined
        ? notFound(sessionId)
        : jsonResult({ taskExecutions: analysis.taskExecutions });
    },
  );

  server.registerTool(
    "get_first_prompt",
    {
      description:
        "The first user prompt of a session (truncated preview) — the original task " +
        "the quantitative data should be interpreted against. Works for both Claude Code " +
        'sessions and Codex CLI sessions (source: "codex").',
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult({
        firstUserPrompt: resolved.analysis.firstUserPrompt ?? null,
        title: resolved.analysis.title ?? null,
        userTurnCount: resolved.analysis.userTurnCount,
      });
    },
  );

  server.registerTool(
    "get_repo_overview",
    {
      description:
        "Repo-level retrospective across every session (both harnesses) in one repo: total " +
        "cost/tokens, a per-day cost timeline, a merged per-model breakdown, the main-vs-" +
        "subagents delegation split, and the top 5 sessions by cost. `repo` accepts either a " +
        "`repoRoot` absolute path (a list_sessions item's `repoRoot` field — a worktree " +
        "session, `.claude/worktrees/<name>` or Codex's `$CODEX_HOME/worktrees/<hash>`, " +
        "collapses into its parent repo's key, see `worktreeName`) " +
        "or, for a session with no `repoRoot`, the fallback bucket key list_sessions items " +
        "imply: `claude-project:<projectDirName>` (Claude), `codex-repo:<repoUrl>` (Codex " +
        "with a repository URL no local checkout anchors), or `codex-cwd:<cwd>` (Codex, " +
        "`codex-cwd:(unknown cwd)` when even `cwd` is missing). Examples: `/Users/me/junrei`, " +
        "`claude-project:-Users-me-proj`. A `byModel` entry's `cacheWriteCostUsd` (where " +
        "present, as in get_session_summary/get_subagent_tree) is already included in `costUsd` " +
        "— never add them. `costIsComplete: false` means at least one nonzero-usage model summed " +
        'into this rollup had no pricing entry, so totals are a lower bound, shown as "estimated" ' +
        "in the UI. A `repo` matching no session returns a zeroed overview (`sessionCount: 0`), " +
        "not an error — safe to probe candidate keys.",
      inputSchema: {
        repo: z
          .string()
          .describe(
            "A repoRoot absolute path, or a fallback bucket key (claude-project:<projectDirName> " +
              "/ codex-repo:<repoUrl> / codex-cwd:<cwd>) for a session with no repoRoot — both " +
              "come from list_sessions items. Example: /Users/me/junrei",
          ),
      },
    },
    async ({ repo }) => {
      if (repo.trim() === "") return missingRepo();
      return jsonResult(await getRepoOverview(repo));
    },
  );

  return server;
}
