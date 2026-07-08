/** Lens tabs shown inside a session shell (the persistent "band" + tab bar). */
export type Lens = "overview" | "timeline" | "orchestration" | "context" | "files";

const LENSES: readonly Lens[] = ["overview", "timeline", "orchestration", "context", "files"];

export type Route = { view: "list" } | { view: "session"; project: string; id: string; lens: Lens };

function isLens(value: string | undefined): value is Lens {
  return value !== undefined && (LENSES as readonly string[]).includes(value);
}

/** Pure hash parser — no DOM/window access, easy to unit test. */
export function parseRoute(hash: string): Route {
  const match = /^#\/session\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const lensSegment = match[3];
    return {
      view: "session",
      project: decodeURIComponent(match[1]),
      id: decodeURIComponent(match[2]),
      lens: isLens(lensSegment) ? lensSegment : "overview",
    };
  }
  return { view: "list" };
}

/** Build the hash for a session route; omits the lens segment for "overview". */
export function buildHash(project: string, id: string, lens: Lens = "overview"): string {
  const base = `#/session/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  return lens === "overview" ? base : `${base}/${lens}`;
}
