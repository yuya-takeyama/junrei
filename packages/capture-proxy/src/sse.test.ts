import { describe, expect, it } from "vitest";
import { assembleMessage, parseSse, tryParseJson } from "./sse.js";

const SAMPLE_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-fable-5","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n");

describe("tryParseJson", () => {
  it("parses valid JSON and reports failure for invalid", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(tryParseJson("not json")).toEqual({ ok: false });
  });
});

describe("parseSse", () => {
  it("splits events and JSON-parses each data payload", () => {
    const events = parseSse(SAMPLE_SSE);
    expect(events).toHaveLength(7);
    expect(events[0]?.event).toBe("message_start");
    expect((events[0]?.data as { type: string }).type).toBe("message_start");
  });

  it("accepts CRLF line endings and leaves non-JSON data as a raw string", () => {
    const events = parseSse("event: ping\r\ndata: keepalive\r\n\r\n");
    expect(events).toEqual([{ event: "ping", data: "keepalive" }]);
  });
});

describe("assembleMessage", () => {
  it("reassembles text, model, and merged usage from the stream", () => {
    const message = assembleMessage(parseSse(SAMPLE_SSE));
    expect(message?.model).toBe("claude-fable-5");
    expect((message?.content as Array<{ text: string }>)[0]?.text).toBe("Hello world");
    expect(message?.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(message?.stop_reason).toBe("end_turn");
  });

  it("returns null when there is no message_start", () => {
    expect(assembleMessage(parseSse("event: ping\ndata: keepalive\n\n"))).toBeNull();
  });
});
