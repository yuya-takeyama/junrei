import { useCallback, useState } from "react";

const STORAGE_KEY = "junrei.rail.collapsed";

/**
 * Parses the raw localStorage value for the rail's collapsed state. Only the
 * exact serialized `"true"` counts as collapsed — anything else (missing,
 * corrupt, or a stray value from a future format) falls back to expanded, so
 * a bad read never wrongly hides the nav.
 */
export function parseRailCollapsed(value: string | null): boolean {
  return value === "true";
}

/** Serializes the collapsed flag for storage — mirrors `parseRailCollapsed`'s round-trip contract. */
export function serializeRailCollapsed(collapsed: boolean): string {
  return collapsed ? "true" : "false";
}

function getStoredRailCollapsed(): boolean {
  try {
    return parseRailCollapsed(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

/**
 * Tracks whether the left nav rail is collapsed, persisting the choice in
 * localStorage so it survives reloads (mirrors `useTheme` in ../theme.ts: a
 * lazy `useState` initializer reads storage synchronously on mount — no
 * flash of the wrong state — and the toggle writes through with a
 * try/catch for private-mode/storage-disabled browsers). Default is
 * expanded.
 */
export function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => getStoredRailCollapsed());

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, serializeRailCollapsed(next));
      } catch {
        // Storage unavailable (private mode, etc.) — collapsed state still applies for this session.
      }
      return next;
    });
  }, []);

  return [collapsed, toggle];
}
