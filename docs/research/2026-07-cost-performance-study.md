# Coding-agent cost-performance study (2026-07)

Archival research report, 2026-07-20. The durable record behind the
operational playbook in [../cost-playbook.md](../cost-playbook.md). This
document preserves the full provenance — the 13 externally-verified findings
with their citations and votes, and the internal deep-read cluster with its
session-id and line-number evidence. The playbook states the resulting rules
as standing practice; this report is where each rule's evidence lives.

Two evidence tags run through the study and must be read literally:

- **MEASURED** — a figure computed from Junrei's own session data (token
  counts × the bundled pricing snapshot) or quoted verbatim from a primary
  vendor/paper source. Junrei dollar figures are pricing-table estimates and a
  lower bound (hidden/background API calls are structurally undercounted).
- **JUDGED** — a qualitative attribution made by a deep-reader (e.g. "~50% of
  this session's cost was cache reads"), not a directly measured line item.

## Method

### External: deep research with adversarial verification

A 103-agent deep-research fan-out with 3-vote adversarial verification. Every
surviving claim carries a vote (e.g. `3-0`), a confidence class
(`high`/`medium`), its source URLs, and an evidence note recording what was
verified verbatim and what remains vendor-internal or unreplicated. Thirteen
findings survived. The synthesis authority's own summary:

> The strongest evidence-backed lever for LLM coding-agent cost-performance is
> moving work out of the model into code at three levels: tool interaction
> (code execution with MCP / Programmatic Tool Calling — vendor-illustrated
> 150K→2K tokens, vendor-measured 37% reduction, independently measured ~78.5%
> input-token reduction), tool loading (just-in-time via filesystem or Tool
> Search Tool — 85% definition-token reduction plus vendor-measured accuracy
> gains of up to +25pp), and workflow control flow (deterministic code owning
> sequencing/branching — nearly 2x pass rate over the best agentic baseline on
> TravelPlanner, with an ablation showing prompted constraints cannot
> substitute for code-enforced ones). Context-engineering economics rest on
> two verified mechanisms: context rot (independently replicated recall
> degradation with context occupancy) justifying compaction, minimal spawn
> prompts, and 1,000–2,000-token subagent return contracts; and prompt-cache
> pricing (0.1x reads vs 1.25x/2x writes) which rewards stable shared prefixes
> but punishes simultaneous fan-out onto a cold cache — serialize the first
> spawn to warm the cache before fanning out. The evaluation-loop finding is
> that closed transcript-driven optimization (feeding eval transcripts back to
> the model to rewrite its own tools) beat expert human tool implementations
> on Anthropic's internal held-out benchmarks. Most quantitative claims are
> vendor-measured or illustrative rather than independently replicated; the
> areas with the strongest independent corroboration are context rot,
> code-execution token mechanics, and code-enforced constraints, while
> delegation-shape economics (model-tier routing, fan-out width, N-vote
> verification panels) remain essentially unmeasured in public sources.

### Internal: qualitative deep-read of session logs

Nine deep-readers over Junrei's own session corpus (MEASURED against the
Junrei API), each returning line-number evidence:

- **3 contrast pairs** — a HIGH-cost / LOW-cost twin each (pair-a, pair-b,
  pair-c).
- **3 autopsies** — autopsy-marathon, autopsy-self, autopsy-goshuin.
- **2 cross-section sweeps** — cross-a, cross-b (21 further sessions).
- **1 Codex cross-tool comparison**.

Universal facts across all 30+ sessions: `compactions: []` in **every single
session** (0/30+); orchestrator `contextTokens` peaks 150K–654K everywhere;
`apiErrors ≈ 0` everywhere. Full report journal: `wf_fde95be0-a67`.

## External findings (13)

Each finding is stated as verified, with its confidence class, vote, sources,
and evidence note.

### F1 — Caller-controlled response verbosity contract
**confidence: medium · vote: 3-0**

Design rule: give tool responses a caller-controlled verbosity contract (e.g.
a `response_format` enum of `concise` vs `detailed`). In Anthropic's
Slack-thread worked example, concise responses used ~1/3 the tokens (72 vs
206). Trade-off flagged in the source itself: concise mode drops IDs
(`thread_ts`, `channel_id`) needed for downstream tool calls, so the concise
default suits terminal reads and the detailed form suits chained workflows.

