import { describe, expect, it } from "vitest";
import type { CodexSessionJson } from "./api.js";
import { unwrapSessionResponse } from "./api.js";

// Minimal stand-in for a real analysis — `unwrapSessionResponse` only ever
// inspects the envelope shape (`"analysis" in body`), never the analysis's
// own fields, so a partial cast fixture is enough here.
const analysis = { sessionId: "codex-1", source: "codex" } as unknown as CodexSessionJson;

describe("unwrapSessionResponse", () => {
  it("unwraps the shared { analysis, lastActivityAt } envelope, merging lastActivityAt onto the session", () => {
    const result = unwrapSessionResponse({ analysis, lastActivityAt: "2026-07-13T00:00:00.000Z" });
    expect(result).toEqual({ ...analysis, lastActivityAt: "2026-07-13T00:00:00.000Z" });
  });

  it("carries lastActivityAt through as undefined when the server couldn't stat the file", () => {
    const result = unwrapSessionResponse({ analysis, lastActivityAt: undefined });
    expect(result?.lastActivityAt).toBeUndefined();
  });

  it("returns undefined for the { error } envelope (defense in depth — callers already gate on res.ok)", () => {
    expect(unwrapSessionResponse({ error: "session not found" })).toBeUndefined();
  });
});
