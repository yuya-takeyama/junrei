import type { SessionAnalysis } from "@junrei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSession, listSessions } from "./sessions.js";

const sessionRef = {
  project: z.string().describe("Munged project directory name (from list_sessions)"),
  sessionId: z.string().describe("Session UUID (from list_sessions)"),
};

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function notFound(project: string, sessionId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Session not found: ${project}/${sessionId}. Use list_sessions to discover sessions.`,
      },
    ],
    isError: true,
  };
}

/** Compact summary: the full analysis minus bulky series (fetch those via dedicated tools). */
function toSummary(analysis: SessionAnalysis) {
  const { contextTimeline, subagents, toolStats, repetitions, ...rest } = analysis;
  return {
    ...rest,
    toolStats,
    repetitionCount: repetitions.length,
    contextTimeline: {
      points: contextTimeline.length,
      peakContextTokens: Math.max(0, ...contextTimeline.map((p) => p.contextTokens)),
      lastContextTokens: contextTimeline.at(-1)?.contextTokens ?? 0,
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
        "List recent Claude Code sessions (newest first) with quantitative overview: " +
        "turns, tool calls/errors, subagents, compactions, tokens, estimated cost (USD).",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Max sessions (default 20)"),
      },
    },
    async ({ limit }) => jsonResult(await listSessions(limit ?? 20)),
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "Full quantitative summary of one session: usage/cost per model (main + subagents), " +
        "tool stats with error categories, exploration profile, compactions, and counts. " +
        "Use get_context_timeline / find_repetitions / get_subagent_tree for the detailed series.",
      inputSchema: sessionRef,
    },
    async ({ project, sessionId }) => {
      const analysis = await getSession(project, sessionId);
      return analysis === undefined
        ? notFound(project, sessionId)
        : jsonResult(toSummary(analysis));
    },
  );

  server.registerTool(
    "get_context_timeline",
    {
      description:
        "Context-size series for one session: effective context tokens " +
        "(input + cache_read + cache_creation) per API message, plus compaction events " +
        "with pre/post token counts. Each point carries its source line number for provenance.",
      inputSchema: sessionRef,
    },
    async ({ project, sessionId }) => {
      const analysis = await getSession(project, sessionId);
      return analysis === undefined
        ? notFound(project, sessionId)
        : jsonResult({
            contextTimeline: analysis.contextTimeline,
            compactions: analysis.compactions,
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
        "depends on the task.",
      inputSchema: sessionRef,
    },
    async ({ project, sessionId }) => {
      const analysis = await getSession(project, sessionId);
      return analysis === undefined
        ? notFound(project, sessionId)
        : jsonResult({ repetitions: analysis.repetitions });
    },
  );

  server.registerTool(
    "get_subagent_tree",
    {
      description:
        "Subagent execution tree for one session: per-agent type, model, prompt preview, " +
        "token usage, estimated cost, tool call/error counts, and nesting.",
      inputSchema: sessionRef,
    },
    async ({ project, sessionId }) => {
      const analysis = await getSession(project, sessionId);
      return analysis === undefined
        ? notFound(project, sessionId)
        : jsonResult({
            subagentCount: analysis.subagentCount,
            subagents: analysis.subagents,
          });
    },
  );

  server.registerTool(
    "get_first_prompt",
    {
      description:
        "The first user prompt of a session (truncated preview) — the original task " +
        "the quantitative data should be interpreted against.",
      inputSchema: sessionRef,
    },
    async ({ project, sessionId }) => {
      const analysis = await getSession(project, sessionId);
      return analysis === undefined
        ? notFound(project, sessionId)
        : jsonResult({
            firstUserPrompt: analysis.firstUserPrompt ?? null,
            title: analysis.title ?? null,
            userTurnCount: analysis.userTurnCount,
          });
    },
  );

  return server;
}