- Sources: https://www.anthropic.com/engineering/writing-tools-for-agents
- Evidence: Verified verbatim in the primary source (ResponseFormat enum,
  206-token vs 72-token payloads, "~1/3 of the tokens"). Measured token count
  of one illustrative payload, not a task-level benchmark; no independent
  replication, but third-party writeups restate the pattern consistently.

### F2 — Consolidate granular tools into workflow-level macro tools
**confidence: high · vote: 3-0**

Design rule: consolidate granular API-shaped tools into workflow-level "macro"
tools that execute the multi-step operation in code (`schedule_event`
replacing `list_users` + `list_events` + `create_event`; `search_logs`
replacing `read_logs`; `get_customer_context` replacing three lookup tools).
This is Anthropic's explicit, repeated recommendation for reducing round-trips
— the tool-design expression of moving prompt-driven multi-step behavior into
deterministic code.

- Sources: https://www.anthropic.com/engineering/writing-tools-for-agents ·
  https://www.anthropic.com/engineering/code-execution-with-mcp
- Evidence: Verified verbatim; the recommendation appears three times with
  parallel examples, is framed as "consider" (recommendation, not mandate),
  and is extended rather than retracted by the later code-execution-with-MCP
  post. Design guidance without a benchmark number, but no source disputes it
  and third-party summaries reproduce it.

### F3 — Closed eval-transcript loop beats expert-written tools
**confidence: medium · vote: 3-0**

Evaluation-loop finding: a closed loop that feeds evaluation transcripts back
to the model to rewrite its own tools extracted performance beyond expert
human tool engineering — on held-out test sets of Anthropic's internal Slack
and Asana tool benchmarks, Claude-optimized tool implementations outperformed
tools manually written by Anthropic researchers. Actionable recipe stated in
the source: concatenate eval-agent transcripts and paste them into Claude Code
to drive tool revisions.

- Sources: https://www.anthropic.com/engineering/writing-tools-for-agents
- Evidence: Verified verbatim including the held-out-test-set charts and the
  transcript-concatenation method. Vendor-measured on non-public internal
  benchmarks, no error bars or sample sizes, no independent replication —
  credible first-party measured evidence, not independently verified fact.
  Quantitative deltas live in chart images (~67%→80% Slack, ~80%→86% Asana per
  secondary summaries, unverified pixel-level).

### F4 — Code execution collapses tool-call token cost (150K→2K; ~78.5% independent)
**confidence: high · vote: 3-0 (merged from two unanimous claims)**

Direct tool-call architectures carry two identified cost mechanisms: (1) tool
definitions loaded upfront consume context (raising latency and cost), and (2)
every intermediate result of a multi-step workflow round-trips through the
model's context. Refactoring MCP interactions into code execution — the model
writes code that calls tools inside an execution environment — addressed both
in Anthropic's Google Drive→Salesforce worked example, dropping token usage
from 150,000 to 2,000 (98.7%). Treat 98.7% as a vendor illustrative estimate
for one scenario, not a benchmark; an independent arXiv study of MCP design
choices measured ~78.5% fewer input tokens for code execution vs direct tool
calls.

- Sources: https://www.anthropic.com/engineering/code-execution-with-mcp ·
  https://arxiv.org/pdf/2602.15945 · https://arxiv.org/abs/2511.07426
- Evidence: Both mechanisms and the 150K→2K sentence verified verbatim in the
  primary source (2025-11-04). Community critiques target whether
  MCP/code-execution is the right fix, not whether the cost mechanisms exist;
  arXiv 2511.07426 independently documents MCP token inflation and arXiv
  2602.15945 independently measured ~78.5% input-token reduction.
  Sandboxing/operational overhead is the acknowledged trade-off.

### F5 — Just-in-time tool loading beats preloading on cost AND accuracy
**confidence: high · vote: 3-0 (merged from three unanimous claims)**

