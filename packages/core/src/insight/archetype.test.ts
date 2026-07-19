import { describe, expect, it } from "vitest";
import { classifyArchetype, isContextLifetimeWarning } from "./archetype.js";

describe("classifyArchetype", () => {
  it("classifies a marathon at and above the 0.85 boundary", () => {
    expect(classifyArchetype(0.85)).toBe("marathon");
    expect(classifyArchetype(0.9)).toBe("marathon");
    // A zero-subagent session prices main == total → share 1.0 → marathon by
    // construction (main IS ≥85%); the risk that it cost too much rides on
    // contextLifetime.warning, not on the archetype axis.
    expect(classifyArchetype(1)).toBe("marathon");
  });

  it("classifies a fan-out at and below the 0.55 boundary", () => {
    expect(classifyArchetype(0.55)).toBe("fan-out");
    expect(classifyArchetype(0.4)).toBe("fan-out");
    expect(classifyArchetype(0)).toBe("fan-out");
  });

  it("classifies the open interval (0.55, 0.85) as mixed", () => {
    expect(classifyArchetype(0.56)).toBe("mixed");
    expect(classifyArchetype(0.7)).toBe("mixed");
    expect(classifyArchetype(0.849)).toBe("mixed");
  });

  it("reports an unpriced (null) share as mixed — can't be placed on the axis", () => {
    expect(classifyArchetype(null)).toBe("mixed");
  });
});

describe("isContextLifetimeWarning", () => {
  it("fires only above 200K tokens with zero compactions", () => {
    expect(isContextLifetimeWarning(200_001, 0)).toBe(true);
    expect(isContextLifetimeWarning(654_000, 0)).toBe(true);
  });

  it("does not fire exactly at the 200K threshold (strict >)", () => {
    expect(isContextLifetimeWarning(200_000, 0)).toBe(false);
  });

  it("does not fire once any compaction relieved the context", () => {
    expect(isContextLifetimeWarning(500_000, 1)).toBe(false);
  });

  it("does not fire below the threshold regardless of compactions", () => {
    expect(isContextLifetimeWarning(150_000, 0)).toBe(false);
  });
});
