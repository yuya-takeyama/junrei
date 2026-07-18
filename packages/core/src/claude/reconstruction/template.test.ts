import { describe, expect, it } from "vitest";
import { parseReconstructionTemplate, substituteTemplateText } from "./template.js";

// Synthetic template — invented CLI version, cwd, sessionId, and system text.

const VALID_SYS0 = "You are an agent. cwd=/captured/home/proj id=cap-sess-0000";

const VALID = {
  cliVersion: "9.9.999",
  capturedValues: {
    cwd: "/captured/home/proj",
    sessionId: "cap-sess-0000",
    extra: { scratchpad: "/tmp/cap-501/cap-sess-0000/scratchpad" },
  },
  system: [{ text: VALID_SYS0 }],
  tools: [{ name: "Read" }],
  params: { max_tokens: 32000, stream: true },
};

describe("parseReconstructionTemplate", () => {
  it("accepts a well-formed template", () => {
    expect(parseReconstructionTemplate(VALID)).toEqual(VALID);
  });

  it("rejects a missing cliVersion", () => {
    expect(parseReconstructionTemplate({ ...VALID, cliVersion: 123 })).toBeUndefined();
  });

  it("rejects capturedValues without cwd/sessionId strings", () => {
    expect(
      parseReconstructionTemplate({ ...VALID, capturedValues: { cwd: "/x" } }),
    ).toBeUndefined();
  });

  it("rejects an empty or non-array system section", () => {
    expect(parseReconstructionTemplate({ ...VALID, system: [] })).toBeUndefined();
    expect(parseReconstructionTemplate({ ...VALID, system: [{ text: 1 }] })).toBeUndefined();
  });

  it("omits optional tools/params when absent rather than inventing them", () => {
    const parsed = parseReconstructionTemplate({
      cliVersion: "1.0.0",
      capturedValues: { cwd: "/x", sessionId: "s" },
      system: [{ text: "hi" }],
    });
    expect(parsed).toEqual({
      cliVersion: "1.0.0",
      capturedValues: { cwd: "/x", sessionId: "s" },
      system: [{ text: "hi" }],
    });
  });

  it("returns undefined for non-object input", () => {
    expect(parseReconstructionTemplate(null)).toBeUndefined();
    expect(parseReconstructionTemplate("not json")).toBeUndefined();
  });
});

describe("substituteTemplateText", () => {
  it("substitutes cwd and sessionId with the target session's own values", () => {
    const result = substituteTemplateText(VALID_SYS0, VALID.capturedValues, {
      cwd: "/live/other/proj",
      sessionId: "live-sess-1111",
    });
    expect(result.text).toBe("You are an agent. cwd=/live/other/proj id=live-sess-1111");
    expect(result.substituted.sort()).toEqual(["cwd", "sessionId"]);
    expect(result.unsubstituted).toEqual(["scratchpad"]);
  });

  it("replaces the most specific literal first so a nested value is not corrupted", () => {
    // The scratchpad literal contains the sessionId literal; replacing sessionId
    // first would corrupt the scratchpad path. Most-specific-first prevents that.
    const captured = {
      cwd: "/c",
      sessionId: "sess-abc",
      extra: { scratch: "/tmp/sess-abc/scratchpad" },
    };
    const result = substituteTemplateText("path=/tmp/sess-abc/scratchpad id=sess-abc", captured, {
      cwd: "/c",
      sessionId: "SESS-NEW",
      extra: { scratch: "/tmp/SESS-NEW/scratchpad" },
    });
    expect(result.text).toBe("path=/tmp/SESS-NEW/scratchpad id=SESS-NEW");
    expect(result.substituted.sort()).toEqual(["scratch", "sessionId"]);
  });

  it("reports keys with no target value as unsubstituted, leaving their literals verbatim", () => {
    const captured = {
      cwd: "/captured/home/proj",
      sessionId: "cap-sess-0000",
      extra: { scratchpad: "/tmp/scratch-AAA" },
    };
    const result = substituteTemplateText(
      "cwd=/captured/home/proj scratch=/tmp/scratch-AAA",
      captured,
      { sessionId: "unused-does-not-appear" }, // no cwd, no extra target values
    );
    expect(result.text).toBe("cwd=/captured/home/proj scratch=/tmp/scratch-AAA");
    expect(result.unsubstituted.sort()).toEqual(["cwd", "scratchpad"]);
    expect(result.substituted).toEqual([]);
  });
});
