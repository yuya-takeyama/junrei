/**
 * Deterministic normalization rules that reconcile the session log's shape with
 * the wire request's shape. Each rule has a STABLE id (surfaced in a
 * `ReconstructedRequest.appliedRules`) and a doc comment stating its measured
 * basis. The measured reconstruction fidelity (docs/milestones/goshuin.md,
 * "Reconstruction fidelity (measured)") is 85.2% byte-exact and ~99% after
 * exactly these mechanical rules, 0% missing with disk access.
 *
 * The four content-shaping transforms below are pure functions, each tested in
 * isolation. `queue-operation-skip` and `task-notification-preamble` are
 * structural replay rules (documented here, applied in `replay.ts` /
 * `reconstruct.ts`) rather than value transforms.
 */

/** Content-form: string↔array of a message's `content`. */
export const RULE_CONTENT_FORM = "content-form";
/** Cache-control-strip: drop the wire-only `cache_control` key. */
export const RULE_CACHE_CONTROL_STRIP = "cache-control-strip";
/** Caller-strip: drop the log-only `caller` key on a `tool_use` block. */
export const RULE_CALLER_STRIP = "caller-strip";
/** Thinking-drop: `thinking` blocks are never re-sent in replayed history. */
export const RULE_THINKING_DROP = "thinking-drop";
/** Queue-operation-skip: `queue-operation` records carry no wire message. */
export const RULE_QUEUE_OPERATION_SKIP = "queue-operation-skip";
/** Task-notification-preamble: the wire prefixes a fixed harness safety preamble the log omits. */
export const RULE_TASK_NOTIFICATION_PREAMBLE = "task-notification-preamble";

/**
 * content-form — the session log stores a simple user turn's `message.content`
 * as a BARE STRING (`"do the thing"`), while the wire always sends the block
 * array form (`[{ type: "text", text: "do the thing" }]`). Measured: the first
 * user prompt appeared as a string in the log and an array on the wire, and
 * normalizing the two forms reconciled them byte-for-byte. Idempotent on
 * content already in array form.
 */
export function applyContentForm(content: string | unknown[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/** Remove a single top-level key from a plain-object block, preserving the rest. */
function omitKey(block: unknown, key: string): { block: unknown; had: boolean } {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return { block, had: false };
  }
  const entries = Object.entries(block as Record<string, unknown>);
  const had = entries.some(([k]) => k === key);
  if (!had) return { block, had: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (k === key) continue;
    out[k] = v;
  }
  return { block: out, had: true };
}

/**
 * cache-control-strip — the wire stamps an ephemeral `cache_control` marker on
 * the blocks it caches; the session log never records it. Measured: otherwise
 * identical blocks differed only by a `cache_control` key present on the wire.
 * Returns the block without that key and whether it was present.
 */
export function applyCacheControlStrip(block: unknown): { block: unknown; applied: boolean } {
  const { block: stripped, had } = omitKey(block, "cache_control");
  return { block: stripped, applied: had };
}

/**
 * caller-strip — `tool_use` blocks in the log may carry a harness-only `caller`
 * annotation that the wire request omits. Measured: a reconstructed `tool_use`
 * matched the wire exactly once `caller` was dropped. Returns the block without
 * that key and whether it was present.
 */
export function applyCallerStrip(block: unknown): { block: unknown; applied: boolean } {
  const { block: stripped, had } = omitKey(block, "caller");
  return { block: stripped, applied: had };
}

/**
 * thinking-drop — Claude Code never re-sends `thinking` blocks in the message
 * history of later requests. Measured: assistant turns replayed WITHOUT their
 * thinking blocks matched the wire exactly. Returns the kept blocks and whether
 * any thinking block was dropped.
 */
export function applyThinkingDrop<T extends { type: string }>(
  blocks: T[],
): { blocks: T[]; applied: boolean } {
  const kept = blocks.filter((b) => b.type !== "thinking");
  return { blocks: kept, applied: kept.length !== blocks.length };
}
