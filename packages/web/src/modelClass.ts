/** Junrei's three-tier model accent (see design-spec/00-tokens.md); "mut" = unclassified. */
export type ModelClass = "f" | "s" | "h" | "mut";

/** Classify a raw model id into the fable/sonnet/haiku accent used for dots, bars, and mix bars. */
export function classifyModel(model: string): ModelClass {
  const m = model.toLowerCase();
  if (m.includes("fable") || m.includes("opus")) return "f";
  if (m.includes("sonnet")) return "s";
  if (m.includes("haiku")) return "h";
  return "mut";
}

/** Short display label for a model id — family name, never collapsing distinct models. */
export function modelShortLabel(model: string): string {
  const m = model.toLowerCase();
  for (const family of ["fable", "opus", "sonnet", "haiku"]) {
    if (m.includes(family)) return family;
  }
  return model;
}
