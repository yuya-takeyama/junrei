#!/usr/bin/env node
// Fetch LiteLLM's model pricing table and store an Anthropic-focused snapshot
// used by @junrei/core's cost engine. Run: node scripts/update-pricing.mjs
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const KEPT_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost_above_200k_tokens",
  "cache_creation_input_token_cost_above_1hr",
];

const res = await fetch(SOURCE_URL);
if (!res.ok) {
  throw new Error(`Failed to fetch pricing: ${res.status} ${res.statusText}`);
}
const raw = await res.json();

const snapshot = {};
for (const [model, entry] of Object.entries(raw)) {
  if (typeof entry !== "object" || entry === null) continue;
  const isClaude = model.startsWith("claude") || model.includes("anthropic/claude");
  // Codex CLI sessions report bare OpenAI ids (e.g. "gpt-5.5", "gpt-5.2-codex") with
  // no provider prefix, so only the unprefixed litellm keys are relevant here.
  const isOpenAiGpt5 = /^gpt-5/.test(model);
  if (!isClaude && !isOpenAiGpt5) continue;
  const kept = {};
  for (const field of KEPT_FIELDS) {
    if (typeof entry[field] === "number") {
      kept[field] = entry[field];
    }
  }
  if (kept.input_cost_per_token !== undefined && kept.output_cost_per_token !== undefined) {
    // Normalize provider-prefixed keys (e.g. "anthropic/claude-...") to bare model ids.
    const bare = model.includes("/") ? model.split("/").pop() : model;
    snapshot[bare] ??= kept;
  }
}

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/pricing/prices.json",
);
await writeFile(
  out,
  `${JSON.stringify({ source: SOURCE_URL, fetchedAt: new Date().toISOString(), models: snapshot }, null, 2)}\n`,
);
console.log(`Wrote ${Object.keys(snapshot).length} models to ${out}`);
