# Claude Design prompt — Junrei UI

> Paste the prompt below into Claude Design to produce detailed screen
> designs. It is self-contained; adjust the "Deliverables" section per run
> (e.g. one screen at a time). Source of truth for scope:
> [concept.md](./concept.md).

---

Design the web UI for **Junrei**, a local-first analyzer for coding-agent
sessions (Claude Code). Junrei parses session logs and turns them into
quantitative, reproducible signals about **cost** (was each task run on the
right model, was orchestration efficient?) and **quality** (was the right
context — files, Skills, instructions — in play, and did the context stay
healthy?).

## Product character

- Audience: software engineers reviewing their own agent sessions; also the
  basis for agents reading the same data over MCP.
- Personality: calm, precise, instrument-like — a flight recorder, not a
  report card. Junrei **never scores or grades**; it shows numbers with
  provenance and lets the reader judge. Avoid red/green "good/bad" framing;
  reserve alarm colors for hard errors only. Published reference points
  (e.g. "typical subagent summary: 1–2k tokens") may appear as subtle,
  sourced annotations — never as pass/fail.
- Name motif: *junrei* (巡礼) = pilgrimage. A session is a journey with
  stations. The motif may quietly inform naming, iconography, and the
  timeline's visual language (a route, stations, distance markers). Keep it
  subtle — an instrument first.
- Data density: this is a pro tool. Prefer dense, scannable layouts
  (tabular numbers, small multiples) over airy marketing spacing, but keep a
  clear hierarchy: **metadata always visible, full content on demand**
  (model / tokens / cost / duration inline everywhere; prompts and tool
  payloads collapsed behind a click).

## Technical frame (design within this)

- React SPA, desktop-first (min ~1100px comfortable; degrade gracefully to
  ~800px). Plain CSS with custom-property design tokens — define the token
  set (colors, spacing, type scale). Light AND dark themes, dark is the
  primary developer environment.
- Charts are hand-rolled SVG: line/area charts, stacked bars, waterfall
  (Gantt) bars, flame/icicle blocks, simple trees. No heavy chart-library
  visual idioms.
- Monospace for numbers, IDs, file paths, model names; tabular-nums
  alignment in tables.

## Information architecture (fixed — design the screens, don't reinvent the structure)

```
L0  Session list
L1  Session overview (hub)
L2  Lenses within a session: Timeline / Orchestration / Context & cost / Files & skills
L3  Drill-downs: Subagent detail (recursively the same L1+L2 layout) · Record detail
```

Navigation: session list → session (L1 with a persistent lens tab bar) →
lens tabs → drill-downs with breadcrumbs (session ▸ agent ▸ nested agent).

## Screens to design

### 1. Session list (L0)
Rows: project, title, start time, duration, user turns, total cost (est.),
compact per-model mix indicator (e.g. tiny stacked bar: opus/sonnet/haiku
share), subagent count, error count, compaction count. Project/date filters.
Hundreds of rows must stay scannable.

### 2. Session overview (L1)
- Header: title, project, git branch, time range, duration, CC version,
  session id (copyable).
- Stat tiles: total cost (incl. subagent share), turns / API messages,
  cache hit rate, output tokens, compactions / API errors, subagent count.
  Each tile links to the lens that explains it.
- Headline charts: context-growth line (with compaction markers) and
  cost-by-model bar.
- First user prompt (collapsible).

### 3. Timeline lens (L2) — the full-journey transcript
Top-to-bottom, lossless flow of the session: user prompts, assistant
text/thinking, tool calls (collapsible input/result, error styling),
subagent-launch cards (prompt preview, model badge, cost, → drill-down),
task notifications, compaction boundaries as visible breaks in the route.
Controls: a **detail dial** (user-only / minimal / full) and type/status
filter chips with live counts; sticky mini-map or progress rail for long
sessions. Every block shows its source line number on hover.

### 4. Orchestration lens (L2)
- Master-detail: left = agent tree (each node: name/type, model badge,
  tokens, cost self/total, duration, return-to-parent size); right =
  selected agent's summary with "open full detail →".
- View toggle over the same tree: **tree / waterfall / flame**. Waterfall:
  time on x-axis, bars show real concurrency of agents & background tasks.
  Flame/icicle: width = tokens or cost, to spot where the budget burned.
- Header strip: model-mix summary (tokens & cost per model, main vs.
  delegated share).

### 5. Context & cost lens (L2)
Context-growth curve with compaction markers; per-turn stacked token
composition (cache-read / cache-write / fresh input / output); cache hit
rate; cost-by-model table; API errors.

### 6. Files & skills lens (L2)
- File access tree: directory-shaped tree of files read/edited with per-file
  read/edit counts, re-read highlighting, first-touch time, and whether the
  access happened in the main thread or a subagent.
- Skill invocations: which skill, when (position in session), what it loaded.
- Tool stats table (calls, errors, error categories), repetition findings,
  task executions (fg/bg, duration, outcome).

### 7. Subagent detail (L3)
Same layout as L1+L2 applied to one agent's transcript, with breadcrumb
(session ▸ agent ▸ …) and a "spawned by" reference. Design the recursion
cue: the user should always know how deep they are.

### 8. Record detail (L3)
Slide-over or pane for any tool call / message: full input & result payload
(pretty-printed, copyable), timing, tool_use_id linkage, source line number.

## Sample data (use realistic values like these)

- Session: "MCP server over Streamable HTTP", project `junrei`, branch
  `main`, 2h 14m, 38 user turns, 412 API messages, $23.41 total
  ($18.20 fable / $4.90 sonnet / $0.31 haiku), cache hit 87%, 2 compactions,
  7 subagents (1 nested), 3 tool errors.
- Subagent node: `research-agent (sonnet · effort medium)` — 79k tokens,
  $0.94, 2m 13s, returned 1.4k tokens to parent.
- Tool call: `Read /packages/core/src/parser.ts` → 412 lines, ok, line 1287.
- Repetition finding: `Read package.json ×5 (lines 210, 388, 401, 977, 1310)`.

## Deliverables

1. Design-token sheet (colors incl. per-model accent hues, type scale,
   spacing) for light + dark.
2. High-fidelity mockups of screens 1–8 (dark theme primary; light for at
   least L0 and L1).
3. Component specs: stat tile, model badge, agent tree node, timeline block
   (each message/tool variant), detail dial, filter chips, waterfall bar,
   flame block, file-tree row, breadcrumb.
4. Interaction notes: collapse/expand, hover reveals, tree↔waterfall↔flame
   toggle, drill-down transitions, copy affordances.
