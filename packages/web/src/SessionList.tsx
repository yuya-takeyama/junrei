import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ModelMixEntry, SessionListItem } from "./api.js";
import { client } from "./api.js";
import { formatDateTime, formatDuration, formatUsd } from "./format.js";
import type { ModelClass } from "./modelClass.js";
import { classifyModel } from "./modelClass.js";
import { RepoOverviewBand } from "./RepoOverviewBand.js";
import {
  ALL_REPOS,
  parseRepoParam,
  parseSourceTab,
  type SourceTab,
  sessionPath,
  sessionRefOf,
} from "./router.js";
import {
  isEstimatedCost,
  projectFilterKey,
  repoFilterKey,
  repoOptionsFor,
  sessionsListQuery,
  sourceBadgeLabel,
  subagentCellText,
} from "./sessionListHelpers.js";
import { Band } from "./shell/Band.js";
import { EstBadge } from "./shell/EstBadge.js";

const LIST_LIMIT = "200";

const SOURCE_TAB_LABEL: Record<SourceTab, string> = {
  all: "All",
  "claude-code": "Claude Code",
  codex: "Codex",
};
const SOURCE_TAB_ORDER: readonly SourceTab[] = ["all", "claude-code", "codex"];

type DateFilter = "14" | "30" | "all";
const DATE_FILTER_CYCLE: readonly DateFilter[] = ["all", "14", "30"];
const DATE_FILTER_LABEL: Record<DateFilter, string> = {
  all: "all dates",
  "14": "last 14 days",
  "30": "last 30 days",
};
const DAY_MS = 24 * 60 * 60 * 1000;

function ModelMixBar({ mix }: { mix: ModelMixEntry[] }) {
  const total = mix.reduce((sum, m) => sum + m.outputTokens, 0);
  if (total <= 0) return <span className="mix" />;

  const byClass = new Map<ModelClass, number>();
  for (const m of mix) {
    const cls = classifyModel(m.model);
    byClass.set(cls, (byClass.get(cls) ?? 0) + m.outputTokens);
  }

  return (
    <span className="mix">
      {(["f", "s", "h", "mut"] as const).map((cls) => {
        const tokens = byClass.get(cls);
        if (tokens === undefined || tokens <= 0) return null;
        const pct = (tokens / total) * 100;
        return <span key={cls} className={`mseg c-${cls}`} style={{ width: `${pct}%` }} />;
      })}
    </span>
  );
}