Just-in-time tool loading beats preloading on both cost and accuracy.
Presenting tools as code files on a filesystem enables progressive disclosure
(read only needed definitions on demand); the productized form, Tool Search
Tool, cut tool-definition token usage ~85% in Anthropic's five-server MCP
example (~77K-token baseline → ~8.7K, preserving ~95% of context) — and
improved accuracy, not just cost: on internal MCP evals with large tool
libraries, Opus 4 went 49%→74% and Opus 4.5 went 79.5%→88.1% vs preloading.
Independently replicated in direction by Cloudflare Code Mode (~1.17M tokens
of definitions → ~1K via search+execute). Scope limits: Anthropic says the
benefit is small under ~10 tools / <10K definition tokens, and independent
stress tests show absolute retrieval accuracy degrades badly at 3–4K-tool
catalogs (Arcade.dev 56–64% at 4,027 tools; Stacklok 34% at 2,792).

- Sources: https://www.anthropic.com/engineering/code-execution-with-mcp ·
  https://www.anthropic.com/engineering/advanced-tool-use ·
  https://arxiv.org/abs/2505.03275
- Evidence: All figures verified verbatim in two primary Anthropic posts; the
  mechanism is near-mechanically true and independently corroborated
  (Cloudflare Code Mode measurement, RAG-MCP arXiv 2505.03275, shipped
  deferred-tool loading in Claude Code). Accuracy deltas are vendor-internal on
  an undisclosed eval, unreplicated externally — strong for the ~10–100-tool
  regime, qualified beyond that.

### F6 — Keep intermediate results out of context (in-sandbox filter; PTC −37%)
**confidence: high · vote: 3-0 (merged from two unanimous claims)**

Keep intermediate results out of model context by filtering/transforming in
the execution environment. Two verified patterns: (a) in-sandbox filtering of
large datasets (e.g. a 10,000-row spreadsheet never enters context); (b)
Programmatic Tool Calling — the model writes orchestration code so
intermediate tool results stay in the sandbox — reduced average token usage
37% (43,588→27,297) on complex research tasks in Anthropic's internal testing.
Boundary condition from the vendor's own data: PTC gives no benefit and ~8%
higher cost on sequential single-call workloads (tau-2-bench) — it pays on
multi-call, data-heavy tasks only.

- Sources: https://www.anthropic.com/engineering/code-execution-with-mcp ·
  https://www.anthropic.com/engineering/advanced-tool-use ·
  https://arxiv.org/pdf/2602.15945
- Evidence: Both the filtering pattern and the 37% figure verified verbatim in
  primary sources. The 37% is vendor-internal and unreplicated, but consistent
  adjacent measurements exist (~38% billed-input reduction on a 75-tool
  benchmark with unchanged accuracy; +11% accuracy / -24% input tokens on
  agentic search). The negative result on sequential workloads is disclosed by
  the vendor itself, which raises credibility.

### F7 — Workflow-as-code: deterministic source code owns control flow
**confidence: high · vote: 3-0 (merged from two unanimous claims)**

Workflow-as-code design rule (when the procedure is well-specified):
deterministic source code should own all control flow — looping, branching,
sequencing — with the LLM invoked only as a bounded tool for reasoning
sub-tasks, never to select the execution path. Two independent 2026 papers
converge on this: "Blueprint First, Model Second" (Source Code Agent, Alibaba)
and "LLM-as-Code" (CityU HK/Tencent), the latter articulating the mechanism
that compliance is no longer sampled — execution ordering becomes
deterministic by construction, shifting residual error to the reasoning steps
rather than the control flow. Scope: validated on procedurally well-defined,
constraint-intensive workflows, not open-ended coding.

- Sources: https://arxiv.org/html/2508.02721 ·
  https://arxiv.org/html/2606.15874v2
- Evidence: Both papers verified verbatim on the load-bearing sentences. The
  architectural argument is corroborated by at least four further 2025–2026
  works (CAAF, Deterministic Control Plane, Code-as-Harness survey) and matches
  Anthropic's workflows-vs-agents distinction. Both are industry-authored
  preprints, not peer-reviewed; the residual-risk qualification (LLM outputs
  feeding branch predicates can still route wrong) is noted by verifiers and
  does not contradict the scoped claim.

### F8 — Code-enforced logic beats prompt-injected logic (TravelPlanner, measured)
**confidence: medium · vote: 3-0 (merged from two unanimous claims)**

