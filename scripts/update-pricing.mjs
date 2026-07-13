#!/usr/bin/env node
// Fetch LiteLLM's model pricing table and store an Anthropic-focused snapshot
// used by @junrei/core's cost engine. Run: node scripts/update-pricing.mjs
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Model ids Codex writes into rollouts that LiteLLM has no key for, priced by
// copying a LiteLLM-covered model's entry. "codex-auto-review" is the slug of
// Codex's auto-review ("guardian") turns; OpenAI documents the feature as
// GPT-5.4 Thinking at low reasoning (https://alignment.openai.com/auto-review/)
// and bills API-key usage under it (https://github.com/openai/codex/issues/19420),
// so gpt-5.4's rates apply. An upstream entry with the alias's own key wins if
// LiteLLM ever adds one.
const MODEL_ALIASES = {
  "codex-auto-review": "gpt-5.4",
};

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
  const isKnownAlias = Object.hasOwn(MODEL_ALIASES, model);
  if (!isClaude && !isOpenAiGpt5 && !isKnownAlias) continue;
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

for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
  snapshot[alias] ??= snapshot[target];
  if (snapshot[alias] === undefined) {
    throw new Error(
      `Alias target "${target}" missing from upstream snapshot (needed by "${alias}")`,
    );
  }
}

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/shared/pricing/prices.json",
);
await writeFile(
  out,
  `${JSON.stringify({ source: SOURCE_URL, fetchedAt: new Date().toISOString(), models: snapshot }, null, 2)}\n`,
);
console.log(`Wrote ${Object.keys(snapshot).length} models to ${out}`);
