import { describe, expect, it } from "vitest";
import { REDACTED, redactHeaders, shouldRedactHeader } from "./redact.js";

describe("shouldRedactHeader", () => {
  it("redacts the four named credential headers, case-insensitively", () => {
    for (const name of ["authorization", "Authorization", "X-API-Key", "cookie", "Set-Cookie"]) {
      expect(shouldRedactHeader(name)).toBe(true);
    }
  });

  it("redacts any header whose name contains token or secret", () => {
    for (const name of ["x-session-token", "X-Refresh-Token", "x-client-secret", "MY-SECRET-HDR"]) {
      expect(shouldRedactHeader(name)).toBe(true);
    }
  });

  it("leaves ordinary headers alone", () => {
    for (const name of ["content-type", "user-agent", "x-claude-code-session-id", "request-id"]) {
      expect(shouldRedactHeader(name)).toBe(false);
    }
  });
});

describe("redactHeaders", () => {
  it("replaces credential values with [redacted] and passes others through", () => {
    const out = redactHeaders({
      authorization: "Bearer SUPER_SECRET",
      "x-api-key": "sk-ant-SUPER_SECRET",
      cookie: "session=SUPER_SECRET",
      "x-trace-token": "SUPER_SECRET",
      "content-type": "application/json",
      "x-claude-code-session-id": "sess-123",
    });
    expect(out.authorization).toBe(REDACTED);
    expect(out["x-api-key"]).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out["x-trace-token"]).toBe(REDACTED);
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-claude-code-session-id"]).toBe("sess-123");
  });

  it("does not mutate the input and drops undefined values", () => {
    const input = { authorization: "Bearer X", present: "y", missing: undefined };
    const out = redactHeaders(input);
    expect(input.authorization).toBe("Bearer X"); // untouched
    expect(out).toEqual({ authorization: REDACTED, present: "y" });
    expect("missing" in out).toBe(false);
  });

  it("no credential value survives — a sentinel scan of the serialized output finds nothing", () => {
    const SENTINEL = "SENTINEL_LEAK_9f3c";
    const out = redactHeaders({
      authorization: `Bearer ${SENTINEL}`,
      "x-api-key": SENTINEL,
      cookie: `s=${SENTINEL}`,
      "set-cookie": `s=${SENTINEL}`,
      "x-custom-token": SENTINEL,
      "x-thing-secret": SENTINEL,
    });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });
});