Measured evidence that code-enforced logic beats prompt-injected logic: on
TravelPlanner (1,000 tasks, Claude-Sonnet-4 backbone), the Source Code Agent
hit 35.56% final pass rate vs 18.00% for the strongest agentic baseline
(ATLAS) and cut constraint violations 275→11 (96%). Critically, the ablation
shows prompting cannot recover the gap: baselines given the identical
constraint set in their system prompts still scored far below SCA (ATLAS
24.50, CodeAct 19.00, ReAct 17.00 vs SCA 37.20 on constraint-satisfaction over
a 100-task stratified subset). Design rule: "knowing a rule and being
structurally unable to violate it are different properties" — put invariants
in guardrail code, not prompts.

- Sources: https://arxiv.org/html/2508.02721 ·
  https://arxiv.org/abs/2509.25586
- Evidence: All numbers verified against the primary preprint, and the ATLAS
  18.00% baseline independently cross-checks against ATLAS's own published
  table (arXiv 2509.25586) — not an in-house lowball. Caveats:
  non-peer-reviewed, authors evaluate their own framework, single benchmark
  domain, backbone-conditional gap (ATLAS+Gemini-2.5-Pro reaches 35.00%),
  ablation metric is constraint-satisfaction rate not final pass rate, and only
  one prompt intervention was tested — narrow "beyond prompt engineering" to
  "beyond constraint-set prompting".

### F9 — Subagent return-contract budget: 1,000–2,000 tokens
**confidence: medium · vote: 3-0**

Subagent return-contract budget: Anthropic's stated pattern is that each
subagent may burn tens of thousands of tokens exploring but returns only a
condensed 1,000–2,000-token summary to the orchestrator. This is the concrete
number to encode in spawn-prompt return contracts. Counter-position to weigh:
Cognition's "Don't Build Multi-Agents" argues compressed subagent returns lose
critical context and produce conflicting assumptions on write-heavy coding
tasks — so this contract fits read/research fan-out, not parallel writes.

- Sources:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  · https://cognition.ai/blog/dont-build-multi-agents
- Evidence: Quote verified verbatim; consistent with Anthropic's multi-agent
  research post (subagents ~15x chat token usage). The 1,000–2,000 figure is
  descriptive vendor guidance (observed typical range), not a measured optimum
  or hard budget; the architecture itself is credibly contested for
  write-heavy work.

### F10 — Context rot: recall degrades with context occupancy
**confidence: high · vote: 3-0**

Mechanism underwriting all minimal-context design: context rot — model recall
accuracy degrades as context-window occupancy grows, which Anthropic
attributes to n-squared attention and training-data sequence-length
distribution. This is the "why" behind compaction, lean spawn prompts, JIT
retrieval over preloading, and aggressive return-contract budgets. Degradation
appears specifically once distractors, non-lexical matching, or reasoning are
involved — the regime agent coding contexts occupy — even for models with
near-perfect simple needle-in-haystack recall at 1M tokens.

- Sources:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  · https://research.trychroma.com/context-rot · https://arxiv.org/abs/2307.03172
- Evidence: Quote and mechanism attribution verified verbatim; independently
  corroborated by Chroma's 18-model study, "Lost in the Middle" (TACL), and
  NoLiMa (10 of 12 models below half their short-context score by 32K). The
  n²+training-distribution mechanism is Anthropic's plausible explanation, not
  proven causality; the empirical degradation itself is multiply replicated.

### F11 — Task-characteristic routing for long-horizon work
**confidence: medium · vote: 3-0**

Task-characteristic routing rule for long-horizon work (Anthropic's
prescription, unmeasured): use context compaction for tasks needing extensive
back-and-forth; note-taking/external memory for iterative development with
clear milestones; multi-agent architectures only where parallel exploration
pays dividends (research/analysis). The multi-agent arm is contested for
write-heavy coding (Cognition: parallel sub-agents make conflicting
decisions), so read it as: parallelize reads and research, serialize writes.

- Sources:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  · https://cognition.ai/blog/dont-build-multi-agents
- Evidence: Three-way mapping verified verbatim. Qualitative design guidance
  with no quantitative three-way comparison anywhere in the source; compaction
  and note-taking are context-management techniques rather than delegation
  shapes, so this only partially answers the delegation-routing question. Still
  Anthropic's canonical guidance, not retracted.

