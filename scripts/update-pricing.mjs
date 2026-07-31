#!/usr/bin/env node
// Fetch LiteLLM's model pricing table and merge it into @junrei/core's
// effective-dated pricing history (prices.json). Each model maps to an array
// of complete price snapshots; when a fetch diverges from a model's latest
// entry a new entry is APPENDED effective from the fetch date — existing
// entries are never rewritten or deleted, so past sessions keep the rates
// that were in effect when they ran. Run: node scripts/update-pricing.mjs
import { readFile, writeFile } from "node:fs/promises";
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

const PRICES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/shared/pricing/prices.json",
);

/** Keep only the pricing fields junrei consumes from one LiteLLM entry. */
function keptFieldsOf(entry) {
  const kept = {};
  for (const field of KEPT_FIELDS) {
    if (typeof entry[field] === "number") kept[field] = entry[field];
  }
  return kept;
}

/**
 * LiteLLM's raw table -> { bareModelId: kept-rate-fields } for the models
 * junrei tracks (Claude + gpt-5* + the alias list). Aliases absent upstream
 * are filled from their target's rates; an upstream entry with the alias's
 * own key wins if LiteLLM ever adds one.
 */
export function extractCurrentRates(raw) {
  const current = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null) continue;
    const isClaude = model.startsWith("claude") || model.includes("anthropic/claude");
    // Codex CLI sessions report bare OpenAI ids (e.g. "gpt-5.5") with no
    // provider prefix, so only the unprefixed litellm keys are relevant here.
    const isOpenAiGpt5 = /^gpt-5/.test(model);
    const isKnownAlias = Object.hasOwn(MODEL_ALIASES, model);
    if (!isClaude && !isOpenAiGpt5 && !isKnownAlias) continue;
    const kept = keptFieldsOf(entry);
    if (kept.input_cost_per_token !== undefined && kept.output_cost_per_token !== undefined) {
      // Normalize provider-prefixed keys (e.g. "anthropic/claude-...") to bare ids.
      const bare = model.includes("/") ? (model.split("/").pop() ?? model) : model;
      current[bare] ??= kept;
    }
  }
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    current[alias] ??= current[target];
    if (current[alias] === undefined) {
      throw new Error(
        `Alias target "${target}" missing from upstream snapshot (needed by "${alias}")`,
      );
    }
  }
  return current;
}

/** The entry with the greatest valid_from (null = earliest) — mirrors core's latest-entry rule. */
function latestEntryOf(history) {
  let best;
  for (const entry of history) {
    if (best === undefined || (entry.valid_from ?? "") >= (best.valid_from ?? "")) best = entry;
  }
  return best;
}

function ratesEqual(a, b) {
  return KEPT_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Merge freshly fetched rates into the existing history map. Pure — returns
 * new objects, never mutates the inputs. Rules: unchanged rates -> no-op;
 * changed rates -> append { valid_from: fetchDate, ... }; model absent
 * upstream -> preserved untouched (past sessions still need its rates);
 * brand-new model -> single valid_from:null entry. A latest entry that
 * already carries valid_from === fetchDate with DIFFERENT rates is a
 * conflict (same-day manual entry vs upstream) and throws — fold the
 * correction into that entry by hand instead.
 *
 * The comparison baseline is the entry in effect at `fetchDate`, not the
 * greatest `valid_from` overall — a future-dated entry (e.g. a manually
 * pre-staged price change) is ignored when choosing it, so a cron run
 * between today and that future date doesn't compare against rates that
 * aren't in effect yet and append a redundant duplicate entry daily.
 */
export function mergePricingHistory(existing, fetched, fetchDate, fetchedAtIso) {
  const models = { ...existing };
  const appended = [];
  for (const [model, rates] of Object.entries(fetched)) {
    const history = existing[model];
    if (history === undefined) {
      models[model] = [{ valid_from: null, fetched_at: fetchedAtIso, ...rates }];
      appended.push({ model, valid_from: null });
      continue;
    }
    const latest = latestEntryOf(
      history.filter((entry) => entry.valid_from === null || entry.valid_from <= fetchDate),
    );
    if (latest !== undefined && ratesEqual(latest, rates)) continue;
    if (latest?.valid_from === fetchDate) {
      throw new Error(
        `${model}: latest entry already has valid_from=${fetchDate} with different rates — amend that entry manually instead of re-running`,
      );
    }
    models[model] = [...history, { valid_from: fetchDate, fetched_at: fetchedAtIso, ...rates }];
    appended.push({ model, valid_from: fetchDate });
  }
  return { models, appended };
}

const MTOK = 1_000_000;
function perMTok(rate) {
  return rate === undefined ? "—" : `$${(rate * MTOK).toFixed(2)}`;
}

/** Markdown old→new table of appended changes for the PR body ("" when none). */
export function formatSummary(appended, existing, merged) {
  if (appended.length === 0) return "";
  const lines = [
    "| model | valid_from | input $/MTok | output $/MTok | cache write $/MTok | cache read $/MTok |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const { model, valid_from } of appended) {
    const history = existing[model];
    const prev = history === undefined ? undefined : latestEntryOf(history);
    const next = latestEntryOf(merged[model]);
    const cell = (field) =>
      prev === undefined
        ? perMTok(next?.[field])
        : `${perMTok(prev[field])} → ${perMTok(next?.[field])}`;
    lines.push(
      `| ${model} | ${valid_from ?? "(new model)"} | ${cell("input_cost_per_token")} | ${cell("output_cost_per_token")} | ${cell("cache_creation_input_token_cost")} | ${cell("cache_read_input_token_cost")} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch pricing: ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();
  const snapshot = JSON.parse(await readFile(PRICES_PATH, "utf8"));
  const fetched = extractCurrentRates(raw);
  const nowIso = new Date().toISOString();
  const { models, appended } = mergePricingHistory(
    snapshot.models,
    fetched,
    nowIso.slice(0, 10),
    nowIso,
  );
  if (appended.length === 0) {
    console.log("No pricing changes.");
    return;
  }
  await writeFile(PRICES_PATH, `${JSON.stringify({ source: SOURCE_URL, models }, null, 2)}\n`);
  console.log(formatSummary(appended, snapshot.models, models));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
