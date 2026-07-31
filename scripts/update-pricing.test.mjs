import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCurrentRates, formatSummary, mergePricingHistory } from "./update-pricing.mjs";

const OLD = { input_cost_per_token: 1e-6, output_cost_per_token: 6e-6 };
const NEW = { input_cost_per_token: 2e-7, output_cost_per_token: 1.2e-6 };
const HISTORY = {
  "gpt-x": [{ valid_from: null, fetched_at: "2026-01-01T00:00:00.000Z", ...OLD }],
};

test("no divergence -> no append, models unchanged", () => {
  const { models, appended } = mergePricingHistory(
    HISTORY,
    { "gpt-x": { ...OLD } },
    "2026-08-01",
    "2026-08-01T05:00:00.000Z",
  );
  assert.deepEqual(appended, []);
  assert.deepEqual(models, HISTORY);
});

test("divergence appends exactly one dated entry, preserving earlier ones", () => {
  const { models, appended } = mergePricingHistory(
    HISTORY,
    { "gpt-x": { ...NEW } },
    "2026-08-01",
    "2026-08-01T05:00:00.000Z",
  );
  assert.deepEqual(appended, [{ model: "gpt-x", valid_from: "2026-08-01" }]);
  assert.equal(models["gpt-x"].length, 2);
  assert.equal(models["gpt-x"][0].valid_from, null);
  assert.deepEqual(models["gpt-x"][1], {
    valid_from: "2026-08-01",
    fetched_at: "2026-08-01T05:00:00.000Z",
    ...NEW,
  });
});

test("a model junrei tracks but upstream dropped is preserved untouched", () => {
  const { models, appended } = mergePricingHistory(
    HISTORY,
    {},
    "2026-08-01",
    "2026-08-01T05:00:00.000Z",
  );
  assert.deepEqual(appended, []);
  assert.deepEqual(models, HISTORY);
});

test("a brand-new upstream model starts a valid_from:null history", () => {
  const { models, appended } = mergePricingHistory(
    HISTORY,
    { "gpt-x": { ...OLD }, "gpt-y": { ...NEW } },
    "2026-08-01",
    "2026-08-01T05:00:00.000Z",
  );
  assert.deepEqual(appended, [{ model: "gpt-y", valid_from: null }]);
  assert.deepEqual(models["gpt-y"], [
    { valid_from: null, fetched_at: "2026-08-01T05:00:00.000Z", ...NEW },
  ]);
});

test("same-day conflicting rates throw (manual amendment required)", () => {
  const manual = {
    "gpt-x": [
      ...HISTORY["gpt-x"],
      { valid_from: "2026-08-01", fetched_at: "2026-08-01T00:00:00.000Z", ...NEW },
    ],
  };
  assert.throws(
    () =>
      mergePricingHistory(
        manual,
        { "gpt-x": { input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6 } },
        "2026-08-01",
        "2026-08-01T06:00:00.000Z",
      ),
    /amend that entry manually/,
  );
});

test("a manual early append is not duplicated when upstream catches up", () => {
  const manual = {
    "gpt-x": [
      ...HISTORY["gpt-x"],
      { valid_from: "2026-07-30", fetched_at: "2026-07-31T00:00:00.000Z", ...NEW },
    ],
  };
  const { appended } = mergePricingHistory(
    manual,
    { "gpt-x": { ...NEW } },
    "2026-08-03",
    "2026-08-03T05:00:00.000Z",
  );
  assert.deepEqual(appended, []);
});

test("a future-dated entry is ignored when choosing the comparison baseline", () => {
  const withFuture = {
    "gpt-x": [
      ...HISTORY["gpt-x"],
      { valid_from: "2099-01-01", fetched_at: "2026-07-01T00:00:00.000Z", ...NEW },
    ],
  };
  const { appended } = mergePricingHistory(
    withFuture,
    { "gpt-x": { ...OLD } },
    "2026-08-05",
    "2026-08-05T05:00:00.000Z",
  );
  assert.deepEqual(appended, []);
});

test("extractCurrentRates filters, normalizes and aliases like the legacy script", () => {
  const raw = {
    "gpt-5.4": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
      litellm_provider: "openai",
    },
    "anthropic/claude-test-1": { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 },
    "gemini-x": { input_cost_per_token: 1e-9, output_cost_per_token: 1e-9 },
    "gpt-5-noprice": { output_cost_per_token: 2e-6 },
  };
  const current = extractCurrentRates(raw);
  assert.deepEqual(Object.keys(current).sort(), ["claude-test-1", "codex-auto-review", "gpt-5.4"]);
  assert.deepEqual(current["codex-auto-review"], current["gpt-5.4"]);
});

test("formatSummary renders old→new per-MTok cells for appended models", () => {
  const merged = mergePricingHistory(
    HISTORY,
    { "gpt-x": { ...NEW } },
    "2026-08-01",
    "2026-08-01T05:00:00.000Z",
  );
  const summary = formatSummary(merged.appended, HISTORY, merged.models);
  assert.match(summary, /gpt-x/);
  assert.match(summary, /\$1\.00 → \$0\.20/);
});
