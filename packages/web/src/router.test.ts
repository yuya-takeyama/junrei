import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import {
  ALL_REPOS,
  agentLensesFor,
  agentPath,
  agentRecordPath,
  BRIEFING_PERIOD_DAYS,
  CLAUDE_AGENT_ROUTE_PATH,
  CLAUDE_SESSION_ROUTE_PATH,
  CODEX_AGENT_ROUTE_PATH,
  CODEX_SESSION_ROUTE_PATH,
  canonicalLensSuffix,
  DEFAULT_BRIEFING_PERIOD_DAYS,
  isLegacyClaudeProjectScopedUrl,
  LEARNINGS_ROUTE_PATH,
  LENSES_BY_SOURCE,
  legacyAgentLensRedirect,
  legacyClaudeSessionRedirectTarget,
  legacySessionLensRedirect,
  legacySessionListRedirectTarget,
  NAV_ITEMS,
  normalizeEvidenceSub,
  normalizeLens,
  normalizeToolsSub,
  parseBriefingPeriodDays,
  parseDayParam,
  parseListPage,
  parseRecordAgentParam,
  parseRecordParam,
  parseRepoParam,
  parseSourceTab,
  recordPath,
  SESSION_LENSES,
  SESSIONS_ROUTE_PATH,
  sessionPath,
  sessionRefOf,
} from "./router.js";

describe("SESSION_LENSES", () => {
  it("is the three-lens Story / Orchestration / Evidence lineup", () => {
    expect(SESSION_LENSES).toEqual(["story", "orchestration", "evidence"]);
  });
});

describe("LENSES_BY_SOURCE", () => {
  it("gives both sources the same three session lenses", () => {
    expect(LENSES_BY_SOURCE["claude-code"]).toEqual(SESSION_LENSES);
    expect(LENSES_BY_SOURCE.codex).toEqual(SESSION_LENSES);
  });
});

describe("agentLensesFor", () => {
  it("omits Orchestration for a Claude subagent (no own forest) — only built lenses become tabs", () => {
    expect(agentLensesFor("claude-code")).toEqual(["story", "evidence"]);
  });

  it("includes Orchestration for a Codex subagent (its own analysis carries a forest)", () => {
    expect(agentLensesFor("codex")).toEqual(["story", "orchestration", "evidence"]);
  });
});

describe("sessionPath", () => {
  it("omits the lens segment for story (default), Claude source", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" })).toBe(
      "/session/claude-code/abc123",
    );
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "story")).toBe(
      "/session/claude-code/abc123",
    );
  });

  it("builds the orchestration path", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "orchestration")).toBe(
      "/session/claude-code/abc123/orchestration",
    );
  });

  it("omits the evidence sub for the default Context sub-tab", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "evidence")).toBe(
      "/session/claude-code/abc123/evidence",
    );
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "evidence", "context")).toBe(
      "/session/claude-code/abc123/evidence",
    );
  });

  it("builds the Files and Tools evidence sub-tab paths", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "evidence", "files")).toBe(
      "/session/claude-code/abc123/evidence/files",
    );
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "evidence", "tools")).toBe(
      "/session/claude-code/abc123/evidence/tools",
    );
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "evidence", "tools", "all")).toBe(
      "/session/claude-code/abc123/evidence/tools",
    );
  });

  it("builds the Tools Bash sub path (third segment)", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "evidence", "tools", "bash")).toBe(
      "/session/claude-code/abc123/evidence/tools/bash",
    );
    expect(sessionPath({ source: "codex", id: "abc123" }, "evidence", "tools", "bash")).toBe(
      "/session/codex/abc123/evidence/tools/bash",
    );
  });

  it("percent-encodes the id and has no :project segment for either source", () => {
    expect(sessionPath({ source: "claude-code", id: "c d" })).toBe("/session/claude-code/c%20d");
    expect(sessionPath({ source: "codex", id: "c d" }, "evidence")).toBe(
      "/session/codex/c%20d/evidence",
    );
  });
});

describe("sessionRefOf", () => {
  it("builds refs from sessionId alone (projectDirName is display-only now)", () => {
    expect(sessionRefOf({ source: "claude-code", sessionId: "abc" })).toEqual({
      source: "claude-code",
      id: "abc",
    });
    expect(sessionRefOf({ source: "codex", sessionId: "abc" })).toEqual({
      source: "codex",
      id: "abc",
    });
  });
});

