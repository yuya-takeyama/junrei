import { describe, expect, it } from "vitest";
import { flattenToSearchText } from "./search.js";

describe("flattenToSearchText", () => {
  it("emits decoded values only — no key names, joined by newlines", () => {
    const text = flattenToSearchText({
      command: "aqua i -l",
      nested: { flag: true, count: 3 },
      list: ["a", "b"],
    });
    expect(text).toBe("aqua i -l\ntrue\n3\na\nb");
    expect(text).not.toContain("command");
  });

  it("handles bare strings and skips null/undefined", () => {
    expect(flattenToSearchText("plain")).toBe("plain");
    expect(flattenToSearchText({ a: null, b: undefined })).toBe("");
  });
});
