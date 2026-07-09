import { describe, expect, it } from "vitest";
import { normalizeLens, parseRecordParam, recordPath, sessionPath } from "./router.js";

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
