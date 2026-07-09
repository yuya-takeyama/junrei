import { describe, expect, it } from "vitest";
import {
  isResultCapped,
  prettyJson,
  rawJson,
  resultSectionLabel,
  TOOL_RESULT_TEXT_CAP,
} from "./recordFormat.js";

describe("prettyJson", () => {
  it("pretty-prints an object with 2-space indent", () => {
    expect(prettyJson({ file_path: "/p/foo.ts", offset: 0 })).toBe(
      '{\n  "file_path": "/p/foo.ts",\n  "offset": 0\n}',
    );
  });

  it("falls back to null for undefined input", () => {
    expect(prettyJson(undefined)).toBe("null");
  });
});

describe("rawJson", () => {
  it("minifies an object with no whitespace", () => {
    expect(rawJson({ file_path: "/p/foo.ts", offset: 0 })).toBe(
      '{"file_path":"/p/foo.ts","offset":0}',
    );
  });

  it("falls back to null for undefined input", () => {
    expect(rawJson(undefined)).toBe("null");
  });
});

describe("isResultCapped", () => {
  it("is false for undefined text", () => {
    expect(isResultCapped(undefined)).toBe(false);
  });

  it("is false when text is shorter than the cap", () => {
    expect(isResultCapped("short result")).toBe(false);
  });

  it("is true when text length hits the parser's capture cap exactly", () => {
    expect(isResultCapped("x".repeat(TOOL_RESULT_TEXT_CAP))).toBe(true);
  });
});

describe("resultSectionLabel", () => {
  it("reports line count and status when text is present", () => {
    expect(resultSectionLabel("Result", "line1\nline2\nline3", "ok")).toBe("Result · 3 lines · ok");
  });

  it("reports a single line for text with no newlines", () => {
    expect(resultSectionLabel("Result", "one line", "ok")).toBe("Result · 1 lines · ok");
  });

  it("reports none-captured when text is undefined", () => {
    expect(resultSectionLabel("Result", undefined)).toBe("Result · none captured");
  });

  it("omits status when not given", () => {
    expect(resultSectionLabel("Returned", "hi")).toBe("Returned · 1 lines");
  });
});
