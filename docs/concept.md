# Junrei — Concept & Information Architecture

> Status: v2 concept, 2026-07. Complements [design.md](./design.md) (v1 technical
> design). This document defines **why Junrei exists**, **what signals it
> surfaces**, and **how the UI is layered** — the basis for the next iteration
> of the web UI.

## 1. Mission

**Junrei helps developers get cost-effective results out of coding agents.**

Coding-agent usage has two coupled problems:

- **Cost** — the wrong model doing the wrong work. The key questions are:
  was the model matched to the task, and was the orchestration shape
  (delegation, parallelism, context isolation) appropriate?
- **Quality** — the wrong context reaching the model. The key questions are:
  were the right Skills and files loaded at the right time, and did the
  context stay healthy (no rot, no thrash, no lost instructions)?

Junrei's stance is unchanged from v1: it computes **logic-derived,
quantitative, reproducible signals only** and never scores or grades. The
human (or an agent reading Junrei over MCP) draws the conclusions. What v2
adds is a deliberate **signal model** grounded in Anthropic's published
research, and an **information hierarchy** that lets a session be examined
from several angles instead of one flat page.

The name is the metaphor: a session is a *junrei* (巡礼, pilgrimage) — a
journey with stations. Junrei lets you walk the route again, see where time
and tokens were spent, and where the path wandered.

## 2. Why these signals — research grounding

The signal model is anchored in Anthropic's own publications. Key findings
and what they imply for a log-derived analyzer:

### Cost / orchestration

