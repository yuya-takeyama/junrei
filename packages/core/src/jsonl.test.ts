import { describe, expect, it } from "vitest";
import { parseJsonlLine } from "./jsonl.js";

describe("parseJsonlLine", () => {
  it("parses a valid JSON object line", () => {
    expect(parseJsonlLine('{"type":"user","uuid":"abc"}')).toEqual({
      type: "user",
      uuid: "abc",
    });
  });

  it("returns null for empty lines", () => {
    expect(parseJsonlLine("")).toBeNull();
    expect(parseJsonlLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseJsonlLine('{"type":"user",')).toBeNull();
  });
});
