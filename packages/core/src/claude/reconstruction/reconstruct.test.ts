import { describe, expect, it } from "vitest";
import {
  deriveReconstructionSessionMeta,
  listReconstructableRequests,
  reconstructRequest,
} from "./reconstruct.js";
import type {
  DiskContextProvider,
  ReconstructionRecord,
  ReconstructionTemplate,
  ReconstructionTemplateProvider,
} from "./types.js";

// All fixtures synthetic — invented prompts, ids, template text, and disk paths.

const TS0 = "2026-07-18T00:00:00.000Z";
const SESSION_START = Date.parse(TS0);

/** A session with agent/skill injections before the first turn, and two requests. */
function richRecords(): ReconstructionRecord[] {
  return [
    {
      type: "user",
      line: 1,
      content: "start",
      cwd: "/live/proj",
      version: "9.9.9",
      timestamp: TS0,
    },
    {
      type: "attachment",
      line: 2,
      attachment: { type: "agent_listing_delta", addedLines: ["- a: x"] },
    },
    { type: "attachment", line: 3, attachment: { type: "skill_listing", content: "- s: y" } },
    {
      type: "assistant",
      line: 4,
      requestId: "req_1",
      messageId: "m1",
      blocks: [{ type: "text", text: "reply" }],
    },
    { type: "user", line: 5, content: "next" },
    {
      type: "assistant",
      line: 6,
      requestId: "req_2",
      messageId: "m2",
      blocks: [{ type: "text", text: "reply2" }],
      timestamp: "2026-07-18T00:00:05.000Z",
    },
  ];
}

const TEMPLATE: ReconstructionTemplate = {
  cliVersion: "9.9.9",
  capturedValues: { cwd: "/captured/proj", sessionId: "captured-sess" },
  system: [{ text: "You are Claude. cwd=/captured/proj sid=captured-sess" }],
  tools: [{ name: "Read" }],
  params: { max_tokens: 1000, stream: true },
};

const templateProvider: ReconstructionTemplateProvider = {
  getTemplate: async (cliVersion) => (cliVersion === "9.9.9" ? TEMPLATE : undefined),
};

function diskProvider(mtimeMs: number): DiskContextProvider {
  return {
    getDiskContext: async () => ({
      globalClaudeMd: { path: "/home/.claude/CLAUDE.md", content: "# g\n", mtimeMs },
      email: "u@e.test",
      emailMtimeMs: mtimeMs,
    }),
  };
}

describe("listReconstructableRequests", () => {
  it("lists requestId + target line + ordinal for each request", () => {
    const refs = listReconstructableRequests(richRecords());
    expect(refs).toEqual([
      { ordinal: 0, targetLine: 4, requestId: "req_1" },
      { ordinal: 1, targetLine: 6, requestId: "req_2" },
    ]);
  });

  it("falls back to ordinal identity when records carry no requestId", () => {
    const records: ReconstructionRecord[] = [
      { type: "user", line: 1, content: "p" },
      { type: "assistant", line: 2, messageId: "m1", blocks: [{ type: "text", text: "a" }] },
    ];
    expect(listReconstructableRequests(records)).toEqual([{ ordinal: 0, targetLine: 2 }]);
  });
});

