/**
 * Model family master data — the single place that maps raw model ids to
 * Junrei's display treatment: a codename-style short label plus a color
 * accent key. Every dot, badge, bar, and mix strip derives from this table.
 *
 * Colors are theme-dependent, so the actual values live in
 * `styles/tokens.css` as `--<key>` custom properties (dark + light) and
 * `styles.css` exposes them as `.c-<key>` background classes. Adding a
 * family = one entry here + one token pair in tokens.css + one `.c-<key>`
 * rule in styles.css.
 */

/** Color-accent key — pairs with the `--<key>` token / `.c-<key>` class; "mut" = unclassified. */
export type ModelClass = "f" | "s" | "h" | "sol" | "terra" | "luna" | "rev" | "gpt" | "mut";

interface ModelFamily {
  /** Accent key shared by every family rendered in this color. */
  cls: ModelClass;
  /** Segment-boundary pattern matched against the lowercased model id. */
  match: RegExp;
  /**
   * Codename-style display label (like the Claude family words); undefined
   * derives the label from the raw id (vendor date / `-latest` suffixes
   * stripped) for versioned ids where the version IS the identity.
   */
  label?: string;
}

/** Matches `word` only between id-segment boundaries, so "sol" never fires on e.g. "solar". */
function seg(word: string): RegExp {
  return new RegExp(`(^|[-._/ ])${word}($|[-._/ ])`);
}

/** Ordered — first match wins, so specific families sit above the generic gpt/codex buckets. */
const MODEL_FAMILIES: readonly ModelFamily[] = [
  // Claude — fable/opus share the top-tier accent (three-tier scheme predates fable).
  { cls: "f", match: seg("fable"), label: "fable" },
  { cls: "f", match: seg("opus"), label: "opus" },
  { cls: "s", match: seg("sonnet"), label: "sonnet" },
  { cls: "h", match: seg("haiku"), label: "haiku" },
  // Codex GPT-5.6 codenames.
  { cls: "sol", match: seg("sol"), label: "sol" },
  { cls: "terra", match: seg("terra"), label: "terra" },
  { cls: "luna", match: seg("luna"), label: "luna" },
  // Codex's built-in reviewer model ("codex-auto-review") — kept visually
  // distinct from the generic buckets so review overhead is visible at a glance.
  { cls: "rev", match: seg("auto-review"), label: "auto-review" },
  // Everything else OpenAI: gpt-5.x, -codex, -mini/-nano/-pro/-chat variants.
  { cls: "gpt", match: seg("gpt") },
  { cls: "gpt", match: seg("codex") },
];

function familyOf(model: string): ModelFamily | undefined {
  const m = model.toLowerCase();
  return MODEL_FAMILIES.find((f) => f.match.test(m));
}

/**
 * Accent-key display order for stacked model-mix bars — family declaration
 * order with the "mut" fallback last.
 */
export const MODEL_CLASS_ORDER: readonly ModelClass[] = [
  ...new Set(MODEL_FAMILIES.map((f) => f.cls)),
  "mut",
];

/** Classify a raw model id into the accent key used for dots, bars, and mix bars. */
export function classifyModel(model: string): ModelClass {
  return familyOf(model)?.cls ?? "mut";
}

/**
 * Short display label for a model id — the family codename when one exists,
 * otherwise the raw id with vendor date / `-latest` suffixes stripped.
 * Like the Claude family words, codenames collapse versions within a family
 * (sonnet-4 vs sonnet-4-5); callers keep the raw id as a tooltip.
 */
export function modelShortLabel(model: string): string {
  const label = familyOf(model)?.label;
  if (label !== undefined) return label;
  return model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "").replace(/-latest$/, "");
}
