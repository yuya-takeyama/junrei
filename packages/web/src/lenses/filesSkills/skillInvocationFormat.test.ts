import { describe, expect, it } from "vitest";
import { formatInjectedSize } from "./skillInvocationFormat.js";

describe("formatInjectedSize", () => {
  it("formats a k-scale char count with the 'loaded' suffix", () => {
    expect(formatInjectedSize(5566)).toBe("5.6k chars loaded");
  });

  it("formats a sub-1000 char count without scaling", () => {
    expect(formatInjectedSize(188)).toBe("188 chars loaded");
  });

  it("returns undefined when no injection record was matched (never fall back to the ACK size)", () => {
    expect(formatInjectedSize(undefined)).toBeUndefined();
  });
});
