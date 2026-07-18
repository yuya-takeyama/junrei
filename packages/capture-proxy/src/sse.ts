/**
 * Server-Sent-Events handling, ported verbatim in behavior from the validated
 * experiment (`experiments/claude-code-capture/capture-proxy.mjs`). The proxy
 * streams SSE bytes through to the client UNCHANGED; these helpers run only on
 * the STORED copy, turning the buffered raw event stream into a parsed event
 * list and a reassembled final message so the read side can pull `model`/
 * `usage` without re-implementing the SDK's stream assembly.
 */

export interface SseEvent {
  event: string;
  /** JSON-parsed when the `data:` payload parsed, else the raw string. */
  data: unknown;
}

/** Parse JSON, reporting success so callers can fall back to the raw string. */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse a raw SSE byte stream into a list of `{event, data}` entries. `data`
 * is JSON-parsed when possible, otherwise left as the raw string. CRLF and LF
 * line endings are both accepted; blank blocks and data-less events are
 * dropped.
 */
export function parseSse(rawText: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = rawText.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join("\n");
    const parsed = tryParseJson(rawData);
    events.push({ event: eventName, data: parsed.ok ? parsed.value : rawData });
  }
  return events;
}

/** Anthropic streaming events carry a `type` discriminator when they are JSON objects. */
interface StreamEventData {
  type?: string;
  message?: Record<string, unknown>;
  index?: number;
  content_block?: unknown;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

function asStreamData(data: unknown): StreamEventData | undefined {
  return data !== null && typeof data === "object" ? (data as StreamEventData) : undefined;
}

/**
 * Reassemble the final Anthropic message object from a stream of SSE events
 * (message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop), mirroring what the SDK
 * does client-side. Returns `null` when no `message_start` was seen (e.g. an
 * error stream). Kept a faithful port of the experiment's `assembleMessage`.
 */
export function assembleMessage(events: SseEvent[]): Record<string, unknown> | null {
  let message: Record<string, unknown> | null = null;
  const partialJson = new Map<number, string>();

  for (const { data } of events) {
    const evt = asStreamData(data);
    if (evt === undefined) continue;
    switch (evt.type) {
      case "message_start": {
        message = structuredClone(evt.message ?? {});
        if (!Array.isArray(message.content)) message.content = [];
        break;
      }
      case "content_block_start": {
        if (message === null || evt.index === undefined) break;
        (message.content as unknown[])[evt.index] = structuredClone(evt.content_block);
        break;
      }
      case "content_block_delta": {
        if (message === null || evt.index === undefined) break;
        const block = (message.content as Record<string, unknown>[])[evt.index];
        if (block === undefined) break;
        const delta = evt.delta ?? {};
        if (delta.type === "text_delta") {
          block.text = `${(block.text as string) ?? ""}${delta.text ?? ""}`;
        } else if (delta.type === "thinking_delta") {
          block.thinking = `${(block.thinking as string) ?? ""}${delta.thinking ?? ""}`;
        } else if (delta.type === "signature_delta") {
          block.signature = delta.signature;
        } else if (delta.type === "input_json_delta") {
          const prev = partialJson.get(evt.index) ?? "";
          partialJson.set(evt.index, prev + ((delta.partial_json as string) ?? ""));
        }
        break;
      }
      case "content_block_stop": {
        if (message === null || evt.index === undefined) break;
        const block = (message.content as Record<string, unknown>[])[evt.index];
        if (block !== undefined && partialJson.has(evt.index)) {
          const raw = partialJson.get(evt.index) ?? "";
          const parsed = tryParseJson(raw);
          block.input = parsed.ok ? parsed.value : raw;
        }
        break;
      }
      case "message_delta": {
        if (message === null) break;
        Object.assign(message, evt.delta ?? {});
        if (evt.usage) message.usage = { ...((message.usage as object) ?? {}), ...evt.usage };
        break;
      }
      default:
        break;
    }
  }
  return message;
}
