import { describe, expect, it } from "vitest";
import { resolveRepoAgainstRoots } from "./insight.js";

/**
 * Unit tests for the pure repo-key resolution (`resolveRepoAgainstRoots`) —
 * the testable core of `resolveRepoParam`'s bare-name ergonomics fix (PR3).
 * The async `resolveRepoParam` wrapper only adds the `knownRepoRoots()` I/O
 * on top of this pure function, so every resolution rule is exercised here
 * against explicit root arrays.
 */
describe("resolveRepoAgainstRoots", () => {
  const roots = ["/Users/me/junrei", "/Users/me/factorx", "/Users/other/junrei"];

  it("returns no filter for an empty/undefined repo", () => {
    expect(resolveRepoAgainstRoots(undefined, roots)).toEqual({});
    expect(resolveRepoAgainstRoots("", roots)).toEqual({});
  });

  it("passes an absolute repoRoot path through verbatim", () => {
    expect(resolveRepoAgainstRoots("/Users/me/junrei", roots)).toEqual({
      repo: "/Users/me/junrei",
    });
    // Even when it isn't among the known roots — an absolute key is already
    // opaque and unambiguous; it simply matches whatever sessions carry it.
    expect(resolveRepoAgainstRoots("/nowhere/x", [])).toEqual({ repo: "/nowhere/x" });
  });

  it("passes a fallback-bucket key through verbatim (never treated as a bare name)", () => {
    for (const key of [
      "claude-project:-Users-me-proj",
      "codex-repo:git@x",
      "codex-cwd:(unknown cwd)",
    ]) {
      expect(resolveRepoAgainstRoots(key, roots)).toEqual({ repo: key });
    }
  });

  it("resolves a bare name that uniquely matches one root by basename", () => {
    expect(resolveRepoAgainstRoots("factorx", roots)).toEqual({ repo: "/Users/me/factorx" });
  });

  it("returns sorted candidates when a bare name matches several roots", () => {
    expect(resolveRepoAgainstRoots("junrei", roots)).toEqual({
      candidates: ["/Users/me/junrei", "/Users/other/junrei"],
    });
  });

  it("deduplicates identical roots before deciding uniqueness", () => {
    expect(resolveRepoAgainstRoots("junrei", ["/Users/me/junrei", "/Users/me/junrei"])).toEqual({
      repo: "/Users/me/junrei",
    });
  });

  it("passes an unmatched bare name through verbatim (honest empty result, never an error)", () => {
    expect(resolveRepoAgainstRoots("ghost", roots)).toEqual({ repo: "ghost" });
  });
});
