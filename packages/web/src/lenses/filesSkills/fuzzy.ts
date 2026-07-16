/**
 * Case-insensitive subsequence fuzzy match — every character of `query`
 * must appear in `text`, in order, not necessarily contiguous (the same
 * "type a few distinctive letters" matching VSCode/Sublime file pickers
 * use). Greedy leftmost: each query character consumes the FIRST remaining
 * candidate in `text`, so the returned indices are always strictly
 * increasing.
 *
 * Returns the matched character indices (into `text`) for highlighting, or
 * `undefined` when `query` doesn't match at all. An empty `query` trivially
 * matches everything with zero highlighted indices — callers that treat an
 * empty query as "no filter active" should special-case it themselves
 * rather than relying on this to reject it.
 */
export function fuzzyMatch(text: string, query: string): number[] | undefined {
  if (query === "") return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  for (const ch of lowerQuery) {
    let found = -1;
    while (ti < lowerText.length) {
      if (lowerText[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found === -1) return undefined;
    indices.push(found);
  }
  return indices;
}

export interface HighlightSegment {
  text: string;
  matched: boolean;
  /** Offset of this run's first character in the original `text` — a stable, data-derived React key for renderers (deliberately NOT the segment's array index). */
  start: number;
}

/**
 * Split `text` into contiguous matched/unmatched runs from `fuzzyMatch`'s
 * indices, so a caller can render one `<span>` per RUN instead of one per
 * character. `indices` undefined or empty (incl. an empty-query "match") is
 * treated as "nothing to highlight" — the whole string comes back as a
 * single unmatched run.
 */
export function highlightSegments(
  text: string,
  indices: readonly number[] | undefined,
): HighlightSegment[] {
  if (indices === undefined || indices.length === 0) return [{ text, matched: false, start: 0 }];
  const matchedSet = new Set(indices);
  const segments: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const matched = matchedSet.has(i);
    let j = i + 1;
    while (j < text.length && matchedSet.has(j) === matched) j++;
    segments.push({ text: text.slice(i, j), matched, start: i });
    i = j;
  }
  return segments;
}
