import { describe, expect, it } from "vitest";
import { renderAgentListingBlock, renderSkillListingBlock } from "./attachments.js";

// All content here is fully synthetic — invented agent/skill names, never copied
// from any real capture. Only the fixed wrapper literals are load-bearing.

describe("renderAgentListingBlock", () => {
  it("wraps the attachment's addedLines byte-exactly", () => {
    const text = renderAgentListingBlock([
      "- alpha: does alpha things (Tools: *)",
      "- beta: does beta things (Tools: Read)",
    ]);
    expect(text).toBe(
      "<system-reminder>\n" +
        "Available agent types for the Agent tool:\n" +
        "- alpha: does alpha things (Tools: *)\n" +
        "- beta: does beta things (Tools: Read)\n" +
        "\n" +
        "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.\n" +
        "</system-reminder>",
    );
  });
});

describe("renderSkillListingBlock", () => {
  it("wraps the attachment's content byte-exactly, including the trailing newline", () => {
    const text = renderSkillListingBlock(
      "- widget-maker: builds widgets\n- report-writer: writes reports",
    );
    expect(text).toBe(
      "<system-reminder>\n" +
        "The following skills are available for use with the Skill tool:\n" +
        "\n" +
        "- widget-maker: builds widgets\n- report-writer: writes reports\n" +
        "</system-reminder>\n",
    );
  });
});
