/** Lens tabs shown inside a session shell (the persistent "band" + tab bar). */
export type Lens = "overview" | "timeline" | "orchestration" | "context" | "files";

const LENSES: readonly Lens[] = ["overview", "timeline", "orchestration", "context", "files"];

export type Route =
  | { view: "list" }
  | { view: "session"; project: string; id: string; lens: Lens; record?: number };

function isLens(value: string | undefined): value is Lens {
  return value !== undefined && (LENSES as readonly string[]).includes(value);
}

/**
 * Pure hash parser — no DOM/window access, easy to unit test.
 *
 * The record slide-over (L3, screen 8) is addressed with a `?record=<line>`
 * query segment appended to the session hash (e.g.
 * `#/session/proj/id/timeline?record=42`) rather than component-local state.
 * Reasons: (1) it makes a specific record shareable/bookmarkable, matching
 * how every other drill-down in this app is a real URL; (2) opening the
 * panel pushes a history entry, so the browser Back button closes it — the
 * 2s interaction note's "esc closes" gets a Back-button equivalent for free;
 * (3) the lens path segment is untouched, so the underlying lens component
 * never unmounts and its scroll position survives open/close, satisfying
 * "without losing place".
 */
export function parseRoute(hash: string): Route {
  const [path = "", query] = hash.split("?");
  const match = /^#\/session\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const lensSegment = match[3];
    const recordParam = new URLSearchParams(query ?? "").get("record");
    const record =
      recordParam !== null && /^\d+$/.test(recordParam)
        ? Number.parseInt(recordParam, 10)
        : undefined;
    return {
      view: "session",
      project: decodeURIComponent(match[1]),
      id: decodeURIComponent(match[2]),
      lens: isLens(lensSegment) ? lensSegment : "overview",
      ...(record !== undefined && { record }),
    };
  }
  return { view: "list" };
}

/** Build the hash for a session route; omits the lens segment for "overview". */
export function buildHash(project: string, id: string, lens: Lens = "overview"): string {
  const base = `#/session/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}

/** Build the hash that opens the record slide-over for a given source line. */
export function buildRecordHash(project: string, id: string, lens: Lens, line: number): string {
  return `${buildHash(project, id, lens)}?record=${line}`;
}