describe("reconstructRequest lookup", () => {
  const records = richRecords();
  const session = deriveReconstructionSessionMeta("sess-1", records);

  it("resolves by requestId and by target line to the same request", async () => {
    const byId = await reconstructRequest({ records, session }, "req_2");
    const byLine = await reconstructRequest({ records, session }, 6);
    expect(byId?.ordinal).toBe(1);
    expect(byId?.requestId).toBe("req_2");
    expect(byId?.targetLine).toBe(6);
    expect(byLine).toEqual(byId);
  });

  it("returns undefined for an unknown request", async () => {
    expect(await reconstructRequest({ records, session }, "nope")).toBeUndefined();
    expect(await reconstructRequest({ records, session }, 999)).toBeUndefined();
  });

  it("reconstructs the history up to (not including) the target response", async () => {
    const req = await reconstructRequest({ records, session }, "req_2");
    // History for req_2: [start turn], [assistant reply], [next] — 3 messages.
    expect(req?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // First user turn carries the injected reminders then the prompt.
    expect(req?.messages[0]?.content.map((b) => b.confidence)).toEqual([
      "exact", // agent listing
      "exact", // skill listing
      "unknown", // disk-contingent block, no disk provider here → declared unknown
      "exact", // the prompt itself (content-form)
    ]);
  });
});

describe("reconstructRequest labelling", () => {
  const records = richRecords();
  const session = deriveReconstructionSessionMeta("sess-1", records);

  it("labels the template sections and declares the billing-header + subagent gaps", async () => {
    const req = await reconstructRequest({ records, session }, "req_2", {
      template: templateProvider,
    });
    // System: substituted template block + a declared-unknown billing header.
    expect(req?.system[0]?.confidence).toBe("template");
    expect(req?.system[0]?.text).toBe("You are Claude. cwd=/live/proj sid=sess-1");
    expect(req?.system.at(-1)?.confidence).toBe("unknown");
    expect(req?.tools).toEqual({
      value: [{ name: "Read" }],
      confidence: "template",
      provenance: { kind: "template", cliVersion: "9.9.9" },
    });
    expect(req?.params.confidence).toBe("template");
    expect(req?.limitations).toContain(
      "subagent (sidechain) requests are not supported: reconstruction covers main-loop requests only",
    );
    expect(req?.limitations.some((l) => l.includes("billing-header"))).toBe(true);
    expect(req?.appliedRules).toEqual(["cache-control-strip", "content-form"]);
  });

  it("degrades system/tools/params to unknown when no template matches the CLI version", async () => {
    const req = await reconstructRequest({ records, session }, "req_2", {
      template: { getTemplate: async () => undefined },
    });
    expect(req?.system.every((b) => b.confidence === "unknown")).toBe(true);
    expect(req?.tools.confidence).toBe("unknown");
    expect(req?.params.confidence).toBe("unknown");
    expect(req?.limitations.some((l) => l.includes("no reconstruction template"))).toBe(true);
  });

  it("rebuilds the disk-contingent reminder and reports NO drift for a file older than the session", async () => {
    const req = await reconstructRequest({ records, session }, "req_2", {
      diskContext: diskProvider(SESSION_START - 60_000),
    });
    const diskBlock = req?.messages[0]?.content[2];
    expect(diskBlock?.confidence).toBe("disk-contingent");
    expect(diskBlock?.provenance).toMatchObject({ kind: "disk", driftDetected: false });
    expect((diskBlock?.value as { text: string }).text).toContain("# claudeMd");
    expect((diskBlock?.value as { text: string }).text).toContain("Today's date is 2026-07-18.");
  });

  it("reports drift when a contributing file was modified after the session started", async () => {
    const req = await reconstructRequest({ records, session }, "req_2", {
      diskContext: diskProvider(SESSION_START + 60_000),
    });
    const diskBlock = req?.messages[0]?.content[2];
    expect(diskBlock?.confidence).toBe("disk-contingent");
    expect(diskBlock?.provenance).toMatchObject({ kind: "disk", driftDetected: true });
    expect(diskBlock?.note).toContain("may have drifted");
  });

  it("declares the disk block unknown when no disk-context provider is supplied", async () => {
    const req = await reconstructRequest({ records, session }, "req_2");
    const diskBlock = req?.messages[0]?.content[2];
    expect(diskBlock?.confidence).toBe("unknown");
    expect(diskBlock?.provenance).toMatchObject({ kind: "declared-absent" });
    expect(req?.limitations.some((l) => l.includes("disk-context provider"))).toBe(true);
  });
});
