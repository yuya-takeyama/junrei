# Coding-agent cost-performance playbook

The operational playbook for running coding-agent sessions cost-efficiently in
this repo. Rules are stated as standing practice; every figure and citation
behind them, plus the dated study that produced them, lives in
[research/2026-07-cost-performance-study.md](./research/2026-07-cost-performance-study.md).

Two evidence tags appear throughout:

- **MEASURED** — computed from Junrei session data or quoted verbatim from a
  primary source.
- **JUDGED** — a qualitative attribution, not a directly measured line item.

## 0. What to stop believing

A prior read blamed "the shape of delegation" (a ~19× cost gap) as the primary
driver. That causal reading was too coarse. The refutations (research doc §C):

- **Fan-out width is not the primary driver.** Per-subagent economics are
  nearly identical between an expensive and a cheap twin ($16.65/264tc vs
  $14.84/201tc). What matters is the subagent **tier** and its **turn budget**,
  not the number of workers.
- **Fat subagent returns do not bloat the orchestrator (MEASURED).**
  Main-thread `tool_result` totals only ≈48K tokens. The real driver is
  229–243 turns × a never-compacted 457–654K context.
- **Bash duplicate dollars are thin.** Direct bash spend is ≈$1.27. Duplicate
  reruns matter only as a *signal* of re-exploration (context inflation), not
  as recoverable spend.
- **Harness/error friction is <1%.** The gap is structural (method), not error
  churn.
- **High main% is not inherently bad.** At small scope (ctx <150K, <30 msgs) a
  100%-main session still costs only $0.4–7.4. main% is a risk factor only when
  combined with high context lifetime and turn count.

## 1. Diagnosis protocol — classify before prescribing

Classify the session by main-loop cost share
(`delegation.main.costUsd / totalUsage.costUsd`) FIRST, then pick levers.
Across the studied corpus, `compactions` was empty in every session — treat
that as the common failure background, not a per-archetype signal.

| Archetype | Test | Example | Levers |
|---|---|---|---|
| **MARATHON** | main ≥85% | $131/ctx482K (factorx 262h), $114/ctx654K | R1, R2 |
| **FAN-OUT** | main ≤55% | $222 (sonnet impl team $108), $208 (opus team $99) | R3, R4 |
| **MIXED** | in between | $195 (main $106 AND sub $88) | both |

## 2. The rules

