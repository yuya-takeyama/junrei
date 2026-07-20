import { describe, expect, it } from "vitest";
import { parseRailCollapsed, serializeRailCollapsed } from "./railState.js";

describe("parseRailCollapsed", () => {
  it("treats the exact serialized 'true' as collapsed", () => {
    expect(parseRailCollapsed("true")).toBe(true);
  });

  it("falls back to expanded for missing, corrupt, or unrecognized storage", () => {
    expect(parseRailCollapsed(null)).toBe(false);
    expect(parseRailCollapsed("false")).toBe(false);
    expect(parseRailCollapsed("")).toBe(false);
    expect(parseRailCollapsed("1")).toBe(false);
    expect(parseRailCollapsed("not json")).toBe(false);
  });
});

describe("serializeRailCollapsed", () => {
  it("round-trips both states through parseRailCollapsed", () => {
    expect(parseRailCollapsed(serializeRailCollapsed(true))).toBe(true);
    expect(parseRailCollapsed(serializeRailCollapsed(false))).toBe(false);
  });
});
