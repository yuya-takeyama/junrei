import { describe, expect, it } from "vitest";
import {
  applyCacheControlStrip,
  applyCallerStrip,
  applyContentForm,
  applyThinkingDrop,
} from "./rules.js";

describe("content-form", () => {
  it("wraps a bare string into the wire's single-text-block array form", () => {
    expect(applyContentForm("do the thing")).toEqual([{ type: "text", text: "do the thing" }]);
  });

  it("is idempotent on content already in array form", () => {
    const blocks = [{ type: "text", text: "already an array" }];
    expect(applyContentForm(blocks)).toBe(blocks);
  });
});

describe("cache-control-strip", () => {
  it("drops the wire-only cache_control key and reports it applied", () => {
    const result = applyCacheControlStrip({
      type: "text",
      text: "hi",
      cache_control: { type: "ephemeral" },
    });
    expect(result).toEqual({ block: { type: "text", text: "hi" }, applied: true });
  });

  it("leaves a block without cache_control untouched (applied: false)", () => {
    const block = { type: "text", text: "hi" };
    const result = applyCacheControlStrip(block);
    expect(result.applied).toBe(false);
    expect(result.block).toEqual(block);
  });

  it("passes non-object values through unchanged", () => {
    expect(applyCacheControlStrip("scalar")).toEqual({ block: "scalar", applied: false });
  });
});

describe("caller-strip", () => {
  it("drops the log-only caller key on a tool_use block and reports it applied", () => {
    const result = applyCallerStrip({
      type: "tool_use",
      id: "toolu_1",
      name: "Read",
      input: { path: "/x" },
      caller: "harness",
    });
    expect(result).toEqual({
      block: { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/x" } },
      applied: true,
    });
  });

  it("leaves a tool_use without caller untouched (applied: false)", () => {
    const block = { type: "tool_use", id: "toolu_1", name: "Read", input: {} };
    expect(applyCallerStrip(block)).toEqual({ block, applied: false });
  });
});

describe("thinking-drop", () => {
  it("drops thinking blocks from replayed assistant history", () => {
    const result = applyThinkingDrop([
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "t1" },
    ]);
    expect(result.applied).toBe(true);
    expect(result.blocks).toEqual([
      { type: "text", text: "answer" },
      { type: "tool_use", id: "t1" },
    ]);
  });

  it("reports applied: false when there is no thinking block", () => {
    const blocks = [{ type: "text", text: "answer" }];
    const result = applyThinkingDrop(blocks);
    expect(result.applied).toBe(false);
    expect(result.blocks).toEqual(blocks);
  });
});
