import { describe, expect, it } from "vitest";
import { bannerLines, printBanner, usageLine } from "./banner.js";

describe("usageLine", () => {
  it("is the exact ANTHROPIC_BASE_URL line for the given port", () => {
    expect(usageLine(7967)).toBe("ANTHROPIC_BASE_URL=http://localhost:7967 claude");
  });
});

describe("bannerLines", () => {
  const ctx = {
    port: 7967,
    capturesDir: "/home/u/.junrei/captures",
    upstream: "https://api.anthropic.com",
  };
  const text = () => bannerLines(ctx).join("\n");

  it("states the mandatory disclosures", () => {
    const banner = text();
    expect(banner).toContain("INCLUDING PROMPT CONTENTS");
    expect(banner).toContain("never commit or share");
    expect(banner).toContain("REDACTED at write time");
    expect(banner.toLowerCase()).toContain("gray zone");
    expect(banner).toContain("API-KEY usage");
    expect(banner).toContain("Retention is USER-MANAGED");
    expect(banner).toContain("127.0.0.1 only");
  });

  it("includes the exact usage line", () => {
    expect(text()).toContain(usageLine(7967));
  });

  it("prints every line through the provided sink", () => {
    const out: string[] = [];
    printBanner(ctx, (line) => out.push(line));
    expect(out).toEqual(bannerLines(ctx));
  });
});