### R1. Cap the orchestrator's context lifetime — the single biggest lever
- **Evidence (internal, MEASURED)**: compaction never fires; context climbs
  monotonically to 400–650K. cacheRead accumulates as turns × context size
  (pair-c 63.5M cacheRead, JUDGED ~50% of that session's cost).
- **Evidence (external, independent)**: context rot — recall degrades as
  occupancy rises (Chroma replication). Cost and quality point the same way.
- **Practice**: split the session or compact once per PR. Alarm above 200K ctx.
- **Verify-signal**: ctxMax < 200K; main-loop cacheRead/turn flattens instead
  of rising.

### R2. Do not marathon a multi-PR goal
- **Evidence**: `/goal "do it all"` 6.6h hot loops and 22h mixed sessions are
  the main source of $100+ main-loop lines.
- **Practice**: one PR = one session.
- **Verify-signal**: no single sessionId ships ≥3 PRs with 0 compactions.

### R3. Set the subagent tier by task risk
- **Evidence (MEASURED)**: opus subagent $0.13/msg vs sonnet $0.027/msg (**5×**).
  In the self-autopsy the opus team alone was $99 (48% of the session). Cheap
  twins used Haiku for exploration ($0.73).
- **Practice**: opus = adversarial review only. Implementation, verification,
  and inventory go to sonnet/haiku. (14-day baseline still holds: sonnet 98.7%
  success / $1.85; haiku 100% / $0.23.)
- **Hold (D2)**: whether opus→sonnet review loses catch-rate is unverified — a
  cheap experiment is queued.
- **Verify-signal**: cost-per-message by model; opus message share falls with
  deliverable count held constant.

### R4. Bound the subagent turn budget
- **Evidence (MEASURED)**: a 252-tool-call implementer accumulated 88.4M
  cacheRead (cacheRead scales with **turns**). Cheap-twin implementers ran <20
  turns.
- **Practice**: state a ~60-tool-call budget in every spawn prompt; treat >150
  as a design failure to revisit in retro.
- **Verify-signal**: distribution of subagent `toolCallCount`; no agent >150 tc.

### R5. Control flow in code, model for bounded reasoning (workflow-as-code)
- **Evidence (external, two independent papers)**: when code owns sequencing,
  pass rate roughly **doubles** over the strongest agentic baseline and
  constraint violations drop 275→11. **Writing the same constraints into the
  prompt does not recover the gap (ablation-proven).**
- **Evidence (internal)**: a Workflow-engine-led session (Workflow=10/Agent=7)
  held main to 27%; 35 manual Agent spawns cost $222.
- **Hold (D4)**: scope is confounded; a same-task comparison is queued.
- **Verify-signal**: Workflow:Agent ratio; main% falls as Workflow share rises.

### R6. Verify once per PR — do not distribute re-exploration
- **Evidence (MEASURED)**: the expensive twin ran grep×760 (near-dup×93) and
  duplicated gates test×34/typecheck×25; the cheap twin ran 370.
- **Practice**: run quality gates once, after implementation. Build the repo
  map once and inject it into spawn prompts (B5). Do not make agents re-derive
  numbers the engine already computed (one session spent 381s "independently
  verifying" Junrei's own metrics).
- **Verify-signal**: `bashStats.waste.nearDuplicates`; gate invocations ≤ PR
  count.

### R7. Read in parallel, write in series; returns are conclusions only
- **Evidence (external)**: 1,000–2,000-token return contract (Anthropic) +
  Cognition's counter (parallel writes lose context) → parallelize reads,
  serialize writes.
- **Evidence (internal, C2)**: return size was NOT a measured driver. Keep the
  contract, but do not over-invest in shrinking returns.
- **Verify-signal**: subagents return verdicts/summaries/file:line, never raw
  logs or dumps.

### R8. Release heavy visual data after the verifying turn
- **Evidence (MEASURED)**: 9 screenshots = 1.67MB base64 were re-read every
  turn (one 772KB). Do not pin verified images in context (B4).
- **Verify-signal**: no large image tool_result persists past its verifying
  turn.

### R9. Cache-aware fan-out
- **Evidence (external, 3-0)**: cache read 0.1× / write 1.25–2×. **Spawning N
  workers simultaneously onto a cold shared prefix makes all N pay write price.**
  Launch one worker first to warm the shared prefix, then fan out the rest. A
  write breaks even after 1–2 re-reads, but only within the TTL.
- **Verify-signal**: first spawn's response has begun (or the prefix is within
  TTL) before the rest launch.

### R10. Procedures to deterministic tools; analysis to code execution
- **Procedures**: a ship-pr script (rebase→CI→merge, replacing 8–11 shepherd
  spawns), a pre-commit format+lint gate (replacing ~7 whack-a-mole cycles per
  feature), a bootstrap script (one session spent 4.4min hunting `gh`).
- **Analysis**: heavy MCP call sequences move into a code-execution pattern that
  keeps intermediate results in the sandbox (vendor 150K→2K; independently
  measured **−78.5%** input tokens). The repo's own dogfood node scripts already
  had this shape — adopt it formally.
- **Verify-signal**: procedural spawns replaced by a single script invocation;
  MCP-heavy analysis keeps intermediates out of context.

### R11. Closed eval-transcript loop rewrites the tools themselves
- **Evidence (external)**: on Anthropic's internal benchmarks, transcript-driven
  self-optimization beat expert-written tools (Slack ~67→80%). The Junrei
  learnings ledger → skill/tool revision loop is this pattern.
- **Verify-signal**: eval transcripts feed back into tool/skill revisions, and
  `review_learnings` measures whether the change helped.

## 3. Deterministic-tool backlog (priority order)

| # | Tool | Behavior it replaces | Class |
|---|---|---|---|
| B1 | Per-PR context reset / auto-compact hook | never-compacted marathon | **XL** |
| B2 | `ship-pr` script | 8–11 shepherd spawns + CI watch | M |
| B3 | pre-commit format+lint single gate | lint whack-a-mole ~7×/feature | M |
| B4 | Evict post-verify screenshots / large tool_results | 1.67MB re-read every turn | L–M |
| B5 | Repo-map generator (Haiku, cached) | 1278 bash re-exploration calls | M |
| B6 | Env bootstrap (`aqua i -l`) | 4.4min env-hunt before first edit | S |
| B7 | Route marathon-shaped work to a cheaper model / Codex | Fable-for-everything (Codex same shape $7–12 vs $131, D3) | XL |

## 4. Verification queue (cheapest first)

- **D1** — Does one compaction per PR ~halve the tail? Re-simulate pair-c/pair-b
  from `contextTimeline` with a per-merge context reset (no live run).
- **D5** — Screenshot-eviction savings? Recompute pair-c cacheRead delta
  assuming images were dropped after their verifying turn (no live run).
- **D2** — Does opus→sonnet review keep catch-rate? Re-run one opus workflow on
  sonnet in a throwaway worktree; compare defects + cost.
- **D4** — Workflow vs manual spawn, same phase graph? Implement one 3-phase PR
  both ways in one worktree; compare main-loop cost.
- **D3** — Is Codex cheaper at equal scope? Run one identical task (aqua bump)
  on Fable-main vs Codex Terra; compare $ and correctness.

## 5. Method note — the coupled loop

The largest lever (R1) appeared in no quantitative summary because that metric
did not exist; only a qualitative deep read found it. Yet the quantitative data
is what refuted the deep readers' own wrong hypotheses (§0). The method is a
coupled loop: **qualitative reading discovers a structure → promote it to a
deterministic metric → quantitative monitoring watches it from then on.**
Promoting archetype classification, context lifetime, opus-message ratio, and
turn-budget distribution to first-class metrics is the direction of Junrei's
next briefing work.
</content>
