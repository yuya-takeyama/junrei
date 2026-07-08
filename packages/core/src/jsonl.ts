/**
 * Parse a single JSONL line tolerantly. Session logs may contain malformed
 * lines (truncated writes, schema drift); callers count `null` results as
 * parse warnings instead of failing the whole file.
 */
export function parseJsonlLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