### F12 — Cache economics: 0.1x reads vs 1.25x/2x writes
**confidence: high · vote: 3-0 (merged from three unanimous claims)**

Cache economics that govern spawn-prompt and fan-out design on the Claude API:
cache reads cost 0.1x base input (90% discount); cache writes carry a premium —
1.25x base for 5-minute TTL, 2x for 1-hour TTL. Arithmetic consequence
verified from the vendor's own numbers: each read saves 0.9x base vs resending,
so the 5-min write premium breaks even after 1 re-read and the 1-hour premium
after 2 — large stable spawn-prompt prefixes and tool definitions are cheap to
reuse but only if actually re-read within TTL. Multipliers stack with other
modifiers (batch discount, region premium), so effective prices can differ
from base × multiplier.

- Sources:
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching ·
  https://platform.claude.com/docs/en/about-claude/pricing
- Evidence: Verified verbatim on two separate live primary vendor doc pages
  (2026-07-20), with per-model dollar tables numerically confirming every
  multiplier; third-party 2026 write-ups repeat the same figures; no dispute
  found. Strongest possible source class for a pricing claim.

### F13 — Fan-out cache race: warm the cache before fanning out
**confidence: high · vote: 3-0**

Fan-out cache race — a directly actionable orchestration rule: a cache entry
only becomes usable after the first response begins, so N subagents spawned
simultaneously with a shared cold prompt prefix each pay full write-price input
(1.25–2x base) instead of 0.1x read price. Rule: warm the cache first — wait
for the first spawn's response to begin (or ensure the shared prefix was used
within TTL) before launching the rest of the fan-out.

- Sources:
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Evidence: Exact limitation text verified live in the Cache limitations
  section; identically mirrored in Anthropic's AWS Bedrock and Google Cloud
  docs and multiple third-party writeups. Self-disclosed vendor limitation,
  zero contradicting sources. Scope qualifier: the race applies only to a
  not-yet-cached prefix — pre-warmed prefixes within TTL allow parallel fan-out
  with cache reads and no serialization.

## Internal cluster synthesis

Full cross-read of the 9 deep-reads. Diagnose each session FIRST by main-loop
cost share (`delegation.main.costUsd / totalUsage.costUsd`).

**Two expensive archetypes:**

| Archetype | Rule | Example sessions | Lever |
|---|---|---|---|
| **MARATHON** (main ≥85%) | orchestrator-context-dominated | 781d621c $131/main100%/ctx482K; b56e4dc5 (pair-c) $114/main91%/ctx654K; d21f4600 $80/main99%/ctx474K; 5546dfc4 $30/main99%/ctx266K | A1, A2 |
| **FAN-OUT** (main ≤55%) | subagent-tier/turn-length-dominated | 4f800ea4 (pair-a) $222/main40%/sonnet-sub $108; 77bd3b76 (self) $208/main27%/opus-sub $99; d5a4288d (goshuin) $126/main38% | A4, A5 |
| **MIXED** (in between) | 52ee641f (pair-b) $195/main55% — orch $106 is the single biggest line AND subagents $88 | both |

Both archetypes share A1 (0 compactions, ctx 270–503K even in fan-out
sessions).

### A. Operational rules

**A1. Cap orchestrator context lifetime — auto-compact and/or per-PR reset.**
*(THE dominant lever.)*
- Impact: pair-c JUDGED ~50%+ of $113; pair-b est $40–55 avoidable. Impacts
  every session (all fan-out orchestrators also hit ctx 270–503K).
- Evidence: universal `compactions: []`; ctxMax 482K/654K/474K (marathon),
  cacheRead 63.5M (pair-c), 60.2M (pair-b); pair-b cache-write $37.63 on Fable
  alone.
- Confidence: multiple-sessions.
- Verify-signal: post-adoption ctxMax capped (<~200K) and main-loop
  `cacheReadTokens` + `costUsd/turn` flat instead of monotonically rising.

