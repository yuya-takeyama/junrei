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
  /**
   * How to extract the version shown next to the codename — "claude" reads
   * digits around the family word ("claude-sonnet-4-5" → "sonnet 4.5"),
   * "gpt" reads the digits after the gpt prefix ("gpt-5.6-sol" → "5.6 sol").
   * Omitted = codename alone (e.g. auto-review has no version).
   */
  version?: "claude" | "gpt";
}

/** Matches `word` only between id-segment boundaries, so "sol" never fires on e.g. "solar". */
function seg(word: string): RegExp {
  return new RegExp(`(^|[-._/ ])${word}($|[-._/ ])`);
}

/** Ordered — first match wins, so specific families sit above the generic gpt/codex buckets. */
const MODEL_FAMILIES: readonly ModelFamily[] = [
  // Claude — fable/opus share the top-tier accent (three-tier scheme predates fable).
  { cls: "f", match: seg("fable"), label: "fable", version: "claude" },
  { cls: "f", match: seg("opus"), label: "opus", version: "claude" },
  { cls: "s", match: seg("sonnet"), label: "sonnet", version: "claude" },
  { cls: "h", match: seg("haiku"), label: "haiku", version: "claude" },
  // Codex GPT-5.6 codenames.
  { cls: "sol", match: seg("sol"), label: "sol", version: "gpt" },
  { cls: "terra", match: seg("terra"), label: "terra", version: "gpt" },
  { cls: "luna", match: seg("luna"), label: "luna", version: "gpt" },
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
 * Dotted version segments around the family word — modern ids put them after
 * ("claude-sonnet-4-5" → "4.5"), legacy ids before ("claude-3-7-sonnet" →
 * "3.7"). Segments are 1–2 digits, so a trailing snapshot date (8 digits or
 * a -2025-08-07 tail) never reads as a version.
 */
function claudeVersion(m: string, word: string): string | undefined {
  const version = "\\d{1,2}(?!\\d)(?:[-.]\\d{1,2}(?!\\d))*";
  const match =
    new RegExp(`${word}[-.](${version})`).exec(m) ?? new RegExp(`(${version})[-.]${word}`).exec(m);
  return match?.[1]?.replaceAll("-", ".");
}

/** Version between the gpt prefix and the codename — "gpt-5.6-sol" → "5.6". */
function gptVersion(m: string): string | undefined {
  return /gpt[-.](\d{1,2}(?:\.\d{1,2})*)/.exec(m)?.[1];
}

/**
 * Short display label for a model id — "codename version" for known families
 * ("fable 5", "sonnet 4.5", "5.6 terra"), otherwise the raw id with vendor
 * date / `-latest` suffixes stripped. Callers keep the raw id as a tooltip.
 */
export function modelShortLabel(model: string): string {
  const family = familyOf(model);
  if (family?.label !== undefined) {
    const m = model.toLowerCase();
    if (family.version === "claude") {
      const v = claudeVersion(m, family.label);
      return v === undefined ? family.label : `${family.label} ${v}`;
    }
    if (family.version === "gpt") {
      const v = gptVersion(m);
      return v === undefined ? family.label : `${v} ${family.label}`;
    }
    return family.label;
  }
  return model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "").replace(/-latest$/, "");
}
