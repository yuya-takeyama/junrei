import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import {
  AGENT_ROUTE_PATH,
  agentPath,
  agentRecordPath,
  normalizeLens,
  parseRecordParam,
  parseSourceTab,
  recordPath,
  SESSION_ROUTE_PATH,
  sessionPath,
} from "./router.js";

describe("sessionPath", () => {
  it("omits the lens segment for overview (default)", () => {
    expect(sessionPath("proj", "abc123")).toBe("/session/proj/abc123");
  });

  it("includes non-overview lens segments", () => {
    expect(sessionPath("proj", "abc123", "timeline")).toBe("/session/proj/abc123/timeline");
  });

  it("percent-encodes project and id", () => {
    expect(sessionPath("a/b", "c d")).toBe("/session/a%2Fb/c%20d");
  });
});

describe("recordPath", () => {
  it("appends a record search param to the session path", () => {
    expect(recordPath("proj", "abc123", "timeline", 42)).toBe(
      "/session/proj/abc123/timeline?record=42",
    );
  });

  it("omits the lens segment for overview but keeps the record param", () => {
    expect(recordPath("proj", "abc123", "overview", 7)).toBe("/session/proj/abc123?record=7");
  });
});

describe("agentPath", () => {
  it("omits the lens segment for overview (default)", () => {
    expect(agentPath("proj", "abc123", "agentA")).toBe("/session/proj/abc123/agent/agentA");
  });

  it("includes non-overview lens segments", () => {
    expect(agentPath("proj", "abc123", "agentA", "timeline")).toBe(
      "/session/proj/abc123/agent/agentA/timeline",
    );
  });

  it("percent-encodes project, id, and agentId", () => {
    expect(agentPath("a/b", "c d", "e f")).toBe("/session/a%2Fb/c%20d/agent/e%20f");
  });
});

describe("agentRecordPath", () => {
  it("appends a record search param to the agent path", () => {
    expect(agentRecordPath("proj", "abc123", "agentA", "timeline", 42)).toBe(
      "/session/proj/abc123/agent/agentA/timeline?record=42",
    );
  });

  it("omits the lens segment for overview but keeps the record param", () => {
    expect(agentRecordPath("proj", "abc123", "agentA", "overview", 7)).toBe(
      "/session/proj/abc123/agent/agentA?record=7",
    );
  });
});

describe("route ranking: AGENT_ROUTE_PATH vs SESSION_ROUTE_PATH", () => {
  // Mirrors main.tsx's actual route registration (order included, to prove the
  // ranking — not the declaration order — is what disambiguates them).
  const routes: RouteObject[] = [
    {
      path: "/",
      children: [
        { index: true, id: "index" },
        { path: AGENT_ROUTE_PATH, id: "agent" },
        { path: SESSION_ROUTE_PATH, id: "session" },
        { path: "*", id: "catchall" },
      ],
    },
  ];

  function matchedRouteId(pathname: string): string | undefined {
    const matches = matchRoutes(routes, pathname);
    return matches?.[matches.length - 1]?.route.id;
  }

  it("matches plain session paths (with or without a lens) to SESSION_ROUTE_PATH", () => {
    expect(matchedRouteId("/session/proj/id")).toBe("session");
    expect(matchedRouteId("/session/proj/id/timeline")).toBe("session");
  });

  it("matches agent paths to AGENT_ROUTE_PATH, not SESSION_ROUTE_PATH with lens='agent'", () => {
    expect(matchedRouteId("/session/proj/id/agent/abc")).toBe("agent");
    expect(matchedRouteId("/session/proj/id/agent/abc/timeline")).toBe("agent");
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
