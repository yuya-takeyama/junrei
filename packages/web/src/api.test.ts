import { describe, expect, it } from "vitest";
import type { CodexSessionJson, CodexSessionResponseBody } from "./api.js";
import { unwrapCodexSessionResponse } from "./api.js";

// Minimal stand-in for a real `CodexSessionAnalysis` — `unwrapCodexSessionResponse`
// only ever inspects the envelope shape (`"analysis" in body`), never the
// analysis's own fields, so a partial cast fixture is enough here.
const analysis = { sessionId: "codex-1", source: "codex" } as unknown as CodexSessionJson;

describe("unwrapCodexSessionResponse", () => {
  it("unwraps the { analysis } envelope GET /api/sessions/codex/:id returns on success", () => {
    const body: CodexSessionResponseBody = { analysis };
    expect(unwrapCodexSessionResponse(body)).toBe(analysis);
  });

  it("returns undefined for the { error } envelope (defense in depth — callers already gate on res.ok)", () => {
    const body: CodexSessionResponseBody = { error: "session not found" };
    expect(unwrapCodexSessionResponse(body)).toBeUndefined();
  });
});
