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
    // params is now a PER-KEY map, not a single template-confidence section:
    // template keys stay `template`; no section-level confidence when a
    // template supplied params.
    expect(req?.params.entries.max_tokens).toEqual({
      value: 1000,
      confidence: "template",
      provenance: { kind: "template", cliVersion: "9.9.9" },
    });
    expect(req?.params.entries.stream?.confidence).toBe("template");
    // These fixtures carry no template `model` and no log `model` → declared unknown.
    expect(req?.params.entries.model?.confidence).toBe("unknown");
    expect(req?.params.confidence).toBeUndefined();
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

describe("reconstructRequest params model overlay (Defect 1)", () => {
  // A session whose assistant record ran on a DIFFERENT model than the template
  // captured — the log is the source of truth for which model the turn used.
  // `model` defaults to a true-mismatch value so existing call sites keep
  // exercising the override path; alias/equal-value tests pass an explicit one.
  function recordsWithModel(model = "claude-fable-5"): ReconstructionRecord[] {
    return [
      { type: "user", line: 1, content: "hi", version: "9.9.9", timestamp: TS0 },
      {
        type: "assistant",
        line: 2,
        requestId: "req_1",
        messageId: "m1",
        model,
        blocks: [{ type: "text", text: "reply" }],
        timestamp: TS0,
      },
    ];
  }
  function templateProviderWithParamsModel(model: string): ReconstructionTemplateProvider {
    return {
      getTemplate: async (cliVersion) =>
        cliVersion === "9.9.9"
          ? {
              cliVersion: "9.9.9",
              capturedValues: { cwd: "/captured/proj", sessionId: "captured-sess" },
              system: [{ text: "sys" }],
              params: { model, max_tokens: 1000 },
            }
          : undefined,
    };
  }
  const templateWithModel = templateProviderWithParamsModel("claude-haiku-4-5");

  it("overlays the log-recorded model as `exact`, overriding the template default", async () => {
    const records = recordsWithModel();
    const session = deriveReconstructionSessionMeta("sess-1", records);
    const req = await reconstructRequest({ records, session }, "req_1", {
      template: templateWithModel,
    });
    // model: exact, from the target assistant record's own log line (line 2),
    // NOT the template's captured "claude-haiku-4-5".
    expect(req?.params.entries.model?.value).toBe("claude-fable-5");
    expect(req?.params.entries.model?.confidence).toBe("exact");
    expect(req?.params.entries.model?.provenance).toEqual({ kind: "log", lines: [2] });
    // A true mismatch (not an alias/resolved-id pair) — the note says so and
    // flags that the wire literal may itself have been an alias.
    expect(req?.params.entries.model?.note).toContain("overriding");
    expect(req?.params.entries.model?.note).toContain("alias");
    // Non-model template keys stay `template`.
    expect(req?.params.entries.max_tokens).toEqual({
      value: 1000,
      confidence: "template",
      provenance: { kind: "template", cliVersion: "9.9.9" },
    });
    expect(req?.params.confidence).toBeUndefined();
  });

  it("overlays the log model even with NO template (model-only entries, section unknown)", async () => {
    const records = recordsWithModel();
    const session = deriveReconstructionSessionMeta("sess-1", records);
    const req = await reconstructRequest({ records, session }, "req_1");
    expect(req?.params.entries.model?.value).toBe("claude-fable-5");
    expect(req?.params.entries.model?.confidence).toBe("exact");
    // Everything else about params is unrecoverable without a template.
    expect(req?.params.confidence).toBe("unknown");
  });

  it("declares model unknown when neither the log nor a template carries it", async () => {
    const records: ReconstructionRecord[] = [
      { type: "user", line: 1, content: "hi", version: "9.9.9", timestamp: TS0 },
      {
        type: "assistant",
        line: 2,
        requestId: "req_1",
        messageId: "m1",
        blocks: [{ type: "text", text: "reply" }],
      },
    ];
    const session = deriveReconstructionSessionMeta("sess-1", records);
    const req = await reconstructRequest({ records, session }, "req_1");
    expect(req?.params.entries.model?.confidence).toBe("unknown");
    expect(req?.params.entries.model?.provenance).toMatchObject({ kind: "declared-absent" });
    expect(req?.params.entries.model?.value).toBeUndefined();
  });

  it("keeps the template's exact value with `exact` confidence when it already agrees with the log", async () => {
    const records = recordsWithModel("claude-haiku-4-5");
    const session = deriveReconstructionSessionMeta("sess-1", records);
    const req = await reconstructRequest({ records, session }, "req_1", {
      template: templateProviderWithParamsModel("claude-haiku-4-5"),
    });
    expect(req?.params.entries.model?.value).toBe("claude-haiku-4-5");
    expect(req?.params.entries.model?.confidence).toBe("exact");
    expect(req?.params.entries.model?.note).toContain("agrees");
    expect(req?.params.entries.model?.note).not.toContain("overriding");
  });

  it("keeps the template's ALIAS default (confidence `template`) when the log records its resolved form", async () => {
    // Claude Code launched with the alias `claude-haiku-4-5`: the wire body
    // carried that alias, but the log's assistant record carries the CLI's
    // resolved id — overriding the template with the resolved id would be
    // byte-wrong versus the real wire literal, so the template entry is kept.
    const records = recordsWithModel("claude-haiku-4-5-20251001");
    const session = deriveReconstructionSessionMeta("sess-1", records);
    const req = await reconstructRequest({ records, session }, "req_1", {
      template: templateProviderWithParamsModel("claude-haiku-4-5"),
    });
    expect(req?.params.entries.model?.value).toBe("claude-haiku-4-5");
    expect(req?.params.entries.model?.confidence).toBe("template");
    expect(req?.params.entries.model?.note).toContain("log-consistent");
    expect(req?.params.entries.model?.note).toContain("claude-haiku-4-5-20251001");
  });

  it("still overrides for lookalikes that are NOT actually the alias's resolved form", async () => {
    // Only 4 digits after the dash — not an 8-digit date suffix.
    const shortDateRecords = recordsWithModel("claude-haiku-4-5-2025");
    const shortDateSession = deriveReconstructionSessionMeta("sess-1", shortDateRecords);
    const shortDateReq = await reconstructRequest(
      { records: shortDateRecords, session: shortDateSession },
      "req_1",
      { template: templateProviderWithParamsModel("claude-haiku-4-5") },
    );
    expect(shortDateReq?.params.entries.model?.value).toBe("claude-haiku-4-5-2025");
    expect(shortDateReq?.params.entries.model?.confidence).toBe("exact");

    // An extra character before the dash — not the alias itself.
    const extraCharRecords = recordsWithModel("claude-haiku-4-5x-20251001");
    const extraCharSession = deriveReconstructionSessionMeta("sess-1", extraCharRecords);
    const extraCharReq = await reconstructRequest(
      { records: extraCharRecords, session: extraCharSession },
      "req_1",
      { template: templateProviderWithParamsModel("claude-haiku-4-5") },
    );
    expect(extraCharReq?.params.entries.model?.value).toBe("claude-haiku-4-5x-20251001");
    expect(extraCharReq?.params.entries.model?.confidence).toBe("exact");
  });
});

