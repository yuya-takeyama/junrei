import { describe, expect, it } from "vitest";
import { classifyModel, MODEL_CLASS_ORDER, modelShortLabel } from "./modelClass.js";

describe("classifyModel", () => {
  it("keeps the Claude three-tier mapping", () => {
    expect(classifyModel("claude-fable-5")).toBe("f");
    expect(classifyModel("claude-opus-4-8")).toBe("f");
    expect(classifyModel("claude-sonnet-4-5-20250929")).toBe("s");
    expect(classifyModel("claude-haiku-4-5")).toBe("h");
  });

  it("gives each GPT-5.6 codename its own accent", () => {
    expect(classifyModel("gpt-5.6-sol")).toBe("sol");
    expect(classifyModel("gpt-5.6-terra")).toBe("terra");
    expect(classifyModel("gpt-5.6-luna")).toBe("luna");
  });

  it("separates the Codex auto-reviewer from the generic gpt bucket", () => {
    expect(classifyModel("codex-auto-review")).toBe("rev");
    expect(classifyModel("gpt-5.3-codex")).toBe("gpt");
    expect(classifyModel("gpt-5.5")).toBe("gpt");
    expect(classifyModel("gpt-5.4-mini")).toBe("gpt");
  });

  it("matches codenames only on id-segment boundaries", () => {
    // "sol" must not fire inside another word (e.g. Upstage's solar models).
    expect(classifyModel("solar-pro")).toBe("mut");
    expect(classifyModel("terraform-helper")).toBe("mut");
  });

  it("falls back to mut for unknown vendors", () => {
    expect(classifyModel("kimi-k2.6-preview")).toBe("mut");
    expect(classifyModel("<synthetic>")).toBe("mut");
  });
});

describe("modelShortLabel", () => {
  it("combines the family codename with the version", () => {
    expect(modelShortLabel("claude-fable-5")).toBe("fable 5");
    expect(modelShortLabel("claude-opus-4-8")).toBe("opus 4.8");
    expect(modelShortLabel("claude-sonnet-4-5-20250929")).toBe("sonnet 4.5");
    expect(modelShortLabel("claude-haiku-4-5")).toBe("haiku 4.5");
    expect(modelShortLabel("gpt-5.6-sol")).toBe("5.6 sol");
    expect(modelShortLabel("gpt-5.6-terra")).toBe("5.6 terra");
    expect(modelShortLabel("gpt-5.6-luna")).toBe("5.6 luna");
    expect(modelShortLabel("codex-auto-review")).toBe("auto-review");
  });

  it("reads legacy version-first Claude ids and ignores snapshot dates", () => {
    expect(modelShortLabel("claude-3-7-sonnet-20250219")).toBe("sonnet 3.7");
    expect(modelShortLabel("claude-3-opus-20240229")).toBe("opus 3");
    expect(modelShortLabel("claude-opus-4-20250514")).toBe("opus 4");
    expect(modelShortLabel("claude-4.5-haiku")).toBe("haiku 4.5");
  });

  it("derives versioned GPT labels from the id, stripping vendor suffixes", () => {
    expect(modelShortLabel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(modelShortLabel("gpt-5.5-2026-04-23")).toBe("gpt-5.5");
    expect(modelShortLabel("gpt-5.1-chat-latest")).toBe("gpt-5.1-chat");
  });

  it("returns unknown ids unchanged", () => {
    expect(modelShortLabel("kimi-k2.6-preview")).toBe("kimi-k2.6-preview");
  });
});

describe("MODEL_CLASS_ORDER", () => {
  it("covers every accent exactly once, mut last", () => {
    expect(new Set(MODEL_CLASS_ORDER).size).toBe(MODEL_CLASS_ORDER.length);
    expect(MODEL_CLASS_ORDER.at(-1)).toBe("mut");
    expect(MODEL_CLASS_ORDER).toContain("sol");
    expect(MODEL_CLASS_ORDER).toContain("gpt");
  });
});