describe("recordPath", () => {
  it("appends a record search param to the story path", () => {
    expect(recordPath({ source: "claude-code", id: "abc123" }, "story", 42)).toBe(
      "/session/claude-code/abc123?record=42",
    );
  });

  it("keeps the evidence sub-tab (and tools sub) in the record's path", () => {
    expect(
      recordPath({ source: "claude-code", id: "abc123" }, "evidence", 42, {
        sub: "tools",
        toolsSub: "bash",
      }),
    ).toBe("/session/claude-code/abc123/evidence/tools/bash?record=42");
    expect(
      recordPath({ source: "claude-code", id: "abc123" }, "evidence", 42, { sub: "files" }),
    ).toBe("/session/claude-code/abc123/evidence/files?record=42");
  });

  it("appends an agent param after record, percent-encoded", () => {
    expect(
      recordPath({ source: "codex", id: "abc123" }, "evidence", 7, {
        agentId: "sub agent",
        sub: "tools",
      }),
    ).toBe("/session/codex/abc123/evidence/tools?record=7&agent=sub%20agent");
  });
});

describe("agentPath", () => {
  it("omits the lens segment for story (default)", () => {
    expect(agentPath({ source: "claude-code", id: "abc123" }, "agentA")).toBe(
      "/session/claude-code/abc123/agent/agentA",
    );
  });

  it("builds orchestration and evidence sub-tab paths", () => {
    expect(agentPath({ source: "codex", id: "abc123" }, "agentA", "orchestration")).toBe(
      "/session/codex/abc123/agent/agentA/orchestration",
    );
    expect(agentPath({ source: "claude-code", id: "abc123" }, "agentA", "evidence")).toBe(
      "/session/claude-code/abc123/agent/agentA/evidence",
    );
    expect(agentPath({ source: "claude-code", id: "abc123" }, "agentA", "evidence", "files")).toBe(
      "/session/claude-code/abc123/agent/agentA/evidence/files",
    );
  });

  it("percent-encodes id and agentId", () => {
    expect(agentPath({ source: "claude-code", id: "c d" }, "e f")).toBe(
      "/session/claude-code/c%20d/agent/e%20f",
    );
  });
});

describe("agentRecordPath", () => {
  it("appends a record search param to the agent story path", () => {
    expect(agentRecordPath({ source: "claude-code", id: "abc123" }, "agentA", "story", 42)).toBe(
      "/session/claude-code/abc123/agent/agentA?record=42",
    );
  });

  it("keeps the evidence sub in the agent record path", () => {
    expect(
      agentRecordPath({ source: "codex", id: "abc123" }, "agentA", "evidence", 42, "files"),
    ).toBe("/session/codex/abc123/agent/agentA/evidence/files?record=42");
  });
});

describe("route ranking: agent routes vs session routes", () => {
  const routes: RouteObject[] = [
    {
      path: "/",
      children: [
        { index: true, id: "index" },
        { path: CLAUDE_AGENT_ROUTE_PATH, id: "agent" },
        { path: CODEX_AGENT_ROUTE_PATH, id: "codex-agent" },
        { path: CLAUDE_SESSION_ROUTE_PATH, id: "claude-session" },
        { path: CODEX_SESSION_ROUTE_PATH, id: "codex-session" },
        { path: "*", id: "catchall" },
      ],
    },
  ];

  function matchedRouteId(pathname: string): string | undefined {
    const matches = matchRoutes(routes, pathname);
    return matches?.[matches.length - 1]?.route.id;
  }

  it("matches plain Claude session paths (with or without a lens) to CLAUDE_SESSION_ROUTE_PATH", () => {
    expect(matchedRouteId("/session/claude-code/id")).toBe("claude-session");
    expect(matchedRouteId("/session/claude-code/id/orchestration")).toBe("claude-session");
  });

  it("matches the evidence sub-tab URLs (:lens?/:sub?/:sub2?) to CLAUDE_SESSION_ROUTE_PATH", () => {
    expect(matchedRouteId("/session/claude-code/id/evidence")).toBe("claude-session");
    expect(matchedRouteId("/session/claude-code/id/evidence/files")).toBe("claude-session");
    expect(matchedRouteId("/session/claude-code/id/evidence/tools/bash")).toBe("claude-session");
  });

  it("matches Codex session paths (incl. legacy /turns and evidence subs) to CODEX_SESSION_ROUTE_PATH", () => {
    expect(matchedRouteId("/session/codex/id")).toBe("codex-session");
    expect(matchedRouteId("/session/codex/id/turns")).toBe("codex-session");
    expect(matchedRouteId("/session/codex/id/evidence/tools/bash")).toBe("codex-session");
  });

  it("matches agent paths (incl. an evidence sub) to the AGENT route, not the session route", () => {
    expect(matchedRouteId("/session/claude-code/id/agent/abc")).toBe("agent");
    expect(matchedRouteId("/session/claude-code/id/agent/abc/evidence/files")).toBe("agent");
    expect(matchedRouteId("/session/codex/id/agent/abc/orchestration")).toBe("codex-agent");
  });

  it("a legacy 2-segment URL (project/uuid, no lens) still matches CLAUDE_SESSION_ROUTE_PATH — SessionShell redirects it", () => {
    expect(
      matchedRouteId("/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111"),
    ).toBe("claude-session");
  });

  it("a legacy 3-segment URL (project/uuid/lens) matches CLAUDE_SESSION_ROUTE_PATH via its :sub? segment — SessionShell's UUID guard redirects it", () => {
    expect(
      matchedRouteId(
        "/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111/timeline",
      ),
    ).toBe("claude-session");
  });

  it("a short legacy agent-drilldown URL (project/uuid/agent/agentId) now matches CLAUDE_SESSION_ROUTE_PATH via :lens?/:sub?/:sub2? — SessionShell's UUID guard strips the project and re-resolves it to the agent route (see its project-scoped redirect, which preserves the trailing path verbatim rather than mapping lenses)", () => {
    expect(
      matchedRouteId(
        "/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111/agent/abc",
      ),
    ).toBe("claude-session");
  });

  it("a longer legacy agent-drilldown URL (project/uuid/agent/agentId/lens) is too long for the session route and falls through to the catch-all (legacyClaudeSessionRedirectTarget)", () => {
    expect(
      matchedRouteId(
        "/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111/agent/abc/context",
      ),
    ).toBe("catchall");
  });
});

