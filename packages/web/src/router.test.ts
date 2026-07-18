import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import {
  ALL_REPOS,
  agentPath,
  agentRecordPath,
  CLAUDE_AGENT_ROUTE_PATH,
  CLAUDE_LENSES,
  CLAUDE_SESSION_ROUTE_PATH,
  CODEX_AGENT_ROUTE_PATH,
  CODEX_LENSES,
  CODEX_SESSION_ROUTE_PATH,
  isLegacyClaudeProjectScopedUrl,
  LENSES_BY_SOURCE,
  legacyClaudeSessionRedirectTarget,
  normalizeLens,
  parseListPage,
  parseRecordParam,
  parseRepoParam,
  parseSourceTab,
  recordPath,
  sessionPath,
  sessionRefOf,
} from "./router.js";

describe("CODEX_LENSES", () => {
  it("offers overview/timeline/orchestration/context/files/bash, in that order", () => {
    expect(CODEX_LENSES).toEqual([
      "overview",
      "timeline",
      "orchestration",
      "context",
      "files",
      "bash",
    ]);
  });

  it("includes 'files', shared with Claude (fileAccess/skillInvocations are SessionAnalysisCore fields)", () => {
    expect(CODEX_LENSES).toContain("timeline");
    expect(CODEX_LENSES).toContain("orchestration");
    expect(CODEX_LENSES).toContain("files");
  });

  it("includes 'bash' — codex/bash-stats.ts (@junrei/core) feeds SessionAnalysisCore.bashStats for Codex sessions too", () => {
    expect(CODEX_LENSES).toContain("bash");
  });
});

describe("CLAUDE_LENSES", () => {
  it("is identical to CODEX_LENSES — both harnesses populate every current lens", () => {
    expect(CLAUDE_LENSES).toEqual([
      "overview",
      "timeline",
      "orchestration",
      "context",
      "files",
      "bash",
    ]);
    expect(CLAUDE_LENSES).toEqual(CODEX_LENSES);
  });
});

describe("LENSES_BY_SOURCE", () => {
  it("gives both sources the 'bash' tab", () => {
    expect(LENSES_BY_SOURCE["claude-code"]).toContain("bash");
    expect(LENSES_BY_SOURCE.codex).toContain("bash");
  });
});

describe("sessionPath", () => {
  it("omits the lens segment for overview (default), Claude source", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" })).toBe(
      "/session/claude-code/abc123",
    );
  });

  it("includes non-overview lens segments, Claude source", () => {
    expect(sessionPath({ source: "claude-code", id: "abc123" }, "timeline")).toBe(
      "/session/claude-code/abc123/timeline",
    );
  });

  it("percent-encodes id, Claude source", () => {
    expect(sessionPath({ source: "claude-code", id: "c d" })).toBe("/session/claude-code/c%20d");
  });

  it("has no :project segment for Codex source", () => {
    expect(sessionPath({ source: "codex", id: "abc123" })).toBe("/session/codex/abc123");
    expect(sessionPath({ source: "codex", id: "abc123" }, "files")).toBe(
      "/session/codex/abc123/files",
    );
  });

  it("percent-encodes id for Codex source", () => {
    expect(sessionPath({ source: "codex", id: "c d" })).toBe("/session/codex/c%20d");
  });
});

describe("sessionRefOf", () => {
  it("builds a Claude ref from sessionId alone (projectDirName is display-only now)", () => {
    expect(sessionRefOf({ source: "claude-code", sessionId: "abc" })).toEqual({
      source: "claude-code",
      id: "abc",
    });
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
    expect(recordPath({ source: "claude-code", id: "abc123" }, "timeline", 42)).toBe(
      "/session/claude-code/abc123/timeline?record=42",
    );
  });

  it("omits the lens segment for overview but keeps the record param, Codex source", () => {
    expect(recordPath({ source: "codex", id: "abc123" }, "overview", 7)).toBe(
      "/session/codex/abc123?record=7",
    );
  });
});

describe("agentPath", () => {
  it("omits the lens segment for overview (default)", () => {
    expect(agentPath({ source: "claude-code", id: "abc123" }, "agentA")).toBe(
      "/session/claude-code/abc123/agent/agentA",
    );
  });

  it("includes non-overview lens segments", () => {
    expect(agentPath({ source: "claude-code", id: "abc123" }, "agentA", "timeline")).toBe(
      "/session/claude-code/abc123/agent/agentA/timeline",
    );
  });

  it("percent-encodes id and agentId", () => {
    expect(agentPath({ source: "claude-code", id: "c d" }, "e f")).toBe(
      "/session/claude-code/c%20d/agent/e%20f",
    );
  });

  it("builds a Codex agent path nested under the parent session", () => {
    expect(agentPath({ source: "codex", id: "abc123" }, "agentA")).toBe(
      "/session/codex/abc123/agent/agentA",
    );
    expect(agentPath({ source: "codex", id: "abc123" }, "agentA", "files")).toBe(
      "/session/codex/abc123/agent/agentA/files",
    );
  });
});

describe("agentRecordPath", () => {
  it("appends a record search param to the agent path", () => {
    expect(agentRecordPath({ source: "claude-code", id: "abc123" }, "agentA", "timeline", 42)).toBe(
      "/session/claude-code/abc123/agent/agentA/timeline?record=42",
    );
  });

  it("omits the lens segment for overview but keeps the record param", () => {
    expect(agentRecordPath({ source: "claude-code", id: "abc123" }, "agentA", "overview", 7)).toBe(
      "/session/claude-code/abc123/agent/agentA?record=7",
    );
  });

  it("builds a Codex agent record path", () => {
    expect(agentRecordPath({ source: "codex", id: "abc123" }, "agentA", "timeline", 42)).toBe(
      "/session/codex/abc123/agent/agentA/timeline?record=42",
    );
  });
});