From ["How we built our multi-agent research system"](https://www.anthropic.com/engineering/built-multi-agent-research-system):

- Token spend explains most performance variance (~80% in their BrowseComp
  evals); agents use ~4× chat tokens, multi-agent systems ~15×. **Token
  distribution — per agent, per model, per phase — is the primary lens,
  not just total cost.**
- Orchestrator-worker is the reference pattern: a strong lead model plans and
  synthesizes; workers execute in isolated contexts and return condensed
  findings. Their effort-scaling heuristic (1 agent / 3–10 tool calls for
  simple lookups; 10+ agents for broad research) makes **fan-out shape vs.
  task size** a checkable signal.
- Vague subagent instructions caused duplicated searches — **overlap between
  sibling agents' tool calls** is a measurable proxy for delegation quality.
- Multi-agent decomposition fits breadth-first work; "most coding tasks
  involve fewer truly parallelizable tasks than research."

From ["Building effective agents"](https://www.anthropic.com/engineering/building-effective-agents)
and the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview):

- **Routing** (classify the task, send it to the cheapest capable model) is an
  official pattern — model mix per session is a first-class signal.
- **Effort** is a documented lever independent of model choice; subagent
  frontmatter and per-call params can set both. A session where every
  delegated task inherits the expensive session model is a visible
  anti-pattern.

From [Claude Code subagent docs](https://code.claude.com/docs/en/sub-agents):

- Model resolution: `CLAUDE_CODE_SUBAGENT_MODEL` > per-call `model` param >
  agent frontmatter > inherit. Logs record the resolved model per subagent —
  so **who ran on what** is fully reconstructible.
- Context isolation is one of the four official reasons to use subagents;
  sub-agent summaries returned to the parent are typically **1,000–2,000
  tokens** (per the context-engineering post) — return sizes far above that
  indicate raw exploration leaking back into the orchestrator's context.

### Quality / context

From ["Effective context engineering for AI agents"](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):

- **Context rot**: recall degrades as context grows — context length over
  time is a quality-risk curve on its own, before any visible error.
- Just-in-time retrieval beats pre-loading; compaction risks losing critical
  context — compaction events (`compact_boundary`, pre/post tokens) are
  directly log-derivable.

From [Agent Skills docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
and the [Skills engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills):

- Skills are progressive disclosure: ~100 tokens of metadata always loaded,
  <5k tokens when triggered, bundled resources only as needed. **Which
  skills fired, when, and what they pulled in** shows whether the session
  had the right procedural context.

From [Claude Code memory docs](https://code.claude.com/docs/en/memory) and
[best practices](https://code.claude.com/docs/en/best-practices):

- CLAUDE.md over ~200 lines degrades adherence; "kitchen sink sessions",
  "correcting over and over", and "infinite exploration" are named failure
  patterns — all have log-visible shapes (task-switches without resets,
  repeated near-identical corrections, long read-only phases).

From [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):

- Cache reads cost 0.1× input, writes 1.25×/2×. Cache hit rate is both the
  dominant cost factor **and** a context-stability proxy: a chronically low
  hit rate means the stable prefix is being invalidated turn-to-turn.

## 3. Signal catalog

Signals Junrei computes (or will compute), each reproducible from logs alone
with provenance (line numbers / record UUIDs). ✅ shipped in v1 · ⬜ planned.

### Cost & orchestration lens

| Signal | Definition | Why it matters |
| --- | --- | --- |
| ✅ Cost / tokens by model | Per-model token & USD rollup, incl. subagents | Model mix = routing quality |
| ✅ Subagent tree | Nested agents with model, prompt, usage, depth | Orchestration shape at a glance |
| ⬜ Delegation share | % of total tokens spent in subagents vs. main thread, by model tier | Is expensive-model work orchestration-only? |
| ⬜ Subagent return size | Tokens of each agent's final message to parent (benchmark: 1–2k) | Context discipline of workers |
| ⬜ Concurrency profile | Wall-clock overlap of sibling agents / background tasks | Was parallelism real or nominal? |
| ⬜ Sibling overlap | Same file read / same query issued by 2+ sibling agents | Vague task descriptions → duplicated work |
| ✅ Task executions | All Bash/Agent/preview runs, fg/bg, duration, outcome | Where wall-clock time went |

### Context & quality lens

| Signal | Definition | Why it matters |
| --- | --- | --- |
| ✅ Context growth curve | `input + cache_read + cache_creation` per API message | Context-rot leading indicator |
| ✅ Compaction events | `compact_boundary` pre/post tokens, auto/manual | Context-loss risk points |
| ⬜ Token composition per turn | Stacked cache-read / cache-write / fresh input / output | Cache health and cost anatomy per turn |
| ✅ Cache hit rate | cache_read ÷ (cache_read + input + cache_creation) | Cost driver + prefix-stability proxy |
| ✅ Exploration profile | Read:Edit ratio, turns-to-first-edit, distinct files | "Infinite exploration" shape |
| ✅ Repetition findings | Near-duplicate calls, re-reads, repeated failures | Thrash / lost-context re-discovery |
| ✅ Tool error classes | file-not-found, string-not-found, command-failed, … | Friction taxonomy |
| ⬜ File access tree | Directory tree of files read/edited, with counts & timing | What context was actually pulled in |
| ⬜ Skill invocations | Skill tool calls: which skill, when, what it loaded | Was procedural context available & used? |
| ⬜ Instruction footprint | Size of CLAUDE.md / rules / MEMORY.md loaded at start | Adherence-risk baseline (200-line guidance) |

Aggregate lenses (cross-session trends, error taxonomy across sessions) stay
post-v1 — see [roadmap.md](./roadmap.md).

## 4. Information architecture

### Principles

1. **Layered, not stuffed.** One screen per question. The session detail is a
   hub with lenses, not a single scroll of every table.
2. **Metadata always visible, content on demand.** Model, tokens, cost,
   duration inline everywhere; full prompts/results collapsed behind a click
   (the OTel GenAI posture, and how LangSmith/Braintrust keep trees scannable).
3. **Rollups at every level.** Every node — session, turn, subagent, tool
   call — shows self + children cost/tokens, so hotspots are visible without
   expanding leaves.
4. **Lossless at the bottom.** Drill-down terminates at the actual record:
   full prompt, full tool input/result, line-number provenance. Nothing the
   log contains is unreachable from the UI.
5. **Recursive drill-down.** A subagent is a session in miniature: it gets the
   same lenses (timeline, orchestration, context) applied to its own
   transcript, at any nesting depth.
6. **Numbers, never grades.** No scores, no red/green judgment. Reference
   points from published research (e.g. "typical worker summary: 1–2k tokens")
   may be shown as annotations, clearly sourced.

### Hierarchy

```
L0  Session list                      "which journey?"
     └─ L1  Session overview          "how did it go, in numbers?"
          ├─ L2  Timeline             "what actually happened, in order?"
          ├─ L2  Orchestration        "who did the work, on which model?"
          ├─ L2  Context & cost       "how healthy was the context, where did $ go?"
          ├─ L2  Files & skills       "what knowledge was pulled in?"
          └─ L3  Drill-downs
               ├─ Subagent detail     (same L1/L2 layout, recursive)
               └─ Record detail       (full tool call / message, provenance)
```

**L0 — Session list.** Rows: project, title, time, duration, turns, cost,
model mix (e.g. compact per-model bar), agents, errors, compactions.
Filter by project/date.

**L1 — Session overview.** Header (title, project, branch, time, duration,
CC version) + stat tiles (cost, turns, cache hit rate, output tokens,
compactions/errors, subagents) + two headline charts (context growth with
compaction markers; cost-by-model) + the first user prompt. Each tile/chart
links into the lens that explains it.

**L2 — Timeline (full transcript).** The "watch the whole journey" view the
session flows top-to-bottom with nothing dropped: user prompts, assistant
text/thinking, every tool call (collapsible input/result, error styling),
subagent launches (card with prompt + model + cost → drill-down link),
task notifications, compaction boundaries as visual breaks. A **detail dial**
(user-only / minimal / full — claude-code-log's proven pattern) and
type/status filters with live counts keep it navigable. Every block carries
its source line number.

**L2 — Orchestration.** Master-detail: left, the agent tree (every node:
model badge, tokens, cost self/total, duration, return size); right, the
selected agent's detail. Two alternate lenses over the same tree, toggled
like Datadog's flame/waterfall/list: a **waterfall** (time axis — shows real
concurrency of agents and background tasks) and a **flame/icicle** (width =
tokens or cost — shows where the budget burned). Model-mix summary on top.

**L2 — Context & cost.** Context growth curve with compaction markers;
per-turn stacked token composition (cache read / cache write / fresh input /
output); cache hit rate over time; cost by model; API errors.

**L2 — Files & skills.** File access tree (directory-shaped, per-file read/
edit counts, re-read highlighting, first-touched time, main-vs-subagent
context); skill invocation list (skill name, trigger time, what it loaded);
tool stats histogram with error categories; repetition findings; task
executions. This is the "was the right knowledge in context?" lens.

**L3 — Subagent detail.** Route of its own (`…/agent/:agentId`), rendering
the agent's transcript with the same L1 overview + L2 lenses. Breadcrumb
back up the spawn chain. Recursive to any depth (CC caps at 5).

**L3 — Record detail.** Any tool call / message opens a pane with the full
input/result payload, timing, linkage (tool_use_id), and provenance
(file line), so every number in Junrei is traceable to its source event.

### What this requires beyond v1 (gap analysis)

Current implementation (see [design.md](./design.md)): 2 routes, session
detail as a single scroll, subagent tree without drill-down, metrics-only
API. New needs:

- **Transcript API**: ordered message/event stream per session and per
  subagent (core already retains ordered records internally; not yet exposed).
- **Skill extraction**: Skill tool calls are captured generically; classify
  them as first-class skill-invocation events.
- **File access events**: per-file read/edit event list with timestamps and
  agent attribution (exploration profile already tracks the sets).
- **Subagent routes** + per-agent analysis reusing the same session pipeline
  (core supports this recursively already).
- **New derived signals**: delegation share, return sizes, concurrency
  profile, sibling overlap, token composition per turn, instruction footprint.

## 5. MCP parity

Every lens must stay agent-consumable: the MCP tools should expose the same
layered data (overview → lens → drill-down) so a coding agent can run the
same retrospective a human runs in the UI — e.g. after a multi-agent task,
check `get_subagent_tree` for delegation share and return sizes, and adjust
its own model-routing choices. The UI and MCP are two clients of one signal
model.
