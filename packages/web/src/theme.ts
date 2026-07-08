import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "junrei.theme";

function getStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Tracks the effective theme (explicit choice, falling back to the system
 * preference) and exposes a toggle that persists an explicit choice.
 * Default is dark; `prefers-color-scheme` is honored only until the user
 * makes an explicit choice (see index.html's inline bootstrap script and
 * styles/tokens.css for the CSS side of this contract).
 */
export function useTheme(): [Theme, () => void] {
  const [explicit, setExplicit] = useState<Theme | null>(() => getStoredTheme());
  const effective = explicit ?? systemTheme();

  useEffect(() => {
    if (explicit === null) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = explicit;
    }
  }, [explicit]);

  const toggle = useCallback(() => {
    setExplicit((current) => {
      const next: Theme = (current ?? systemTheme()) === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage unavailable (private mode, etc.) — theme still applies for this session.
      }
      return next;
    });
  }, []);

  return [effective, toggle];
}