**A2. Split multi-PR goals into per-PR sessions; no `/goal "keep going till
all done"` marathon on the orchestrator.**
- Impact: converts MARATHON→FAN-OUT; addresses the $106 (pair-b), $103.6
  (pair-c) main lines.
- Evidence: pair-b `/goal` L868 → 6.6h hot loop; goshuin `/goal` L577
  "D→E→F一気に"; autopsy-marathon single prompt "全部自分でプレイしながらデバッグ"
  → 323-msg 100%-main thread.
- Confidence: multiple-sessions.
- Verify: flag any single sessionId shipping ≥3 PRs with 0 compactions; such
  sessions should split into multiple sessionIds.

**A3. Push implement→review→verify→fix into the Workflow engine, not manual
Fable `Agent` spawns.**
- Impact: fewer expensive orchestrator turns spent assembling templated spawn
  prompts.
- Evidence (`toolStats.callCount`): pair-a HIGH Agent=35/Workflow=4 ($222) vs
  LOW Agent=2/Workflow=5 ($111); pair-b HIGH Agent=29/Workflow=0 ($195) vs LOW
  Agent=7 ($34); autopsy-self Workflow=10/Agent=7 → main only 27% (the good
  example).
- Confidence: multiple-sessions (confounded by scope — see D4).
- Verify: Workflow:Agent ratio per session; main% should fall as Workflow
  share rises.

**A4. Tier the subagent MODEL to task risk — Opus only for adversarial review;
Sonnet/Haiku for implement, verify, inventory.**
- Impact: autopsy-self Opus subagents = $99 (48% of $208) at $0.13/msg vs
  Sonnet $0.027/msg (5×); routing half→Sonnet ≈ −$40.
- Evidence: autopsy-self byModel opus-sub $99/759msg; pair-a sonnet
  implementers $108 (49%); pair-b opus-review $15.4 + sonnet-impl $72.9; both
  LOW twins used Haiku mapping ($0.73 / $0.70).
- Confidence: multiple-sessions.
- Verify: cost-per-message by model; Opus message share ↓ with equal
  deliverable count and review catch-rate held (see D2).

**A5. Bound subagent turn budget — cacheRead scales with TURNS, not token
price.**
- Impact: caps the long-implementer tail that dominates fan-out cost.
- Evidence: pair-a top Sonnet implementer 252 tool-calls / 88.4M cacheRead /
  253 msgs; per-subagent economics otherwise match HIGH/LOW ($16.65/264tc ≈
  $14.84/201tc → fan-out itself earns its keep). LOW-twin opus implementers
  <20 turns.
- Confidence: multiple-sessions.
- Verify: distribution of subagent `toolCallCount`; flag agents >150 tc; cap
  ~60.

**A6. One Verify phase per PR — don't re-run quality gates per implementer,
don't re-explore per agent.**
- Impact: each redundant gate/grep result re-enters an expensive context (the
  cost is the context tax, not the bash $ — see C3).