/** Numeric cell rendered muted when the value is zero — the app-wide "de-emphasize zero" rule. */
function NumCell({
  value,
  format = String,
  errorish = false,
}: {
  value: number;
  format?: (n: number) => string;
  errorish?: boolean;
}) {
  const className =
    value === 0 ? "num fs12 cellr mut" : errorish ? "num fs12 cellr errtx" : "num fs12 cellr";
  return <span className={className}>{format(value)}</span>;
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [searchParams, setSearchParams] = useSearchParams();
  // Persisted in the URL (`?source=`/`?repo=`) rather than component state so
  // a reload or shared link keeps the selection — same pattern as the lens
  // segment / `?record=` param elsewhere in the router (see router.ts).
  const sourceTab = parseSourceTab(searchParams.get("source"));
  const repoFilter = parseRepoParam(searchParams.get("repo"));

  useEffect(() => {
    setSessions(null);
    setError(null);
    // A rapid tab switch leaves the previous request in flight; without this
    // flag its late response would clobber the newer tab's list.
    let stale = false;
    // Always pass `source` explicitly: an omitted `source` defaults to
    // Claude-only on the server (back-compat for pre-Codex clients — see
    // `listSessions` in sessions.ts), which would silently hide Codex rows
    // even on the "All" tab.
    client.api.sessions
      .$get({ query: sessionsListQuery(sourceTab, LIST_LIMIT) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = await res.json();
        if (!stale) setSessions(body.sessions);
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [sourceTab]);

  const repoOptions = useMemo(() => {
    if (sessions === null) return [];
    return repoOptionsFor(sessions);
  }, [sessions]);
  const repoOptionByKey = useMemo(() => {
    const map = new Map<string, (typeof repoOptions)[number]>();
    for (const opt of repoOptions) map.set(opt.key, opt);
    return map;
  }, [repoOptions]);

  const filtered = useMemo(() => {
    if (sessions === null) return [];
    const cutoff = dateFilter === "all" ? undefined : Date.now() - Number(dateFilter) * DAY_MS;
    const needle = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (repoFilter !== ALL_REPOS && repoFilterKey(s) !== repoFilter) return false;
      if (needle !== "") {
        const title = (s.title ?? s.firstUserPrompt ?? s.sessionId).toLowerCase();
        if (!title.includes(needle)) return false;
      }
      if (cutoff !== undefined) {
        if (s.startedAt === undefined || Date.parse(s.startedAt) < cutoff) return false;
      }
      return true;
    });
  }, [sessions, repoFilter, search, dateFilter]);

  const cycleDateFilter = () => {
    const index = DATE_FILTER_CYCLE.indexOf(dateFilter);
    setDateFilter(DATE_FILTER_CYCLE[(index + 1) % DATE_FILTER_CYCLE.length] ?? "all");
  };

  return (
    <div>
      <Band
        left={<span className="mono fs11 mut">{"// session recorder"}</span>}
        right={<span className="mono fs11 mut">local · ~/.claude/projects</span>}
      />
      <div className="fx ac jb hpad gap12" style={{ padding: "18px 28px 14px", flexWrap: "wrap" }}>
        <h1 className="ttl" style={{ fontSize: "20px" }}>
          Sessions
        </h1>
        <div className="fx ac gap8">
          {SOURCE_TAB_ORDER.map((tab) => (
            <button
              key={tab}
              type="button"
              className={tab === sourceTab ? "chip on" : "chip"}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (tab === "all") next.delete("source");
                else next.set("source", tab);
                setSearchParams(next);
              }}
            >
              {SOURCE_TAB_LABEL[tab]}
            </button>
          ))}
        </div>
        <div className="fx ac gap8" style={{ flexWrap: "wrap" }}>
          <select
            className="chip on"
            value={repoFilter}
            onChange={(e) => {
              const next = new URLSearchParams(searchParams);
              if (e.target.value === ALL_REPOS) next.delete("repo");
              else next.set("repo", e.target.value);
              setSearchParams(next);
            }}
            aria-label="Filter by repo"
            title={repoFilter === ALL_REPOS ? undefined : repoOptionByKey.get(repoFilter)?.title}
          >
            <option value={ALL_REPOS}>repo: all</option>
            {repoOptions.map((opt) => (
              <option key={opt.key} value={opt.key} title={opt.title}>
                repo: {opt.label}
              </option>
            ))}
          </select>
          <button type="button" className="chip" onClick={cycleDateFilter}>
            {DATE_FILTER_LABEL[dateFilter]} ▾
          </button>
          <input
            className="chip"
            style={{ minWidth: "180px" }}
            type="text"
            placeholder="⌕ search title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search by title"
          />
          <span className="mono fs11 mut num nowrap">
            {sessions === null ? "…" : filtered.length} sessions
          </span>
        </div>
      </div>

      {repoFilter !== ALL_REPOS && <RepoOverviewBand repo={repoFilter} />}

      {error !== null && <div className="mut hpad">Failed to load sessions: {error}</div>}
      {error === null && sessions === null && <div className="mut hpad">Analyzing sessions…</div>}

      {sessions !== null && (
        <div className="l0-wrap">
          <div className="l0g hdr">
            <span className="lbl">Repo</span>
            <span className="lbl">Title</span>
            <span className="lbl">Start</span>
            <span className="lbl cellr">Dur</span>
            <span className="lbl cellr">Turns</span>
            <span className="lbl cellr">Cost est</span>
            <span className="lbl">Model mix</span>
            <span className="lbl cellr">Sub</span>
            <span className="lbl cellr">Err</span>
            <span className="lbl cellr">Cmp</span>
          </div>
          {filtered.map((s) => (
            <Link
              key={`${s.source}/${projectFilterKey(s)}/${s.sessionId}`}
              className="l0g"
              to={sessionPath(sessionRefOf(s))}
            >
              <span
                className="mono fs11 mut nowrap"
                title={repoOptionByKey.get(repoFilterKey(s))?.title ?? projectFilterKey(s)}
              >
                {repoOptionByKey.get(repoFilterKey(s))?.label ?? projectFilterKey(s)}
                {s.worktreeName !== undefined && (
                  // Subtle worktree marker — mirrors the "archived" marker
                  // below (same `mut fs10` treatment) rather than the bordered
                  // `.mbdg` source badge, since this is secondary provenance
                  // info on a cell that's already muted.
                  <span className="mut fs10" title={`worktree: ${s.worktreeName}`}>
                    {" "}
                    · {s.worktreeName}
                  </span>
                )}
              </span>
              <span className="fx ac gap8 nowrap">
                {sourceTab === "all" && (
                  <span className="mbdg" title={sourceBadgeLabel(s.source)}>
                    {sourceBadgeLabel(s.source)}
                  </span>
                )}
                <span className="nowrap">{s.title ?? s.firstUserPrompt ?? s.sessionId}</span>
                {s.source === "codex" && s.archived && (
                  <span className="mut fs10" title="archived Codex rollout">
                    archived
                  </span>
                )}
              </span>
              <span className="num fs12 mut">
                {s.startedAt !== undefined ? formatDateTime(s.startedAt) : "—"}
              </span>
              <span className="num fs12 cellr mut">
                {s.durationMs !== undefined ? formatDuration(s.durationMs) : "—"}
              </span>
              <NumCell value={s.userTurnCount} />
              <span className={s.totalCostUsd === 0 ? "num fs12 cellr mut" : "num fs12 cellr"}>
                {formatUsd(s.totalCostUsd)}
                {s.costIsComplete ? "" : "*"}
                {isEstimatedCost(s) && <EstBadge />}
              </span>
              <ModelMixBar mix={s.modelMix} />
              <span className={s.subagentCount > 0 ? "num fs12 cellr" : "num fs12 cellr mut"}>
                {subagentCellText(s)}
              </span>
              <NumCell value={s.toolErrorCount} errorish />
              <NumCell value={s.compactionCount} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