describe("isLegacyClaudeProjectScopedUrl", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("is true when id is a non-UUID project dir and lens is a UUID", () => {
    expect(isLegacyClaudeProjectScopedUrl("-Users-proj", UUID)).toBe(true);
  });

  it("is false for a current-shape URL (id is already a UUID)", () => {
    expect(isLegacyClaudeProjectScopedUrl(UUID, undefined)).toBe(false);
    expect(isLegacyClaudeProjectScopedUrl(UUID, "story")).toBe(false);
  });

  it("is false when lens is missing or not a UUID, or id is missing", () => {
    expect(isLegacyClaudeProjectScopedUrl("-Users-proj", undefined)).toBe(false);
    expect(isLegacyClaudeProjectScopedUrl("-Users-proj", "evidence")).toBe(false);
    expect(isLegacyClaudeProjectScopedUrl(undefined, UUID)).toBe(false);
  });
});

describe("legacyClaudeSessionRedirectTarget", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("strips the project segment (leaving the trailing lens for SessionShell to normalize)", () => {
    expect(
      legacyClaudeSessionRedirectTarget(`/session/claude-code/-Users-proj/${UUID}/timeline`, ""),
    ).toBe(`/session/claude-code/${UUID}/timeline`);
  });

  it("strips the project segment from a legacy agent-drilldown URL and preserves the query", () => {
    expect(
      legacyClaudeSessionRedirectTarget(
        `/session/claude-code/-Users-proj/${UUID}/agent/abc/context`,
        "?record=42",
      ),
    ).toBe(`/session/claude-code/${UUID}/agent/abc/context?record=42`);
  });

  it("returns undefined for a current-shape URL or a non-matching path", () => {
    expect(
      legacyClaudeSessionRedirectTarget(`/session/claude-code/${UUID}/evidence`, ""),
    ).toBeUndefined();
    expect(legacyClaudeSessionRedirectTarget("/session/codex/abc/story", "")).toBeUndefined();
  });
});

describe("normalizeLens", () => {
  it("passes through the three current lenses", () => {
    for (const lens of ["story", "orchestration", "evidence"] as const) {
      expect(normalizeLens(lens)).toBe(lens);
    }
  });

  it("maps legacy detail lenses to evidence", () => {
    expect(normalizeLens("context")).toBe("evidence");
    expect(normalizeLens("files")).toBe("evidence");
    expect(normalizeLens("tools")).toBe("evidence");
    expect(normalizeLens("bash")).toBe("evidence");
  });

  it("falls back to story for legacy story lenses, unknown, or missing values", () => {
    expect(normalizeLens("overview")).toBe("story");
    expect(normalizeLens("timeline")).toBe("story");
    expect(normalizeLens("turns")).toBe("story");
    expect(normalizeLens(undefined)).toBe("story");
    expect(normalizeLens("bogus")).toBe("story");
  });
});

