import { useTheme } from "../theme.js";

/** Minimal, unobtrusive dark/light switch — mono 11px muted, lives at the band's right end. */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="mono fs11 mut theme-toggle"
      onClick={toggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  );
}
