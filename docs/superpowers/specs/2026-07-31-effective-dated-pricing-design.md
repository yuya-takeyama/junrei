# Effective-Dated Model Pricing — Design

Date: 2026-07-31
Status: approved (design), pending implementation plan

## Motivation

On 2026-07-30 OpenAI cut GPT-5.6 API prices effective immediately
(Luna $1/$6 → $0.20/$1.20 per MTok, −80%; Terra $2.50/$15 → $2/$12, −20%;
Sol unchanged). This exposed two problems in junrei's pricing pipeline:

1. **Retroactive drift.** Junrei has no database; cost is recomputed on every
   read as `raw tokens × current price table`
   (`packages/core/src/shared/pricing/pricing.ts`,
   `estimateCostComponents`/`estimateCostUsd`). Updating
   `packages/core/src/shared/pricing/prices.json` therefore silently reprices
   **every past session**. Sessions run before a price change were billed at
   the old rates, so after an update they display cheaper (or pricier) than
   what was actually spent — contaminating exactly the time-series
   comparisons junrei exists for ("did our cost go down after this change?").
2. **Manual, laggy updates.** `prices.json` is a snapshot of LiteLLM's
   `model_prices_and_context_window.json`, refreshed only by manually running
   `scripts/update-pricing.mjs`. LiteLLM itself has no update SLA: this cut
   was still absent ~18h after the announcement (models.dev likewise;
   OpenRouter had it but with OpenRouter's own 50% promo discount baked in,
   so it is not usable as a raw-OpenAI price proxy; no official OpenAI
   pricing API exists).

## Decision

Adopt **effective-dated pricing** (per-model price history selected by
message timestamp) plus a **daily cron that auto-opens a PR** when LiteLLM's
table diverges from our latest entries. Alternatives rejected:

- *Accept retroactive drift (status quo)*: zero work, but corrupts
  cross-time cost comparisons; rejected.
- *Persist computed cost at ingest*: contradicts junrei's no-database,
  re-parse-on-read architecture; rejected as YAGNI.

Feasibility note: every call site that computes cost already has the message
`timestamp` threaded through from the JSONL parser, so rate selection by date
requires wiring only, no pipeline restructuring.

## Schema (`prices.json`)

`models` changes from `Record<modelId, ModelPricing>` to
`Record<modelId, PricingHistoryEntry[]>`:

```jsonc
{
  "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "models": {
    "gpt-5.6-luna": [
      { "valid_from": null, "fetched_at": "2026-07-26T20:56:36.781Z",
        /* full ModelPricing fields (USD per token) */ },
      { "valid_from": "2026-07-30", "fetched_at": "2026-07-31T00:00:00Z",
        /* full ModelPricing fields */ }
    ]
  }
}
```

- Each entry is a **complete snapshot** of all `ModelPricing` fields — no
  field inheritance from earlier entries. Selection logic stays trivial and
  each entry is readable standalone.
- `valid_from` is a `YYYY-MM-DD` UTC date (or `null` = "since forever").
  Price changes are announced as dates, not instants; day granularity is
  enough. An entry becomes effective at `00:00:00Z` on its `valid_from`
  date — a message timestamped anywhere on that date already uses the new
  entry.
- Entries per model are sorted ascending by `valid_from` (`null` first);
  loader re-sorts defensively. Duplicate `valid_from` for one model is
  rejected by the update script.
- The existing `ModelPricing` interface
  (`packages/core/src/shared/pricing/pricing.ts:4-14`) is unchanged.
- Migration: wrap the current snapshot of each model as its single
  `valid_from: null` entry, preserving today's `fetchedAt` as `fetched_at`.
  The top-level `fetchedAt` moves into per-entry `fetched_at`.

## Rate selection

`findModelPricing(modelId, timestamp?)` gains a timestamp parameter and
returns the **last entry with `valid_from <= timestamp`**:

- `timestamp` earlier than every dated entry → the `valid_from: null` entry.
- `timestamp` missing/undefined → the latest entry (matches current
  behavior).
- Callers updated to pass the record timestamp (all already have it):
  - `packages/core/src/claude/timeline.ts` (per-message entries)
  - `packages/core/src/claude/metrics.ts` (`computeUsage`,
    `computeTurnUsage`)
  - `packages/core/src/claude/evaluation-trace.ts`
  - `packages/core/src/codex/analyze.ts`
  - `packages/core/src/insight/whatIf.ts` (what-if simulation of a past
    session now correctly uses that session's contemporaneous rates)
  - `packages/core/src/shared/bash-stats.ts`

Unknown-model handling is unchanged: no matching model → `undefined` →
caller marks usage `unpriced`, aggregate sets `costIsComplete = false`, web
UI renders the trailing `*`. No UI changes required; recomputed costs flow
through existing components.

## Update script (`scripts/update-pricing.mjs`)

- Fetch LiteLLM's table as today, apply the existing model filter
  (Claude + `gpt-5*` + alias list).
- Per model, compare fetched prices against the **latest** history entry:
  - identical → no-op (the file is no longer clobbered on every run);
  - different → append a new entry with `valid_from` = fetch date (UTC) and
    `fetched_at` = fetch instant;
  - new model → create the model with a single `valid_from: null` entry.
- Never rewrite or delete existing entries. Corrections to an existing
  entry (wrong rate, refined effective date) are manual edits.
- Because append only happens on divergence from the latest entry, a manual
  early append (made before LiteLLM catches up) is not duplicated when the
  cron later fetches the same values.

## Automation (GitHub Actions)

- **Daily** cron (daily keeps the worst-case `valid_from` = fetch-date error
  small, given LiteLLM's uncertain lag) runs the update script; if the file
  changed, open a PR.
- PR body contains: per-model old→new price diff table, and a checklist
  reminder — *"verify `valid_from` against the provider's announced
  effective date and amend before merging if they differ."* Human review of
  the effective date before merge is the point of the PR gate; LiteLLM's
  ingestion date is not the provider's effective date.
- No divergence → no PR, no noise.

## Immediate data update (this price cut)

- Manually append `valid_from: "2026-07-30"` entries for `gpt-5.6-luna` and
  `gpt-5.6-terra` with the announced input/output rates
  (Luna $0.20/$1.20, Terra $2/$12 per MTok → per-token values in the file).
- Cache read/write rates were **not** in the announcement. Carry the prior
  cache rates into the new entries rather than guessing; when LiteLLM
  publishes the real values, the daily cron will surface a diff PR — apply
  it as an **amendment to the same `valid_from: "2026-07-30"` entry** (same
  effective date, so no new entry). Until then cache-heavy Luna/Terra
  sessions read slightly high; conservative overstatement is preferred over
  invented rates.
- `gpt-5.6` (base alias, currently priced at Sol rates) and `gpt-5.6-sol`
  are unchanged by this cut.

## Testing

- Rate selection unit tests: timestamp before the first dated entry; exactly
  on a boundary date; between entries; after the last entry; missing
  timestamp; unknown model.
- Update script: divergence → appends exactly one entry; no divergence →
  no-op; new model → `valid_from: null` entry; duplicate `valid_from`
  rejected.
- Backward compatibility: existing cost-computation tests must produce
  identical numbers for a model whose history has only the `valid_from:
  null` entry.

## Out of scope (YAGNI)

- Runtime fetching of LiteLLM (offline breakage, environment-dependent
  numbers, no human gate on effective dates).
- Surfacing price-revision history in the web UI.
- Non-LiteLLM price sources (models.dev, OpenRouter, Helicone) — evaluated
  and rejected for now: none carries true effective-dated history, and
  OpenRouter's numbers embed its own discounts.
