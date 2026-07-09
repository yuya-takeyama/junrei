import type { ClaudeSessionAnalysis } from "@junrei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type CodexSessionAnalysisWithSubagents,
  getCodexSession,
  getSession,
  listSessions,
} from "./sessions.js";

const sessionRef = {
  source: z.enum(["claude-code", "codex"]).describe("Which harness the session came from"),
  sessionId: z.string().describe("Session UUID (from list_sessions)"),
  project: z
    .string()
    .optional()
    .describe(
      "Munged project directory name (from list_sessions) — required for claude-code " +
        "sessions, ignored for codex.",
    ),
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

function missingProject() {
  return {
    content: [
      {
        type: "text" as const,
        text: "project is required for claude-code sessions (from list_sessions).",
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
  project?: string | undefined;
};

type ResolvedAnalysis =
  | { source: "claude-code"; analysis: ClaudeSessionAnalysis }
  | { source: "codex"; analysis: CodexSessionAnalysisWithSubagents }
  | { error: ReturnType<typeof notFound> | ReturnType<typeof missingProject> };

/**
 * Resolve either harness's analysis from `{source, sessionId, project?}`:
 * `source: "codex"` looks up by `sessionId` alone (Codex has no project-dir
 * concept); `source: "claude-code"` requires `project` and errors clearly
 * when it's missing rather than silently guessing.
 */
async function resolveAnalysis(args: SessionRefArgs): Promise<ResolvedAnalysis> {
  if (args.source === "codex") {
    const analysis = await getCodexSession(args.sessionId);
    return analysis === undefined
      ? { error: notFound(args.sessionId) }
      : { source: "codex", analysis };
  }
  if (args.project === undefined) return { error: missingProject() };
  const analysis = await getSession(args.project, args.sessionId);
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
        'estimated cost (USD). Each item\'s `source` field is "claude-code" or "codex".',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Max sessions (default 20)"),
        source: z
          .enum(["claude-code", "codex", "all"])
          .optional()
          .describe("Restrict to one harness; omit for both, merged and sorted by recency"),
      },
    },
    // Omitted source = merged view, same default as the HTTP API — items
    // self-describe via `source`.
    async ({ limit, source }) => jsonResult(await listSessions(limit ?? 20, source ?? "all")),
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "Full quantitative summary of one session: usage/cost per model (main + subagents), " +
        "tool stats with error categories, exploration profile, compactions, and counts. " +
        'Works for both Claude Code sessions and Codex CLI sessions (source: "codex"). ' +
        "Use get_context_timeline / find_repetitions / get_subagent_tree for the detailed series.",
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
    async ({ source, project, sessionId }) => {
      if (source === "codex") return notAvailableForCodex();
      if (project === undefined) return missingProject();
      const analysis = await getSession(project, sessionId);
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
        "preview, token usage, estimated cost, tool call/error counts, and nesting. Works for " +
        'both Claude Code sessions and Codex CLI sessions (source: "codex") — a Codex ' +
        "sub-agent is its own rollout file rather than a sidecar transcript, but resolves " +
        "into the same tree shape.",
      inputSchema: sessionRef,
    },
    async (args) => {
      const resolved = await resolveAnalysis(args);
      if ("error" in resolved) return resolved.error;
      return jsonResult({
        subagentCount: resolved.analysis.subagentCount,
        subagents: resolved.analysis.subagents,
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
    async ({ source, project, sessionId }) => {
      if (source === "codex") return notAvailableForCodex();
      if (project === undefined) return missingProject();
      const analysis = await getSession(project, sessionId);
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

  return server;
}
