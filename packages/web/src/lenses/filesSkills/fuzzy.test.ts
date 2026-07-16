import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlightSegments } from "./fuzzy.js";

describe("fuzzyMatch", () => {
  it("matches a subsequence and returns the matched indices, greedy-leftmost", () => {
    expect(fuzzyMatch("FileAccessTree.tsx", "fat")).toEqual([0, 4, 10]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("Foo/Bar.ts", "foobar")).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it("returns undefined when the query isn't a subsequence at all", () => {
    expect(fuzzyMatch("abc", "xyz")).toBeUndefined();
  });

  it("returns undefined when the characters are present but out of order", () => {
    expect(fuzzyMatch("abc", "cab")).toBeUndefined();
  });

  it("treats an empty query as matching everything with zero highlighted indices", () => {
    expect(fuzzyMatch("anything", "")).toEqual([]);
  });

  it("matches the whole string when query equals text", () => {
    expect(fuzzyMatch("abc", "abc")).toEqual([0, 1, 2]);
  });
});

describe("highlightSegments", () => {
  it("splits text into matched/unmatched runs from the indices", () => {
    expect(highlightSegments("abcdef", [1, 2, 4])).toEqual([
      { text: "a", matched: false, start: 0 },
      { text: "bc", matched: true, start: 1 },
      { text: "d", matched: false, start: 3 },
      { text: "e", matched: true, start: 4 },
      { text: "f", matched: false, start: 5 },
    ]);
  });

  it("returns the whole string as one unmatched run when indices is undefined", () => {
    expect(highlightSegments("abc", undefined)).toEqual([
      { text: "abc", matched: false, start: 0 },
    ]);
  });

  it("returns the whole string as one unmatched run when indices is empty", () => {
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", matched: false, start: 0 }]);
  });
});
