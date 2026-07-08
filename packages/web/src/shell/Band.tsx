import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle.js";

interface BandProps {
  /** Rendered after the JUNREI wordmark, left-aligned (tagline or breadcrumb). */
  left: ReactNode;
  /** Rendered before the theme toggle, right-aligned. */
  right?: ReactNode;
}

/** Identity strip at the top of every screen — see design-spec/01-shell.md. */
export function Band({ left, right }: BandProps) {
  return (
    <div className="band">
      <div className="fx ac gap12">
        <a href="#/" className="wm mono fs12">
          JUNREI
        </a>
        {left}
      </div>
      <div className="fx ac gap12">
        {right}
        <ThemeToggle />
      </div>
    </div>
  );
}
