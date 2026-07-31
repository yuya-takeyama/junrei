# Effective-Dated Model Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make junrei price each session message at the rates in effect at that message's timestamp (per-model price history in `prices.json`), record the 2026-07-30 GPT-5.6 Luna/Terra price cut, and add a daily GitHub Actions cron that opens a PR whenever LiteLLM's price table diverges.

**Architecture:** `prices.json`'s `models` map changes from one flat `ModelPricing` object per model to an **array of complete, effective-dated snapshots** (`valid_from` + rates). A new pure selector `selectPricingEntry(entries, timestamp?)` picks the entry with the greatest applicable `valid_from`; `findModelPricing` / `estimateCostComponents` / `estimateCostUsd` / `cacheReadRatePerToken` gain an optional trailing `timestamp` parameter, and cost call sites pass the record timestamps they already hold. `scripts/update-pricing.mjs` becomes append-only (never rewrites history) and testable; a daily workflow runs it and opens a human-reviewed PR.

**Tech Stack:** TypeScript (strict) + vitest in `packages/core`; plain ESM `.mjs` + `node:test` in `scripts/`; GitHub Actions; biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-07-31-effective-dated-pricing-design.md` — read it first; it explains every decision below.

## Global Constraints

- All rates in `prices.json` are **USD per single token** (per-MTok price ÷ 1e6). Never write a per-MTok number into the file.
- `valid_from` is a `YYYY-MM-DD` UTC date or `null` (= since forever). An entry takes effect at `00:00:00Z` on its `valid_from` day, inclusive — a message timestamped anywhere on that day uses the new entry.
- Every history entry is a **complete snapshot** of all rate fields — no field inheritance between entries.
- The update script may only **append** entries or add new models — never rewrite or delete existing entries.
- Never invent unpublished rates. The 2026-07-30 Luna/Terra entries carry over the previous cache rates unchanged (input/output only were announced).
- No database, no persisted cost values — cost stays a read-time derivation (`tokens × selected entry`).
- Missing timestamp ⇒ latest entry (current behavior); unknown model ⇒ `undefined` ⇒ `unpriced`/`costIsComplete=false` (unchanged).
- Quality gates: `pnpm typecheck && pnpm lint && pnpm test` from the repo root. Run `pnpm format` before committing if biome complains.
- Match surrounding comment style: this codebase writes dense "why" doc comments on exported functions — keep them accurate when you change behavior.

---

### Task 1: Pricing history schema + selection logic (`packages/core` pricing core)

**Files:**
- Modify: `packages/core/src/shared/pricing/pricing.ts`
- Modify: `packages/core/src/shared/pricing/prices.json` (mechanical migration)
- Test: `packages/core/src/shared/pricing/pricing.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (later tasks rely on these exact signatures):
  - `interface PricingHistoryEntry extends ModelPricing { valid_from: string | null; fetched_at: string }` (exported)
  - `selectPricingEntry(entries: readonly PricingHistoryEntry[], timestamp?: string): PricingHistoryEntry | undefined` (exported)
  - `findModelPricing(model: string, timestamp?: string): ModelPricing | undefined`
  - `estimateCostComponents(model: string, usage: TokenUsage, timestamp?: string): CostComponents | undefined`
  - `estimateCostUsd(model: string, usage: TokenUsage, timestamp?: string): number | undefined`
  - `cacheReadRatePerToken(model: string, contextTokens: number, timestamp?: string): number | undefined`
  - `prices.json` shape: `{ source: string, models: Record<string, PricingHistoryEntry[]> }` (top-level `fetchedAt` is gone)

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/shared/pricing/pricing.test.ts` (extend the existing import from `./pricing.js` with `selectPricingEntry` and `type PricingHistoryEntry`):

```ts
describe("selectPricingEntry", () => {
  const HISTORY: PricingHistoryEntry[] = [
    {
      valid_from: null,
      fetched_at: "2026-01-01T00:00:00.000Z",
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    },
    {
      valid_from: "2026-03-01",
      fetched_at: "2026-03-02T00:00:00.000Z",
      input_cost_per_token: 3e-6,
      output_cost_per_token: 4e-6,
    },
    {
      valid_from: "2026-06-01",
      fetched_at: "2026-06-02T00:00:00.000Z",
      input_cost_per_token: 5e-6,
      output_cost_per_token: 6e-6,
    },
  ];

  it("returns the latest entry when no timestamp is given", () => {
    expect(selectPricingEntry(HISTORY)?.input_cost_per_token).toBe(5e-6);
  });

  it("returns the null entry for a timestamp before every dated entry", () => {
    expect(selectPricingEntry(HISTORY, "2026-02-15T12:00:00.000Z")?.input_cost_per_token).toBe(
      1e-6,
    );
  });

  it("applies a dated entry from 00:00:00Z on its valid_from day (inclusive boundary)", () => {
    expect(selectPricingEntry(HISTORY, "2026-03-01T00:00:00.000Z")?.input_cost_per_token).toBe(
      3e-6,
    );
    expect(selectPricingEntry(HISTORY, "2026-02-28T23:59:59.999Z")?.input_cost_per_token).toBe(
      1e-6,
    );
  });

  it("picks the greatest applicable valid_from between entries", () => {
    expect(selectPricingEntry(HISTORY, "2026-04-10T09:00:00.000Z")?.input_cost_per_token).toBe(
      3e-6,
    );
  });

  it("uses the last entry for timestamps after every valid_from", () => {
    expect(selectPricingEntry(HISTORY, "2027-01-01T00:00:00.000Z")?.input_cost_per_token).toBe(
      5e-6,
    );
  });

  it("is order-independent — an unsorted history gives identical answers", () => {
    const shuffled = [HISTORY[2], HISTORY[0], HISTORY[1]] as PricingHistoryEntry[];
    expect(selectPricingEntry(shuffled, "2026-04-10T00:00:00.000Z")?.input_cost_per_token).toBe(
      3e-6,
    );
    expect(selectPricingEntry(shuffled)?.input_cost_per_token).toBe(5e-6);
  });

  it("returns undefined for an empty history", () => {
    expect(selectPricingEntry([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @junrei/core exec vitest run src/shared/pricing/pricing.test.ts`
Expected: FAIL — `selectPricingEntry` / `PricingHistoryEntry` are not exported.

- [ ] **Step 3: Migrate `prices.json` to the history shape**

Run from the repo root (one-shot; `node -e` runs CommonJS, so `require` is correct here despite the workspace being ESM):

```bash
node -e '
const fs = require("fs");
const path = "packages/core/src/shared/pricing/prices.json";
const snap = JSON.parse(fs.readFileSync(path, "utf8"));
const models = {};
for (const [id, entry] of Object.entries(snap.models)) {
  models[id] = [{ valid_from: null, fetched_at: snap.fetchedAt, ...entry }];
}
fs.writeFileSync(path, JSON.stringify({ source: snap.source, models }, null, 2) + "\n");
'
```

Verify: `head -15 packages/core/src/shared/pricing/prices.json` shows `"models"` mapping each id to a **one-element array** whose entry starts with `"valid_from": null, "fetched_at": "2026-07-26T20:56:36.781Z"`, and the top-level `fetchedAt` key is gone.

- [ ] **Step 4: Implement the schema + selection in `pricing.ts`**

Replace the `PricingSnapshot` interface and add the new type + selector after the `ModelPricing` interface:

```ts
/**
 * One effective-dated price snapshot for a model. Entries are COMPLETE — no
 * field inheritance from earlier entries — so each one is readable and
 * priceable standalone. `valid_from` is a YYYY-MM-DD UTC date taking effect
 * at 00:00:00Z that day (inclusive); `null` means "since forever" (the
 * pre-history baseline every migrated model starts with). `fetched_at` is
 * the instant the values were fetched from LiteLLM or recorded manually.
 */
export interface PricingHistoryEntry extends ModelPricing {
  valid_from: string | null;
  fetched_at: string;
}

interface PricingSnapshot {
  source: string;
  models: Record<string, PricingHistoryEntry[]>;
}
```

Add `selectPricingEntry` above `findModelPricing`:

```ts
/**
 * Pick the history entry in effect at `timestamp`: the entry with the
 * greatest `valid_from` that is <= the timestamp's UTC date, where `null`
 * compares as "before everything". Without a timestamp, the latest entry —
 * which is what every pre-history caller got from the flat snapshot, so
 * undated call sites keep their existing behavior. The scan is
 * order-independent (greatest applicable wins), so file order is cosmetic.
 * Returns `undefined` only for an empty history.
 */
export function selectPricingEntry(
  entries: readonly PricingHistoryEntry[],
  timestamp?: string,
): PricingHistoryEntry | undefined {
  const date = timestamp?.slice(0, 10);
  let best: PricingHistoryEntry | undefined;
  for (const entry of entries) {
    if (date !== undefined && entry.valid_from !== null && entry.valid_from > date) continue;
    if (best === undefined || (entry.valid_from ?? "") >= (best.valid_from ?? "")) {
      best = entry;
    }
  }
  return best;
}
```

Update `findModelPricing` — same three-step resolution, but each hit resolves through the selector:

```ts
export function findModelPricing(model: string, timestamp?: string): ModelPricing | undefined {
  const models = snapshot.models;
  const normalized = normalizeBedrockModelId(model);

  const exact = models[normalized];
  if (exact !== undefined) return selectPricingEntry(exact, timestamp);

  const dateless = normalized.replace(/-\d{8}$/, "");
  const datelessHit = models[dateless];
  if (datelessHit !== undefined) return selectPricingEntry(datelessHit, timestamp);

  let best: { key: string; entries: PricingHistoryEntry[] } | undefined;
  for (const [key, entries] of Object.entries(models)) {
    if (normalized.startsWith(key) && (best === undefined || key.length > best.key.length)) {
      best = { key, entries };
    }
  }
  return best === undefined ? undefined : selectPricingEntry(best.entries, timestamp);
}
```

Also update the doc comment above `findModelPricing` (add: lookup resolves to the model's history, then `selectPricingEntry` picks the entry for `timestamp`).

Thread the parameter through the three public cost functions — each gains a trailing `timestamp?: string` and forwards it to `findModelPricing`:

```ts
export function estimateCostComponents(
  model: string,
  usage: TokenUsage,
  timestamp?: string,
): CostComponents | undefined {
  // ... zero-usage short-circuit unchanged ...
  const pricing = findModelPricing(model, timestamp);
  // ... rest unchanged ...
}

export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
  timestamp?: string,
): number | undefined {
  return estimateCostComponents(model, usage, timestamp)?.totalCost;
}

export function cacheReadRatePerToken(
  model: string,
  contextTokens: number,
  timestamp?: string,
): number | undefined {
  const pricing = findModelPricing(model, timestamp);
  // ... rest unchanged ...
}
```

Update `pricingSnapshotInfo` (top-level `fetchedAt` no longer exists; report the newest per-entry `fetched_at` — ISO strings compare lexicographically):

```ts
export function pricingSnapshotInfo(): { source: string; fetchedAt: string; modelCount: number } {
  let fetchedAt = "";
  for (const entries of Object.values(snapshot.models)) {
    for (const entry of entries) {
      if (entry.fetched_at > fetchedAt) fetchedAt = entry.fetched_at;
    }
  }
  return {
    source: snapshot.source,
    fetchedAt,
    modelCount: Object.keys(snapshot.models).length,
  };
}
```

- [ ] **Step 5: Run the pricing tests**

Run: `pnpm --filter @junrei/core exec vitest run src/shared/pricing/pricing.test.ts`
Expected: PASS — new `selectPricingEntry` suite green, and every pre-existing test green unchanged (single-entry histories select their only entry in both dated and undated modes).

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `pnpm --filter @junrei/core exec vitest run && pnpm typecheck`
Expected: PASS (the added parameter is optional, so no caller breaks; costs are numerically identical while every model has one entry).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/shared/pricing/pricing.ts packages/core/src/shared/pricing/prices.json packages/core/src/shared/pricing/pricing.test.ts
git commit -m "feat(core): effective-dated pricing history schema and selection"
```

---

### Task 2: Record the 2026-07-30 GPT-5.6 Luna/Terra price cut

**Files:**
- Modify: `packages/core/src/shared/pricing/prices.json` (append two entries)
- Test: `packages/core/src/shared/pricing/pricing.test.ts`

**Interfaces:**
- Consumes: Task 1's `findModelPricing(model, timestamp?)`, `estimateCostUsd(model, usage, timestamp?)`, `cacheReadRatePerToken(model, contextTokens, timestamp?)`.
- Produces: `gpt-5.6-luna` / `gpt-5.6-terra` histories with a second entry `valid_from: "2026-07-30"` — Tasks 3-5 test against these real rates.

- [ ] **Step 1: Write the failing tests**

Append to `pricing.test.ts` (add `cacheReadRatePerToken` to the import if not present). `USAGE` is the file's existing shared constant.

```ts
describe("findModelPricing (GPT-5.6 Luna/Terra price cut, effective 2026-07-30)", () => {
  it("prices Luna at the old rates for messages before 2026-07-30", () => {
    const pricing = findModelPricing("gpt-5.6-luna", "2026-07-29T23:59:59.000Z");
    expect(pricing?.input_cost_per_token).toBe(0.000001);
    expect(pricing?.output_cost_per_token).toBe(0.000006);
  });

  it("prices Luna at the cut rates from 2026-07-30T00:00:00Z", () => {
    const pricing = findModelPricing("gpt-5.6-luna", "2026-07-30T00:00:00.000Z");
    expect(pricing?.input_cost_per_token).toBe(2e-7);
    expect(pricing?.output_cost_per_token).toBe(0.0000012);
    // Cache rates were NOT in the announcement — carried over from the prior
    // entry until LiteLLM publishes real post-cut values (see the spec).
    expect(pricing?.cache_creation_input_token_cost).toBe(0.00000125);
    expect(pricing?.cache_read_input_token_cost).toBe(1e-7);
  });

  it("prices Terra at old/new rates across the boundary", () => {
    expect(
      findModelPricing("gpt-5.6-terra", "2026-07-01T00:00:00.000Z")?.input_cost_per_token,
    ).toBe(0.0000025);
    const after = findModelPricing("gpt-5.6-terra", "2026-08-01T00:00:00.000Z");
    expect(after?.input_cost_per_token).toBe(0.000002);
    expect(after?.output_cost_per_token).toBe(0.000012);
  });

  it("uses the newest rates when no timestamp is given (undated callers)", () => {
    expect(findModelPricing("gpt-5.6-luna")?.input_cost_per_token).toBe(2e-7);
  });

  it("estimateCostUsd reflects the boundary end-to-end", () => {
    // USAGE = 1000 in / 500 out / 2000 cacheRead / 300 cacheCreate.
    // Old: 1000*1e-6 + 500*6e-6 + 2000*1e-7 + 300*1.25e-6 = 0.004575
    // New: 1000*2e-7 + 500*1.2e-6 + 2000*1e-7 + 300*1.25e-6 = 0.001375
    expect(estimateCostUsd("gpt-5.6-luna", USAGE, "2026-07-01T00:00:00.000Z")).toBeCloseTo(
      0.004575,
      10,
    );
    expect(estimateCostUsd("gpt-5.6-luna", USAGE, "2026-08-01T00:00:00.000Z")).toBeCloseTo(
      0.001375,
      10,
    );
  });

  it("Sol and base gpt-5.6 are unchanged by the cut (still one entry)", () => {
    expect(findModelPricing("gpt-5.6-sol", "2026-07-01T00:00:00.000Z")).toEqual(
      findModelPricing("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
    );
  });

  it("cacheReadRatePerToken accepts a timestamp (equal values today — cache rates carried over)", () => {
    expect(cacheReadRatePerToken("gpt-5.6-luna", 1000, "2026-07-01T00:00:00.000Z")).toBe(1e-7);
    expect(cacheReadRatePerToken("gpt-5.6-luna", 1000, "2026-08-01T00:00:00.000Z")).toBe(1e-7);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @junrei/core exec vitest run src/shared/pricing/pricing.test.ts`
Expected: FAIL — the boundary tests get the same (old) rates on both sides.

- [ ] **Step 3: Append the new entries to `prices.json`**

In `prices.json`, the `"gpt-5.6-terra"` and `"gpt-5.6-luna"` values are (after Task 1) one-element arrays. Append a second object to each — the number formatting below matches `JSON.stringify` output exactly (JS renders magnitudes < 1e-6 in exponential form), so a later script rewrite won't reformat these lines:

```jsonc
// second element of "gpt-5.6-terra":
{
  "valid_from": "2026-07-30",
  "fetched_at": "2026-07-31T00:00:00.000Z",
  "input_cost_per_token": 0.000002,
  "output_cost_per_token": 0.000012,
  "cache_creation_input_token_cost": 0.000003125,
  "cache_read_input_token_cost": 2.5e-7
}
// second element of "gpt-5.6-luna":
{
  "valid_from": "2026-07-30",
  "fetched_at": "2026-07-31T00:00:00.000Z",
  "input_cost_per_token": 2e-7,
  "output_cost_per_token": 0.0000012,
  "cache_creation_input_token_cost": 0.00000125,
  "cache_read_input_token_cost": 1e-7
}
```

(Source: OpenAI's 2026-07-30 announcement — Luna $1→$0.20 in / $6→$1.20 out per MTok, Terra $2.50→$2 / $15→$12; cache fields deliberately carried over, per the spec. `gpt-5.6` and `gpt-5.6-sol` are untouched.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @junrei/core exec vitest run src/shared/pricing/pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/shared/pricing/prices.json packages/core/src/shared/pricing/pricing.test.ts
git commit -m "feat(core): record GPT-5.6 Luna/Terra 2026-07-30 price cut"
```

---

### Task 3: Wire timestamps through Claude-session cost sites

**Files:**
- Modify: `packages/core/src/claude/timeline.ts:423-426` and `:759-762`
- Modify: `packages/core/src/claude/metrics.ts:40` and `:157-158`
- Modify: `packages/core/src/claude/evaluation-trace.ts:342-351` and `:363`
- Test: `packages/core/src/claude/metrics.test.ts`

**Interfaces:**
- Consumes: `estimateCostComponents` / `estimateCostUsd` with the optional `timestamp` (Task 1); `gpt-5.6-luna` two-entry history (Task 2). `ApiMessage`/`AssistantRecord` already carry `timestamp?: string`.
- Produces: nothing new — behavior change only.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/claude/metrics.test.ts` (it already has `sessionDataWithMessages` and imports `computeUsage`):

```ts
describe("computeUsage — effective-dated pricing", () => {
  it("prices each message at the table entry in effect at its timestamp", () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 300,
    };
    const data = sessionDataWithMessages([
      { messageId: "m1", model: "gpt-5.6-luna", usage, timestamp: "2026-07-01T00:00:00.000Z", line: 1 },
      { messageId: "m2", model: "gpt-5.6-luna", usage, timestamp: "2026-08-01T00:00:00.000Z", line: 2 },
    ]);
    const summary = computeUsage(data);
    const luna = summary.byModel.find((m) => m.model === "gpt-5.6-luna");
    // Pre-cut message $0.004575 + post-cut message $0.001375 — NOT 2x either
    // (which is what a single flat table would produce).
    expect(luna?.costUsd).toBeCloseTo(0.00595, 10);
    expect(summary.total.costIsComplete).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @junrei/core exec vitest run src/claude/metrics.test.ts`
Expected: FAIL — both messages priced at the latest (post-cut) rates, total `0.00275`.

- [ ] **Step 3: Pass timestamps at all five sites**

`timeline.ts` `buildAssistantTextEntry` (~line 423) and `buildAssistantTextDetail` (~line 759) — third argument added:

```ts
      ? estimateCostUsd(record.model, usage, record.timestamp)
```

`metrics.ts` `computeUsage` (line 40):

```ts
    const cost = estimateCostComponents(model, message.usage, message.timestamp);
```

`metrics.ts` `computeTurnUsage` (~line 157):

```ts
    const costUsd =
      message.model !== undefined
        ? estimateCostUsd(message.model, message.usage, message.timestamp)
        : undefined;
```

`evaluation-trace.ts` `pricingEstimateOf` gains the parameter (keep its doc comment accurate):

```ts
function pricingEstimateOf(
  model: string | undefined,
  usage: TokenUsage | undefined,
  timestamp: string | undefined,
): { costUsd: number; costIsComplete: boolean } {
  if (model === undefined || usage === undefined) return { costUsd: 0, costIsComplete: false };
  const costUsd = estimateCostUsd(model, usage, timestamp);
  return costUsd === undefined
    ? { costUsd: 0, costIsComplete: false }
    : { costUsd, costIsComplete: true };
}
```

and its call site (line ~363):

```ts
    pricingEstimate: pricingEstimateOf(message.model, message.usage, message.timestamp),
```

- [ ] **Step 4: Run the core suite**

Run: `pnpm --filter @junrei/core exec vitest run`
Expected: PASS — the new test green; existing fixture tests unchanged (no Claude fixture uses a multi-entry model).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/claude/timeline.ts packages/core/src/claude/metrics.ts packages/core/src/claude/evaluation-trace.ts packages/core/src/claude/metrics.test.ts
git commit -m "feat(core): price Claude-session messages at their timestamps"
```

---

### Task 4: Wire timestamps through Codex per-model aggregates

**Files:**
- Modify: `packages/core/src/codex/analyze.ts` (`ModelAccumulator` ~line 106, the `token_count` branch ~line 336, `buildUsageSummary` ~line 142)
- Create: `packages/core/test/fixtures/codex/pricing/rollout-2026-07-15T09-00-00-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl`
- Test: `packages/core/src/codex/analyze.test.ts`

**Interfaces:**
- Consumes: `estimateCostComponents(model, usage, timestamp?)` (Task 1), Luna two-entry history (Task 2), `analyzeFixtureAt` helper already in `analyze.test.ts`.
- Produces: `ModelAccumulator.firstTimestamp?: string` (internal to `analyze.ts`).

The fixture is deliberately dated **2026-07-15, before the cut**: without the
wiring, the undated lookup resolves to the LATEST (post-cut) entry and the
test goes red; with the wiring it prices at the old rates and goes green — a
real red→green cycle (a post-cut fixture couldn't distinguish the two).

- [ ] **Step 1: Create the fixture**

Write `packages/core/test/fixtures/codex/pricing/rollout-2026-07-15T09-00-00-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl` (a minimal pre-cut Luna session; shapes mirror the existing `sessions/2026/07/01` fixture):

```jsonl
{"timestamp":"2026-07-15T09:00:00.000Z","type":"session_meta","payload":{"id":"ffffffff-ffff-ffff-ffff-ffffffffffff","cwd":"/Users/test/codex-proj","originator":"codex_cli_rs","cli_version":"0.144.2","source":"exec"}}
{"timestamp":"2026-07-15T09:00:01.000Z","type":"turn_context","payload":{"turn_id":"turn-1","cwd":"/Users/test/codex-proj","model":"gpt-5.6-luna","effort":"medium"}}
{"timestamp":"2026-07-15T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"Quick check."}}
{"timestamp":"2026-07-15T09:00:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":300,"reasoning_output_tokens":50,"total_tokens":1300},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":300,"reasoning_output_tokens":50,"total_tokens":1300}}}}
{"timestamp":"2026-07-15T09:00:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","last_agent_message":"Done.","duration_ms":6000}}
```

- [ ] **Step 2: Write the failing test**

Append to `packages/core/src/codex/analyze.test.ts`:

```ts
describe("effective-dated pricing (GPT-5.6 Luna cut, 2026-07-30)", () => {
  it("prices a pre-cut Luna session at the rates in effect at its first-seen timestamp", async () => {
    const analysis = await analyzeFixtureAt(
      "../../test/fixtures/codex/pricing/rollout-2026-07-15T09-00-00-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    );
    const luna = analysis.usage.byModel.find((m) => m.model === "gpt-5.6-luna");
    // Old (pre-cut) rates: input 800 (1000 - 200 cached) * 1e-6
    //   + output 300 * 6e-6 + cacheRead 200 * 1e-7
    //   = 0.0008 + 0.0018 + 0.00002 = 0.00262.
    // An undated lookup would price at the latest (post-cut) entry: 0.00054.
    expect(luna?.costUsd).toBeCloseTo(0.00262, 10);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @junrei/core exec vitest run src/codex/analyze.test.ts`
Expected: FAIL — without the wiring the aggregate is priced undated, i.e. at the latest (post-cut) entry, giving `0.00054` instead of `0.00262`.

- [ ] **Step 4: Implement the accumulator timestamp**

In `analyze.ts`, extend the interface (~line 106):

```ts
interface ModelAccumulator {
  model: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Timestamp of the first usage-bearing record this accumulator absorbed.
   * Codex costs are computed on per-model AGGREGATES (not per message), so
   * the whole aggregate is priced at this instant — a deliberate
   * approximation: a session spanning a price boundary misprices its tail,
   * acceptable at day-granularity price changes vs. hours-long sessions.
   */
  firstTimestamp?: string;
}
```

In the `token_count` branch, right after `addUsage(active.accumulator, delta);` (~line 336):

```ts
            active.accumulator.firstTimestamp ??= record.timestamp;
```

In `buildUsageSummary` (~line 142):

```ts
    const cost = estimateCostComponents(acc.model, usage, acc.firstTimestamp);
```

- [ ] **Step 5: Run the codex suite, then the full core suite**

Run: `pnpm --filter @junrei/core exec vitest run src/codex/ && pnpm --filter @junrei/core exec vitest run`
Expected: PASS — the new test green; the existing `files-skills` fixture (2026-07-14, `gpt-5.6-sol`, single-entry) and all other fixtures are numerically unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/codex/analyze.ts packages/core/src/codex/analyze.test.ts packages/core/test/fixtures/codex/pricing/
git commit -m "feat(core): price Codex per-model usage at first-seen timestamp"
```

---

### Task 5: Wire timestamps through the what-if simulator

**Files:**
- Modify: `packages/core/src/insight/whatIf.ts` (`WhatIfTimelinePoint` ~line 43, `priceMessage` ~line 162, `summarize` ~line 181)
- Modify: `packages/server/src/insight.ts` (`whatIfTimelineOf` ~line 258)
- Test: `packages/core/src/insight/whatIf.test.ts`

**Interfaces:**
- Consumes: `cacheReadRatePerToken(model, contextTokens, timestamp?)` (Task 1). `ContextPoint` (in `packages/core/src/shared/metrics.ts:130-137`) already has `timestamp?: string`.
- Produces: `WhatIfTimelinePoint.timestamp?: string` (optional — server callers may omit it).

No red phase is possible for this task: today's real price histories carry
identical cache-read rates across entries (the Luna/Terra cut published only
input/output), so no fixture can make the dated and undated paths price a
what-if differently — and structural typing means the extra `timestamp`
property compiles even before the type gains it. Date sensitivity of the
underlying rate lookup is already locked by Task 2's boundary tests; here we
add the pass-through plus a pinned regression test.

- [ ] **Step 1: Write the regression test**

Append inside the `"buildWhatIf — compaction policy (D1)"` describe block in `whatIf.test.ts` (`MODEL`/`RATE`/`compaction` are the file's existing helpers):

```ts
  it("timestamps on timeline points don't change pricing for single-entry models", () => {
    // Value-level date sensitivity is covered by pricing.test.ts (Luna/Terra
    // boundary tests); real models currently have identical cache-read rates
    // across entries, so this locks in the pass-through + no-regression.
    const timeline = [10, 50, 110, 150, 210, 250].map((t, i) => ({
      contextTokens: t,
      model: MODEL,
      timestamp: `2026-07-0${i + 1}T00:00:00.000Z`,
    }));
    const c = compaction(
      buildWhatIf({ timeline, compactionThresholdTokens: 100, compactionBaselineTokens: 10 }),
    );
    expect(c.estSavedTokens).toBe(600);
    expect(c.estSavedUsd).toBeCloseTo(600 * RATE, 12);
  });
```

- [ ] **Step 2: Run it to confirm the green baseline**

Run: `pnpm --filter @junrei/core exec vitest run src/insight/whatIf.test.ts`
Expected: PASS already (see the note above — this test pins behavior that must survive Step 3; it cannot go red first).

- [ ] **Step 3: Implement the pass-through**

`whatIf.ts` — extend the point type:

```ts
export interface WhatIfTimelinePoint {
  /** input + cache_read + cache_creation at this message (`ContextPoint.contextTokens`). */
  contextTokens: number;
  /** Owning model, when derivable; else the builder's `fallbackModel` prices this point. */
  model?: string;
  /** Record timestamp (`ContextPoint.timestamp`) — selects the price-table entry in effect for this point; omitted ⇒ latest entry. */
  timestamp?: string;
  /** 1-based source line — anchors where a heavy result appeared on the series (scenario 2). */
  line?: number;
}
```

`priceMessage` gains the parameter:

```ts
function priceMessage(
  contextTokens: number,
  model: string | undefined,
  timestamp: string | undefined,
): number | undefined {
  if (model === undefined) return undefined;
  const rate = cacheReadRatePerToken(model, contextTokens, timestamp);
  return rate === undefined ? undefined : contextTokens * rate;
}
```

`summarize`'s loop passes each point's own timestamp:

```ts
    const realPriced = priceMessage(real, model, point.timestamp);
    const cfPriced = priceMessage(counter, model, point.timestamp);
```

`packages/server/src/insight.ts` `whatIfTimelineOf` copies the timestamp through (and update its doc comment's "carries no model" note to mention the timestamp is forwarded):

```ts
function whatIfTimelineOf(a: AnyAnalysis): WhatIfTimelinePoint[] {
  return a.contextTimeline.map((p) => ({
    contextTokens: p.contextTokens,
    line: p.line,
    ...(p.timestamp !== undefined && { timestamp: p.timestamp }),
  }));
}
```

- [ ] **Step 4: Run the insight suite + server typecheck**

Run: `pnpm --filter @junrei/core exec vitest run src/insight/ && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/insight/whatIf.ts packages/server/src/insight.ts packages/core/src/insight/whatIf.test.ts
git commit -m "feat(core): what-if simulator prices points at their timestamps"
```

---

### Task 6: Append-only LiteLLM sync script

**Files:**
- Rewrite: `scripts/update-pricing.mjs`
- Create: `scripts/update-pricing.test.mjs`

**Interfaces:**
- Consumes: Task 1's `prices.json` history shape.
- Produces (exact exports the tests and workflow rely on):
  - `extractCurrentRates(raw: object): Record<string, Rates>` — LiteLLM table → kept-field rates for tracked models (Claude + `gpt-5*` + aliases), bare ids, aliases filled from targets
  - `mergePricingHistory(existing, fetched, fetchDate, fetchedAtIso): { models, appended: Array<{model: string, valid_from: string | null}> }` — pure, append-only
  - `formatSummary(appended, existing, merged): string` — markdown old→new table (`""` when nothing appended)
  - CLI behavior: writes `prices.json` only when something was appended; prints the summary (or `No pricing changes.`); exits non-zero on a same-day rate conflict

- [ ] **Step 1: Write the failing tests**

Create `scripts/update-pricing.test.mjs`:

```js
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

test("extractCurrentRates filters, normalizes and aliases like the legacy script", () => {
  const raw = {
    "gpt-5.4": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, litellm_provider: "openai" },
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/update-pricing.test.mjs`
Expected: FAIL — the named exports don't exist yet. (The legacy script's top-level `await fetch` must be gone before this import is safe; that's part of Step 3's rewrite.)

- [ ] **Step 3: Rewrite `scripts/update-pricing.mjs`**

Full replacement (keeps `SOURCE_URL`, `MODEL_ALIASES` — including its explanatory comment block — and `KEPT_FIELDS` verbatim from the current script; only the shape of the work changes):

```js
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
    const latest = latestEntryOf(history);
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
```

(The `import.meta.url` main-guard matches `scripts/gate.mjs:78` / `scripts/ship-pr.mjs:196` — importing from the test file must not trigger the fetch.)

- [ ] **Step 4: Run the script tests**

Run: `node --test scripts/update-pricing.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Smoke-run the CLI against the live table, then revert**

Run: `node scripts/update-pricing.mjs && git diff --stat`
Expected: either `No pricing changes.` with an empty diff, or a markdown table plus a `prices.json` diff of appended entries (LiteLLM may have ingested the Luna/Terra cut by now — if its cache rates differ from our carried-over values it may append OR hit the same-day-conflict error; both are the designed behavior, surfaced for human review). Then discard whatever the smoke-run changed:

```bash
git checkout -- packages/core/src/shared/pricing/prices.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/update-pricing.mjs scripts/update-pricing.test.mjs
git commit -m "feat(scripts): append-only LiteLLM pricing sync with history merge"
```

---

### Task 7: Daily pricing-sync workflow

**Files:**
- Create: `.github/workflows/update-pricing.yaml`

**Interfaces:**
- Consumes: Task 6's CLI behavior (writes `prices.json` only on change; prints the markdown summary; non-zero exit on same-day conflict).
- Produces: a scheduled PR when prices diverge.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/update-pricing.yaml` (checkout SHA matches `ci.yaml`; no aqua/pnpm — the script is dependency-free node, and the runner's node ≥ 20 has `fetch`):

```yaml
name: update-pricing

on:
  schedule:
    # Daily — keeps the worst-case "valid_from = fetch date" error small,
    # given LiteLLM has no ingestion SLA for provider price changes.
    - cron: "30 5 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - name: Sync pricing from LiteLLM
        run: node scripts/update-pricing.mjs | tee /tmp/pricing-summary.md
      - name: Open PR when prices diverged
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if git diff --quiet; then
            echo "No pricing changes — nothing to do."
            exit 0
          fi
          day="$(date -u +%Y-%m-%d)"
          branch="chore/pricing-update-$(date -u +%Y%m%d)"
          git checkout -b "$branch"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add packages/core/src/shared/pricing/prices.json
          git commit -m "chore(pricing): sync LiteLLM price changes ($day)"
          git push -u origin "$branch"
          {
            echo "Automated LiteLLM pricing sync — appended effective-dated entries:"
            echo
            cat /tmp/pricing-summary.md
            echo
            echo "## Before merging"
            echo "- [ ] Verify each \`valid_from\` against the provider's announced effective date; amend the entry if LiteLLM ingested the change late."
            echo "- [ ] If a change belongs to an existing same-dated manual entry (e.g. cache rates published after a cut), fold it into that entry instead of keeping a separate appended one."
            echo
            echo "_PRs opened with the default GITHUB_TOKEN don't trigger CI — close and reopen this PR (or push an empty commit) to start checks._"
          } > /tmp/pr-body.md
          gh pr create --title "chore(pricing): LiteLLM price sync $day" --body-file /tmp/pr-body.md
```

Known accepted papercuts (documented here so nobody "fixes" them into complexity):
- A same-day rerun fails at `git push` (branch exists) — fine, the day's PR already exists.
- If yesterday's sync PR is still unmerged, today's PR contains yesterday's diff too (both branch from `main`) — merge the newest, close the rest.
- The same-day-conflict error from the script fails the first step loudly in the Actions UI — that IS the signal a human must amend an entry manually.

- [ ] **Step 2: Validate the YAML**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/update-pricing.yaml || node -e "const y=require('fs').readFileSync('.github/workflows/update-pricing.yaml','utf8'); if(!y.includes('workflow_dispatch')) process.exit(1); console.log('yaml present; actionlint unavailable — verify via workflow_dispatch after merge')"`
Expected: actionlint passes, or the fallback prints its note. After the PR merges, trigger `workflow_dispatch` once from the Actions tab as the real acceptance check.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/update-pricing.yaml
git commit -m "ci: daily pricing-sync workflow opening diff PRs"
```

---

### Task 8: Roadmap note + full gates

**Files:**
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the final, gate-clean branch.

- [ ] **Step 1: Update the roadmap**

Read `docs/roadmap.md` and add an entry following its existing format/section conventions (CLAUDE.md: "keep roadmap.md updated as features land") — one line noting effective-dated model pricing + daily LiteLLM sync PR workflow landed, referencing `docs/superpowers/specs/2026-07-31-effective-dated-pricing-design.md`.

- [ ] **Step 2: Run the full quality gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS (`pnpm test` also runs `node --test scripts/*.test.mjs`, picking up Task 6's tests, and `ruby scripts/validate-skills.rb`). If biome complains about formatting in touched files, run `pnpm format` and re-run lint.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs: roadmap entry for effective-dated pricing"
```

---

## Post-merge follow-up (not part of this branch)

- Trigger `update-pricing` once via `workflow_dispatch` to prove the cron path end-to-end.
- When LiteLLM publishes post-cut Luna/Terra **cache** rates, the cron PR will surface them; fold them into the existing `valid_from: "2026-07-30"` entries (same effective date — amend, don't append), per the spec.
