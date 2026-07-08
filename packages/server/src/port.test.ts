import net from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, resolvePort } from "./port.js";

describe("resolvePort", () => {
  it("uses JUNREI_PORT when set", async () => {
    expect(await resolvePort({ JUNREI_PORT: "8123" })).toBe(8123);
  });

  it("rejects an invalid JUNREI_PORT", async () => {
    await expect(resolvePort({ JUNREI_PORT: "not-a-port" })).rejects.toThrow(/Invalid JUNREI_PORT/);
  });

  it("falls back to the default port when free, or 0 when taken", async () => {
    const blocker = net.createServer();
    const resolved = await resolvePort({});
    if (resolved === DEFAULT_PORT) {
      // Default was free; occupying it must force the ephemeral fallback.
      await new Promise<void>((resolve) => blocker.listen(DEFAULT_PORT, "127.0.0.1", resolve));
      expect(await resolvePort({})).toBe(0);
    } else {
      expect(resolved).toBe(0);
    }
    blocker.close();
  });
});