- Evidence: pair-a bashStats 1278 calls (grep×760; near-dup "grep -n <STR>
  <PATH>|head" ×93) vs LOW 370; gate dups test×34/typecheck×25/lint×17; pair-c
  lint/format whack-a-mole ~7×/feature.
- Confidence: multiple-sessions.
- Verify: `bashStats.waste.nearDuplicates` count; test/typecheck/lint
  invocations ≤ PR count.

**A7. Trust the tool's own output — don't spawn hand-agents to re-derive what
the engine computes; ship fewer, larger PRs.**
- Impact: removes reflexive verification/ship subagents.
- Evidence: pair-c "Independently verify Junrei metrics" 381s + "Analyze
  session logs" 379s re-deriving engine numbers; pair-a 11 ship subagents / 9
  PRs; pair-b Opus review on all 7 diffs $15.4 + Sonnet UI-verify ×5 $7.4 incl.
  a near-empty spawn ($0.18/3tc). Tier review depth by diff risk; skip UI-verify
  on non-UI diffs.
- Confidence: multiple-sessions.
- Verify: ship/verify subagents per PR; count near-empty spawns (<5 tc).

### B. Deterministic-tool backlog (prompt→tool)

**B1. Auto-compact / per-PR context-reset hook.** Replaces the never-compacted
marathon. Evidence: universal cmp=0; ctx→482–654K. **Saving class: XL**
(dominant lever; implements A1).

**B2. Deterministic `ship-pr` script (rebase→CI-watch→merge→branch-cleanup).**
Replaces 8–11 pr-shepherd spawns + main-loop `gh pr checks --watch`. Evidence:
pair-a 11 ship agents / watch×10 / merge×9 / rebase×9; pair-b 8 shepherd spawns
($0.13–0.52, 12–19tc, pure procedure); pair-c watch×6 (L515/768/1054/1154/1599/
1784) / merge×5 / 8 "Watch CI" tasks. **Saving class: M** (removes Fable
narration turns + spawn assembly).

**B3. Deterministic pre-commit format+lint (single gate).** Replaces
lint/format whack-a-mole. Evidence: pair-c ~7× "Run checks→lint→auto-fix→re-run
→format" ≈20–25 main turns at 200–400K ctx; pair-a lint×17/typecheck×25.
**Saving class: M.**

**B4. Drop screenshots / large tool_results from context after their verifying
turn.** Replaces pinning them for the whole thread. Evidence: pair-c 9
screenshot tool_results = 1.67MB base64 (L1824=772KB, L1637=344KB, L1222=240KB)
+ L1834 = 564KB skill, all re-read every turn. **Saving class: L–M on
screenshot-heavy sessions.**

**B5. Shared repo-map generator (cheap Haiku, cached) injected into spawn
prompts.** Replaces per-agent re-exploration. Evidence: LOW-twin $0.73 Haiku
map vs HIGH 1278 bash re-explore. **Saving class: M.**

**B6. Repo bootstrap script (`aqua i -l`).** Replaces env-hunting before first
edit. Evidence: pair-c `timeToFirstEditMs=265,809` (4.4min) hunting `gh` via
mise shims / PATH / brew-then-uninstall. **Saving class: S but recurring.**

**B7. Route long mechanical/plumbing single-threads to a cheaper model or
Codex.** Replaces Fable-for-everything. Evidence: Codex gpt-5.5 marathons
$7–12 (`cacheCreationTokens:0`, `cacheWriteCostUsd:0`) at 139–225 tool-calls vs
Fable same shape $131; Claude-small sessions $5–10. **Saving class: XL for
marathon-shaped work** (see D3 caveat — borderline A/routing).

### C. Refuted or thinner-than-expected hypotheses

**C1. "Subagent fan-out is the primary cost driver" — REFUTED.** Per-subagent
economics match across pairs (pair-b HIGH $16.65/264tc ≈ LOW $14.84/201tc);
autopsy-self delegated well (main 27%) yet still cost $208 — the driver was the
Opus TIER, not fan-out. Fan-out per se earns its keep; the levers are
orchestrator lifetime (A1) + subagent tier/turn-length (A4/A5).

**C2. "Fat subagent RETURN payloads bloat the orchestrator" — REFUTED
(MEASURED).** pair-b: total main-thread `tool_result` ≈193K chars ≈48K tok. The
cost is 229–243 turns × never-compacted 457–654K context, not return size.

**C3. "Bash near-duplicate DOLLAR waste is a lever" — THIN.** Total bash cost
only $1.27 (pair-a HIGH) vs $0.76 (LOW); a typical near-dup opportunity saves
~$0.07 (`estUsdSaved`). Near-duplicates matter as a re-exploration SIGNAL that
inflates context, not as direct spend.

**C4. "Harness/error friction explains the gap" — REFUTED (<1%).** apiErrors 0
everywhere; toolErrors 6/217 (pair-b), 6 (pair-a), 14/386 (marathon). The gap
is structural (method), not error churn.

**C5. "pair-c is a real HIGH/LOW comparison" — REFUTED.** LOW a782481d = pure
no-op (1 turn, 0 tool-calls, $0, aborted at start), produced nothing, HIGH
restarted from scratch. Treat pair-c as a single-session autopsy, not a pair.

**C6. "High main% is inherently bad" — REFUTED at small scope.** cross-a
sessions run main 87–100% yet cost only $0.4–7.4 because ctxMax stayed <150K
and main msgs <30 (e.g. 6bd698e3 $6.5/main94%/ctx106K; 11b5691b
$4.2/main100%/ctx83K). main% is a risk factor only combined with high
ctxMax/turn count — argues against a naive "always delegate."

**Conflict noted:** pair-a's return calls "main-loop the #1 driver" (main
$89=40%) while its own subagents were 49% ($108 sonnet); autopsy-self is main
27% yet most expensive. Both true — resolved by the archetype split above: the
single largest LINE is main in MARATHON/MIXED sessions and subagent-tier in
FAN-OUT sessions. Diagnose per session before prescribing.

