import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendOtelLine, readOtelLines, resolveOtelDir, sanitizeSessionId } from "./otel.js";

describe("resolveOtelDir", () => {
  it("is undefined when JUNREI_OTEL_DIR is unset — the opt-in gate (Decision 7)", () => {
    expect(resolveOtelDir({})).toBeUndefined();
  });

  it("is undefined when JUNREI_OTEL_DIR is blank", () => {
    expect(resolveOtelDir({ JUNREI_OTEL_DIR: "   " })).toBeUndefined();
  });

  it("returns the configured dir, trimmed", () => {
    expect(resolveOtelDir({ JUNREI_OTEL_DIR: "  /tmp/my-otel-dir  " })).toBe("/tmp/my-otel-dir");
  });

  it("has no implicit default (unlike JUNREI_TEMPLATES_DIR) — OTel storage only exists when explicitly configured", () => {
    // No fallback to ~/.junrei/otel or similar — an absent env var must mean
    // "feature off", never "use a default location", per Decision 7's
    // byte-for-byte-when-unset acceptance criterion.
    expect(resolveOtelDir({ HOME: "/Users/someone" })).toBeUndefined();
  });
});

describe("sanitizeSessionId", () => {
  it("passes through a well-formed id unchanged", () => {
    expect(sanitizeSessionId("11111111-1111-1111-1111-111111111111")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSessionId("  sess-1  ")).toBe("sess-1");
  });

  it("rejects (does not mangle) an id containing a forward slash", () => {
    expect(sanitizeSessionId("../../etc/passwd")).toBeUndefined();
    expect(sanitizeSessionId("a/b")).toBeUndefined();
  });

  it("rejects an id containing a backslash", () => {
    expect(sanitizeSessionId("a\\b")).toBeUndefined();
  });

  it("rejects an id containing a NUL byte", () => {
    expect(sanitizeSessionId("a\0b")).toBeUndefined();
  });

  it("rejects blank, '.', and '..'", () => {
    expect(sanitizeSessionId("")).toBeUndefined();
    expect(sanitizeSessionId("   ")).toBeUndefined();
    expect(sanitizeSessionId(".")).toBeUndefined();
    expect(sanitizeSessionId("..")).toBeUndefined();
  });

  it("passes undefined through as undefined", () => {
    expect(sanitizeSessionId(undefined)).toBeUndefined();
  });
});

describe("appendOtelLine / readOtelLines", () => {
  let otelDir: string;

  beforeEach(async () => {
    otelDir = await mkdtemp(join(tmpdir(), "junrei-otel-store-"));
  });

  afterEach(async () => {
    await rm(otelDir, { recursive: true, force: true });
  });

  it("appends a raw OTLP body as one JSONL line under <sessionId>.jsonl", async () => {
    const body = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [] }] };
    await appendOtelLine(otelDir, "sess-1", body);

    const raw = await readFile(join(otelDir, "sess-1.jsonl"), "utf8");
    expect(raw).toBe(`${JSON.stringify(body)}\n`);

    const lines = await readOtelLines(otelDir, "sess-1");
    expect(lines).toEqual([JSON.stringify(body)]);
  });

  it("appends multiple lines for the same session in call order", async () => {
    await appendOtelLine(otelDir, "sess-1", { n: 1 });
    await appendOtelLine(otelDir, "sess-1", { n: 2 });
    const lines = await readOtelLines(otelDir, "sess-1");
    expect(lines).toEqual([JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })]);
  });

  it("routes a record with no session id to _unassigned.jsonl", async () => {
    await appendOtelLine(otelDir, undefined, { orphan: true });
    const files = await readdir(otelDir);
    expect(files).toEqual(["_unassigned.jsonl"]);
    const raw = await readFile(join(otelDir, "_unassigned.jsonl"), "utf8");
    expect(raw).toBe(`${JSON.stringify({ orphan: true })}\n`);
  });

  it("routes a record with a path-unsafe session id to _unassigned.jsonl rather than mangling it into a path", async () => {
    await appendOtelLine(otelDir, "../../etc/passwd", { evil: true });
    const files = await readdir(otelDir);
    expect(files).toEqual(["_unassigned.jsonl"]);
  });

  it("keeps different sessions in separate files", async () => {
    await appendOtelLine(otelDir, "sess-a", { a: 1 });
    await appendOtelLine(otelDir, "sess-b", { b: 1 });
    const files = (await readdir(otelDir)).sort();
    expect(files).toEqual(["sess-a.jsonl", "sess-b.jsonl"]);
  });

  it("creates the dir on first write", async () => {
    const freshDir = join(otelDir, "nested", "does-not-exist-yet");
    await appendOtelLine(freshDir, "sess-1", { ok: true });
    const lines = await readOtelLines(freshDir, "sess-1");
    expect(lines).toEqual([JSON.stringify({ ok: true })]);
  });

  it("readOtelLines returns [] for a session with no stored file", async () => {
    expect(await readOtelLines(otelDir, "never-written")).toEqual([]);
  });

  it("readOtelLines returns [] for a path-unsafe session id rather than reading outside otelDir", async () => {
    expect(await readOtelLines(otelDir, "../../etc/passwd")).toEqual([]);
  });

  it("readOtelLines skips blank lines", async () => {
    await appendOtelLine(otelDir, "sess-1", { n: 1 });
    // Simulate a stray blank line some writer might have left behind.
    await appendOtelLine(otelDir, "sess-1", { n: 2 });
    const lines = await readOtelLines(otelDir, "sess-1");
    expect(lines.every((l) => l.trim() !== "")).toBe(true);
    expect(lines).toHaveLength(2);
  });
});