describe("normalizeEvidenceSub", () => {
  it("reads a valid evidence sub, defaulting to context", () => {
    expect(normalizeEvidenceSub("files")).toBe("files");
    expect(normalizeEvidenceSub("tools")).toBe("tools");
    expect(normalizeEvidenceSub("context")).toBe("context");
    expect(normalizeEvidenceSub(undefined)).toBe("context");
    expect(normalizeEvidenceSub("bogus")).toBe("context");
  });
});

describe("normalizeToolsSub", () => {
  it("reads all|bash from the third segment, defaulting to all", () => {
    expect(normalizeToolsSub("bash")).toBe("bash");
    expect(normalizeToolsSub("all")).toBe("all");
    expect(normalizeToolsSub(undefined)).toBe("all");
    expect(normalizeToolsSub("bogus")).toBe("all");
  });
});

describe("canonicalLensSuffix", () => {
  it("maps current segments to their canonical trailing path", () => {
    expect(canonicalLensSuffix("story", undefined, undefined)).toBe("");
    expect(canonicalLensSuffix(undefined, undefined, undefined)).toBe("");
    expect(canonicalLensSuffix("orchestration", undefined, undefined)).toBe("orchestration");
    expect(canonicalLensSuffix("evidence", undefined, undefined)).toBe("evidence");
    expect(canonicalLensSuffix("evidence", "files", undefined)).toBe("evidence/files");
    expect(canonicalLensSuffix("evidence", "tools", undefined)).toBe("evidence/tools");
    expect(canonicalLensSuffix("evidence", "tools", "bash")).toBe("evidence/tools/bash");
  });

  it("maps every legacy segment to its new home", () => {
    expect(canonicalLensSuffix("overview", undefined, undefined)).toBe("");
    expect(canonicalLensSuffix("timeline", undefined, undefined)).toBe("");
    expect(canonicalLensSuffix("turns", undefined, undefined)).toBe("");
    expect(canonicalLensSuffix("context", undefined, undefined)).toBe("evidence");
    expect(canonicalLensSuffix("files", undefined, undefined)).toBe("evidence/files");
    expect(canonicalLensSuffix("tools", undefined, undefined)).toBe("evidence/tools");
    expect(canonicalLensSuffix("tools", "bash", undefined)).toBe("evidence/tools/bash");
    expect(canonicalLensSuffix("bash", undefined, undefined)).toBe("evidence/tools/bash");
  });
});

describe("legacySessionLensRedirect — the full old-lens redirect matrix", () => {
  it("redirects every legacy session lens URL to its canonical path", () => {
    expect(legacySessionLensRedirect("overview", undefined, undefined)).toBe("");
    expect(legacySessionLensRedirect("timeline", undefined, undefined)).toBe("");
    expect(legacySessionLensRedirect("turns", undefined, undefined)).toBe("");
    expect(legacySessionLensRedirect("context", undefined, undefined)).toBe("evidence");
    expect(legacySessionLensRedirect("files", undefined, undefined)).toBe("evidence/files");
    expect(legacySessionLensRedirect("tools", undefined, undefined)).toBe("evidence/tools");
    expect(legacySessionLensRedirect("tools", "bash", undefined)).toBe("evidence/tools/bash");
    expect(legacySessionLensRedirect("bash", undefined, undefined)).toBe("evidence/tools/bash");
  });

  it("returns undefined for a current-shape lens (no redirect)", () => {
    expect(legacySessionLensRedirect(undefined, undefined, undefined)).toBeUndefined();
    expect(legacySessionLensRedirect("story", undefined, undefined)).toBeUndefined();
    expect(legacySessionLensRedirect("orchestration", undefined, undefined)).toBeUndefined();
    expect(legacySessionLensRedirect("evidence", "files", undefined)).toBeUndefined();
  });
});

describe("legacyAgentLensRedirect — the agent old-lens matrix", () => {
  it("redirects legacy agent lens URLs (tools/bash have no agent home → Evidence/Context)", () => {
    expect(legacyAgentLensRedirect("overview")).toBe("");
    expect(legacyAgentLensRedirect("timeline")).toBe("");
    expect(legacyAgentLensRedirect("turns")).toBe("");
    expect(legacyAgentLensRedirect("context")).toBe("evidence");
    expect(legacyAgentLensRedirect("files")).toBe("evidence/files");
    expect(legacyAgentLensRedirect("tools")).toBe("evidence");
    expect(legacyAgentLensRedirect("bash")).toBe("evidence");
  });

  it("returns undefined for a current-shape agent lens", () => {
    expect(legacyAgentLensRedirect(undefined)).toBeUndefined();
    expect(legacyAgentLensRedirect("story")).toBeUndefined();
    expect(legacyAgentLensRedirect("orchestration")).toBeUndefined();
    expect(legacyAgentLensRedirect("evidence")).toBeUndefined();
  });
});