describe("route ranking: agent routes vs session routes", () => {
  // Mirrors main.tsx's actual route registration (order included, to prove the
  // ranking — not the declaration order — is what disambiguates them).
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
    expect(matchedRouteId("/session/claude-code/id/timeline")).toBe("claude-session");
  });

  it("matches plain Codex session paths (with or without a lens) to CODEX_SESSION_ROUTE_PATH", () => {
    expect(matchedRouteId("/session/codex/id")).toBe("codex-session");
    expect(matchedRouteId("/session/codex/id/turns")).toBe("codex-session");
  });

  it("matches agent paths to CLAUDE_AGENT_ROUTE_PATH, not CLAUDE_SESSION_ROUTE_PATH with lens='agent'", () => {
    expect(matchedRouteId("/session/claude-code/id/agent/abc")).toBe("agent");
    expect(matchedRouteId("/session/claude-code/id/agent/abc/timeline")).toBe("agent");
  });

  it("matches Codex agent paths to CODEX_AGENT_ROUTE_PATH, not CODEX_SESSION_ROUTE_PATH with lens='agent'", () => {
    expect(matchedRouteId("/session/codex/id/agent/abc")).toBe("codex-agent");
    expect(matchedRouteId("/session/codex/id/agent/abc/turns")).toBe("codex-agent");
  });

  it("a legacy 2-segment URL (project/uuid, no lens) still matches CLAUDE_SESSION_ROUTE_PATH — SessionShell redirects it", () => {
    expect(
      matchedRouteId("/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111"),
    ).toBe("claude-session");
  });

  it("a legacy 3-segment URL (project/uuid/lens) falls through to the catch-all", () => {
    expect(
      matchedRouteId(
        "/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111/timeline",
      ),
    ).toBe("catchall");
  });

  it("a legacy agent-drilldown URL (project/uuid/agent/agentId) falls through to the catch-all", () => {
    expect(
      matchedRouteId(
        "/session/claude-code/-Users-proj/11111111-1111-1111-1111-111111111111/agent/abc",
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
    expect(isLegacyClaudeProjectScopedUrl(UUID, "timeline")).toBe(false);
  });

  it("is false when lens is missing or not a UUID", () => {
    expect(isLegacyClaudeProjectScopedUrl("-Users-proj", undefined)).toBe(false);
    expect(isLegacyClaudeProjectScopedUrl("-Users-proj", "timeline")).toBe(false);
  });

  it("is false when id is missing", () => {
    expect(isLegacyClaudeProjectScopedUrl(undefined, UUID)).toBe(false);
  });
});

describe("legacyClaudeSessionRedirectTarget", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("strips the project segment from a legacy URL with an explicit lens", () => {
    expect(
      legacyClaudeSessionRedirectTarget(`/session/claude-code/-Users-proj/${UUID}/timeline`, ""),
    ).toBe(`/session/claude-code/${UUID}/timeline`);
  });

  it("strips the project segment from a legacy agent-drilldown URL", () => {
    expect(
      legacyClaudeSessionRedirectTarget(
        `/session/claude-code/-Users-proj/${UUID}/agent/abc/context`,
        "",
      ),
    ).toBe(`/session/claude-code/${UUID}/agent/abc/context`);
  });

  it("preserves the query string", () => {
    expect(
      legacyClaudeSessionRedirectTarget(
        `/session/claude-code/-Users-proj/${UUID}/timeline`,
        "?record=42",
      ),
    ).toBe(`/session/claude-code/${UUID}/timeline?record=42`);
  });

  it("returns undefined for a current-shape URL (id segment is already a UUID)", () => {
    expect(
      legacyClaudeSessionRedirectTarget(`/session/claude-code/${UUID}/timeline`, ""),
    ).toBeUndefined();
  });

  it("returns undefined for a path that doesn't match the legacy shape at all", () => {
    expect(legacyClaudeSessionRedirectTarget("/session/codex/abc/timeline", "")).toBeUndefined();
    expect(legacyClaudeSessionRedirectTarget("/", "")).toBeUndefined();
  });
});

describe("normalizeLens", () => {
  it("passes through known lenses", () => {
    for (const lens of [
      "overview",
      "timeline",
      "orchestration",
      "context",
      "files",
      "bash",
    ] as const) {
      expect(normalizeLens(lens)).toBe(lens);
    }
  });

  it("passes through 'bash' regardless of source — per-source availability is SessionShell/AgentShell's job (lensAvailable), not normalizeLens's", () => {
    expect(normalizeLens("bash")).toBe("bash");
  });

  it("redirects the removed 'turns' lens to 'timeline' — old Codex Turns-tab bookmarks must not 404 or fall to a broken state", () => {
    expect(normalizeLens("turns")).toBe("timeline");
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

describe("parseListPage", () => {
  it("passes through a positive page number", () => {
    expect(parseListPage("1")).toBe(1);
    expect(parseListPage("7")).toBe(7);
  });

  it("falls back to page 1 for missing, non-numeric, or out-of-range values", () => {
    expect(parseListPage(null)).toBe(1);
    expect(parseListPage("")).toBe(1);
    expect(parseListPage("bogus")).toBe(1);
    expect(parseListPage("0")).toBe(1);
    expect(parseListPage("-2")).toBe(1);
    expect(parseListPage("1.5")).toBe(1);
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