describe("reconstructRequest first-turn array-form prompt (Defect 2)", () => {
  // A first user prompt sent as a BLOCK ARRAY (image + text) rather than a bare
  // string — the shape that previously produced an empty `messages` array.
  it("includes the first user turn when its content is a block array", async () => {
    const records: ReconstructionRecord[] = [
      { type: "queue-operation", line: 1 },
      {
        type: "user",
        line: 2,
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          { type: "text", text: "look at this" },
        ],
        version: "9.9.9",
        timestamp: TS0,
      },
      {
        type: "assistant",
        line: 3,
        requestId: "req_1",
        messageId: "m1",
        model: "claude-fable-5",
        blocks: [{ type: "text", text: "ok" }],
        timestamp: TS0,
      },
    ];
    const session = deriveReconstructionSessionMeta("sess-1", records);
    const req = await reconstructRequest({ records, session }, "req_1");
    // The first request must carry the first user prompt — not an empty array.
    expect(req?.messages.length).toBeGreaterThan(0);
    const first = req?.messages[0];
    expect(first?.role).toBe("user");
    expect(first?.content.map((b) => b.wireType)).toEqual(["image", "text"]);
    expect(first?.content.every((b) => b.confidence === "exact")).toBe(true);
    expect((first?.content[1]?.value as { text: string }).text).toBe("look at this");
    // The image block is preserved verbatim from the log.
    expect(first?.content[0]?.value).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AA==" },
    });
  });
});
