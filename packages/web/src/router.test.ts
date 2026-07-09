import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import {
  AGENT_ROUTE_PATH,
  ALL_REPOS,
  agentPath,
  agentRecordPath,
  CLAUDE_LENSES,
  CLAUDE_SESSION_ROUTE_PATH,
  CODEX_LENSES,
  CODEX_SESSION_ROUTE_PATH,
  normalizeLens,
  parseRecordParam,
  parseRepoParam,
  parseSourceTab,
  recordPath,
  sessionPath,
  sessionRefOf,
} from "./router.js";

describe("CODEX_LENSES", () => {
  it("offers overview/timeline/orchestration/context/files/turns, in that order — Claude's tab order plus Codex-only 'turns' appended last", () => {
    expect(CODEX_LENSES).toEqual([
      "overview",
      "timeline",
      "orchestration",
      "context",
      "files",
      "turns",
    ]);
  });

  it("includes 'files', now shared with Claude (fileAccess/skillInvocations are SessionAnalysisCore fields)", () => {
    expect(CODEX_LENSES).toContain("timeline");
    expect(CODEX_LENSES).toContain("orchestration");
    expect(CODEX_LENSES).toContain("files");
  });
});

describe("CLAUDE_LENSES", () => {
  it("is unchanged by the Codex timeline addition", () => {
    expect(CLAUDE_LENSES).toEqual(["overview", "timeline", "orchestration", "context", "files"]);
  });
});

describe("sessionPath", () => {
  it("omits the lens segment for overview (default), Claude source", () => {
    expect(sessionPath({ source: "claude-code", project: "proj", id: "abc123" })).toBe(
      "/session/claude-code/proj/abc123",
    );
  });

  it("includes non-overview lens segments, Claude source", () => {
    expect(sessionPath({ source: "claude-code", project: "proj", id: "abc123" }, "timeline")).toBe(
      "/session/claude-code/proj/abc123/timeline",
    );
  });

  it("percent-encodes project and id, Claude source", () => {
    expect(sessionPath({ source: "claude-code", project: "a/b", id: "c d" })).toBe(
      "/session/claude-code/a%2Fb/c%20d",
    );
  });

  it("has no :project segment for Codex source", () => {
    expect(sessionPath({ source: "codex", id: "abc123" })).toBe("/session/codex/abc123");
    expect(sessionPath({ source: "codex", id: "abc123" }, "turns")).toBe(
      "/session/codex/abc123/turns",
    );
  });

  it("percent-encodes id for Codex source", () => {
    expect(sessionPath({ source: "codex", id: "c d" })).toBe("/session/codex/c%20d");
  });
});

describe("sessionRefOf", () => {
  it("builds a Claude ref from projectDirName/sessionId", () => {
    expect(
      sessionRefOf({ source: "claude-code", projectDirName: "-Users-proj", sessionId: "abc" }),
    ).toEqual({ source: "claude-code", project: "-Users-proj", id: "abc" });
  });

  it("builds a Codex ref from sessionId alone (no projectDirName)", () => {
    expect(sessionRefOf({ source: "codex", sessionId: "abc" })).toEqual({
      source: "codex",
      id: "abc",
    });
  });
});

describe("recordPath", () => {
  it("appends a record search param to the session path, Claude source", () => {
    expect(
      recordPath({ source: "claude-code", project: "proj", id: "abc123" }, "timeline", 42),
    ).toBe("/session/claude-code/proj/abc123/timeline?record=42");
  });

  it("omits the lens segment for overview but keeps the record param, Codex source", () => {
    expect(recordPath({ source: "codex", id: "abc123" }, "overview", 7)).toBe(
      "/session/codex/abc123?record=7",
    );
  });
});

describe("agentPath", () => {
  it("omits the lens segment for overview (default)", () => {
    expect(agentPath("proj", "abc123", "agentA")).toBe(
      "/session/claude-code/proj/abc123/agent/agentA",
    );
  });

  it("includes non-overview lens segments", () => {
    expect(agentPath("proj", "abc123", "agentA", "timeline")).toBe(
      "/session/claude-code/proj/abc123/agent/agentA/timeline",
    );
  });

  it("percent-encodes project, id, and agentId", () => {
    expect(agentPath("a/b", "c d", "e f")).toBe("/session/claude-code/a%2Fb/c%20d/agent/e%20f");
  });
});