### D. Verification queue (cheapest experiment first)

**D1. Does one compaction per PR actually ~halve the tail?** (pair-c "~50%+",
pair-b "$40–55" are JUDGED.) Cheapest: recompute pair-c/pair-b cost from
`contextTimeline` with context reset to baseline at each post-merge line — no
new session, pure re-simulation of cacheRead at capped context.

**D2. Does Opus-sub→Sonnet-sub preserve review/impl quality?** Cheapest: re-run
ONE autopsy-self Opus workflow (e.g. `junrei-pr6-provenance-fix`) on Sonnet in
a throwaway worktree; compare defect catch-rate + cost. Single-session, low
cost.

**D3. Is Codex gpt-5.5 genuinely cheaper for equal SCOPE, or are its tasks just
smaller?** The $7–12 vs $131 gap conflates scope × model, and Codex
`contextTokens` accounting differs (ctxMax 8–14M, cacheCreation=0). Cheapest:
run one identical mechanical task (aqua version bump) on Fable-main vs Codex
Terra; compare $ and correctness.

**D4. Does the Workflow engine cost less than manual Agent for the SAME phase
graph?** A3 is confounded — pair-a HIGH (35 Agent) shipped 9 PRs, LOW (2 Agent)
shipped 2. Cheapest: implement one 3-phase PR twice (manual spawns vs Workflow)
in the same worktree; compare main-loop cost.

**D5. Does evicting screenshots after verify reduce cost without breaking later
reference?** Cheapest: recompute pair-c cacheRead delta assuming image results
L1824/L1637/L1222 were dropped after their verifying turn (from
`contextTimeline`) — no live run needed.

## Meta-conclusion — the coupled loop

Yuya's working hypothesis under test:

> "定量から確定的に言えるアドバイスは実は少なく、ログをエージェントで深く考察する
> ことでしかアイデアは出ない" — *quantitative summaries yield surprisingly few
> firm recommendations; ideas only emerge from an agent deeply reading the
> logs.*

**Verdict: essentially correct — but it does not fly on one wing.**

- The largest lever (A1: 0 compactions, ctx up to 654K) **appeared in no
  quantitative summary** — because that metric did not exist. Only the deep
  read discovered it.
- At the same time, it was the **quantitative** data that refuted the deep
  readers' own hypotheses (C1/C2/C4 were rejected by the numbers). The
  quantitative layer is essential both for aiming ("where to read") and for
  executing hunches ("killing assumptions").
- **The core of the method**: promote each structure the qualitative read
  discovers into a **new deterministic metric** (archetype classification, ctx
  lifetime, Opus-message ratio, turn-budget distribution) — and from then on it
  can be stated quantitatively with certainty. **Qualitative discovers →
  promote to a metric → quantitative monitors: the coupled loop is the
  answer.** This is precisely the direction of Junrei's next briefing features.
- Byproduct: public measured data on delegation economics barely exists in the
  world — this dataset has publication value.

## Sources

- **Internal**: pair-a/b/c, autopsy-marathon/self/goshuin, cross-a/b,
  codex-comparison (full report journal `wf_fde95be0-a67`, with line numbers).
- **External**: Anthropic writing-tools-for-agents / code-execution-with-mcp /
  effective-context-engineering / advanced-tool-use; arXiv 2508.02721 (Source
  Code Agent), 2606.15874 (LLM-as-Code), 2602.15945, 2511.07426, 2505.03275
  (RAG-MCP), 2509.25586 (ATLAS), 2307.03172 (Lost in the Middle);
  research.trychroma.com/context-rot; cognition.ai/blog/dont-build-multi-agents;
  platform.claude.com prompt-caching / pricing.
</content>
</invoke>
