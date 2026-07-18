/**
 * Write-time header redaction — the security-critical core of the capture
 * proxy (Goshuin Phase D, docs/milestones/goshuin.md Decision 6). Before ANY
 * bytes reach disk, every credential-bearing header's VALUE is replaced with
 * `[redacted]`; the pass-through to upstream/downstream stays byte-faithful
 * (only the STORED copy is redacted — see `proxy.ts`, which redacts exclusively
 * when building the capture entry, never the forwarded headers).
 *
 * The redaction set is intentionally broad: the four explicitly named headers
 * plus any header whose NAME contains `token` or `secret` (case-insensitive),
 * so a future/custom credential header (`x-session-token`, `x-client-secret`,
 * …) is redacted without this list needing to enumerate it.
 */

/** The sentinel every redacted value becomes on disk. */
export const REDACTED = "[redacted]";

/** Headers always redacted by exact (lowercased) name. */
const ALWAYS_REDACT = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);

/**
 * Whether a header's value must be redacted before it is written to a capture
 * file. True for the four named credential headers and for any header whose
 * name contains `token` or `secret` (case-insensitive) — covering bearer
 * tokens, API keys, cookies, and custom secret headers alike.
 */
export function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return ALWAYS_REDACT.has(lower) || lower.includes("token") || lower.includes("secret");
}

/**
 * Return a copy of `headers` with every credential-bearing value (see
 * `shouldRedactHeader`) replaced by `[redacted]`. The input is never mutated,
 * `undefined` values are dropped, and non-credential values pass through
 * untouched. This is the ONLY header shape that is ever serialized to disk.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    out[key] = shouldRedactHeader(key) ? REDACTED : value;
  }
  return out;
}