describe("agentRecordPath", () => {
  it("appends a record search param to the agent path", () => {
    expect(agentRecordPath("proj", "abc123", "agentA", "timeline", 42)).toBe(
      "/session/claude-code/proj/abc123/agent/agentA/timeline?record=42",
    );
  });

  it("omits the lens segment for overview but keeps the record param", () => {
    expect(agentRecordPath("proj", "abc123", "agentA", "overview", 7)).toBe(
      "/session/claude-code/proj/abc123/agent/agentA?record=7",
    );
  });
});

describe("route ranking: AGENT_ROUTE_PATH vs CLAUDE_SESSION_ROUTE_PATH", () => {
  // Mirrors main.tsx's actual route registration (order included, to prove the
  // ranking — not the declaration order — is what disambiguates them).
  const routes: RouteObject[] = [
    {
      path: "/",
      children: [
        { index: true, id: "index" },
        { path: AGENT_ROUTE_PATH, id: "agent" },
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
    expect(matchedRouteId("/session/claude-code/proj/id")).toBe("claude-session");
    expect(matchedRouteId("/session/claude-code/proj/id/timeline")).toBe("claude-session");
  });

  it("matches plain Codex session paths (with or without a lens) to CODEX_SESSION_ROUTE_PATH", () => {
    expect(matchedRouteId("/session/codex/id")).toBe("codex-session");
    expect(matchedRouteId("/session/codex/id/turns")).toBe("codex-session");
  });

  it("matches agent paths to AGENT_ROUTE_PATH, not CLAUDE_SESSION_ROUTE_PATH with lens='agent'", () => {
    expect(matchedRouteId("/session/claude-code/proj/id/agent/abc")).toBe("agent");
    expect(matchedRouteId("/session/claude-code/proj/id/agent/abc/timeline")).toBe("agent");
  });
});

describe("normalizeLens", () => {
  it("passes through known lenses", () => {
    for (const lens of ["overview", "timeline", "orchestration", "context", "files"] as const) {
      expect(normalizeLens(lens)).toBe(lens);
    }
  });

  it("falls back to overview for unknown or missing values", () => {
    expect(normalizeLens(undefined)).toBe("overview");
    expect(normalizeLens("bogus")).toBe("overview");
  });
});

describe("parseRecordParam", () => {
  it("parses a bare integer", () => {
    expect(parseRecordParam(new URLSearchParams("record=42"))).toBe(42);
  });

  it("returns undefined when the param is absent or non-numeric", () => {
    expect(parseRecordParam(new URLSearchParams())).toBeUndefined();
    expect(parseRecordParam(new URLSearchParams("record=abc"))).toBeUndefined();
  });
});

describe("parseSourceTab", () => {
  it("passes through known source tabs", () => {
    expect(parseSourceTab("all")).toBe("all");
    expect(parseSourceTab("claude-code")).toBe("claude-code");
    expect(parseSourceTab("codex")).toBe("codex");
  });

  it("falls back to 'all' for missing or unrecognized values", () => {
    expect(parseSourceTab(null)).toBe("all");
    expect(parseSourceTab("bogus")).toBe("all");
  });

  it("round-trips through a URLSearchParams the way the session-list URL does", () => {
    const params = new URLSearchParams();
    params.set("source", "codex");
    expect(parseSourceTab(params.get("source"))).toBe("codex");

    // The "All" tab omits the param entirely (see SessionList's tab click handler).
    params.delete("source");
    expect(parseSourceTab(params.get("source"))).toBe("all");
  });
});

describe("parseRepoParam", () => {
  it("passes through a repoRoot value unchanged", () => {
    expect(parseRepoParam("/Users/me/junrei")).toBe("/Users/me/junrei");
  });

  it("falls back to the 'all' sentinel for a missing value", () => {
    expect(parseRepoParam(null)).toBe(ALL_REPOS);
  });

  it("round-trips through a URLSearchParams the way the session-list URL does", () => {
    const params = new URLSearchParams();
    params.set("repo", "/Users/me/junrei");
    expect(parseRepoParam(params.get("repo"))).toBe("/Users/me/junrei");

    // The "all repos" choice omits the param entirely (see SessionList's select handler).
    params.delete("repo");
    expect(parseRepoParam(params.get("repo"))).toBe(ALL_REPOS);
  });

  it("percent-decodes a repoRoot containing reserved URL characters", () => {
    const params = new URLSearchParams();
    params.set("repo", "/Users/me/repo with spaces");
    const url = `?${params.toString()}`;
    expect(parseRepoParam(new URLSearchParams(url).get("repo"))).toBe("/Users/me/repo with spaces");
  });
});