describe("parseRecordParam", () => {
  it("parses a bare integer, undefined otherwise", () => {
    expect(parseRecordParam(new URLSearchParams("record=42"))).toBe(42);
    expect(parseRecordParam(new URLSearchParams())).toBeUndefined();
    expect(parseRecordParam(new URLSearchParams("record=abc"))).toBeUndefined();
  });
});

describe("parseRecordAgentParam", () => {
  it("parses a bare agent id, undefined when absent/empty", () => {
    expect(parseRecordAgentParam(new URLSearchParams("record=42&agent=agent-a"))).toBe("agent-a");
    expect(parseRecordAgentParam(new URLSearchParams("record=42"))).toBeUndefined();
    expect(parseRecordAgentParam(new URLSearchParams("record=42&agent="))).toBeUndefined();
  });

  it("round-trips through recordPath's own agent-id encoding", () => {
    const path = recordPath({ source: "claude-code", id: "abc123" }, "evidence", 42, {
      agentId: "sub agent",
      sub: "tools",
    });
    const search = path.slice(path.indexOf("?"));
    expect(parseRecordAgentParam(new URLSearchParams(search))).toBe("sub agent");
  });
});

describe("parseSourceTab", () => {
  it("passes through known tabs and falls back to all", () => {
    expect(parseSourceTab("codex")).toBe("codex");
    expect(parseSourceTab(null)).toBe("all");
    expect(parseSourceTab("bogus")).toBe("all");
  });
});

describe("parseListPage", () => {
  it("passes through a positive page number, else 1", () => {
    expect(parseListPage("7")).toBe(7);
    expect(parseListPage(null)).toBe(1);
    expect(parseListPage("0")).toBe(1);
    expect(parseListPage("-2")).toBe(1);
    expect(parseListPage("1.5")).toBe(1);
  });
});

describe("parseRepoParam", () => {
  it("passes through a repoRoot value and falls back to the all sentinel", () => {
    expect(parseRepoParam("/Users/me/junrei")).toBe("/Users/me/junrei");
    expect(parseRepoParam(null)).toBe(ALL_REPOS);
  });
});

describe("parseDayParam", () => {
  it("passes through a well-formed YYYY-MM-DD, undefined otherwise", () => {
    expect(parseDayParam("2026-07-14")).toBe("2026-07-14");
    expect(parseDayParam(null)).toBeUndefined();
    expect(parseDayParam("2026-7-14")).toBeUndefined();
  });
});

describe("NAV_ITEMS", () => {
  it("lists the three top-level destinations, briefing at the bare root", () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual(["briefing", "sessions", "learnings"]);
    expect(NAV_ITEMS[0]?.path).toBe("/");
    expect(NAV_ITEMS.find((i) => i.key === "sessions")?.path).toBe(`/${SESSIONS_ROUTE_PATH}`);
    expect(NAV_ITEMS.find((i) => i.key === "learnings")?.path).toBe(`/${LEARNINGS_ROUTE_PATH}`);
  });
});

describe("parseBriefingPeriodDays", () => {
  it("passes through a whitelisted period, else the default", () => {
    for (const d of BRIEFING_PERIOD_DAYS) {
      expect(parseBriefingPeriodDays(String(d))).toBe(d);
    }
    expect(parseBriefingPeriodDays(null)).toBe(DEFAULT_BRIEFING_PERIOD_DAYS);
    expect(parseBriefingPeriodDays("14")).toBe(DEFAULT_BRIEFING_PERIOD_DAYS);
  });
});

describe("legacySessionListRedirectTarget", () => {
  it("redirects a legacy list URL (source/page/day) to /sessions, preserving the query", () => {
    expect(legacySessionListRedirectTarget("?source=codex&page=2")).toBe(
      "/sessions?source=codex&page=2",
    );
    expect(legacySessionListRedirectTarget("page=3")).toBe("/sessions?page=3");
  });

  it("returns undefined for a bare or Briefing-only root", () => {
    expect(legacySessionListRedirectTarget("")).toBeUndefined();
    expect(legacySessionListRedirectTarget("?repo=%2FUsers%2Fme%2Fjunrei")).toBeUndefined();
    expect(legacySessionListRedirectTarget("?days=30")).toBeUndefined();
  });
});
