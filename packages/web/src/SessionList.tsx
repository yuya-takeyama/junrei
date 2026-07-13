import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ModelMixEntry, SessionListItem } from "./api.js";
import { client } from "./api.js";
import {
  DATE_FILTER_PRESET_DAYS,
  dateFilterFromSelectValue,
  dateFilterSelectValue,
  matchesDateFilter,
  useStoredDateFilter,
} from "./dateFilter.js";
import { formatDateTime, formatDuration, formatUsd } from "./format.js";
import type { ModelClass } from "./modelClass.js";
import { classifyModel, MODEL_CLASS_ORDER } from "./modelClass.js";
import { RepoOverviewBand } from "./RepoOverviewBand.js";
import {
  ALL_REPOS,
  parseListPage,
  parseRepoParam,
  parseSourceTab,
  type SourceTab,
  sessionPath,
  sessionRefOf,
} from "./router.js";
import {
  projectFilterKey,
  repoFilterKey,
  repoOptionsFor,
  sessionsFetchWindow,
  sessionsListQuery,
  sourceBadgeLabel,
  subagentCellText,
} from "./sessionListHelpers.js";
import { Band } from "./shell/Band.js";

/**
 * Rows per page. Kept small on purpose: the server only ANALYZES enough
 * transcripts to fill the requested page (see `claudeListItems` in
 * `@junrei/server`), so this number is what the first paint waits on —
 * deeper pages stay reachable via the pager below the list. Only plain
 * browsing pages on the server, though — an active repo/date/search filter
 * switches the fetch to the whole listable window so counting and paging can
 * happen after filtering (see `sessionsFetchWindow`).
 */
const LIST_LIMIT = 50;

const SOURCE_TAB_LABEL: Record<SourceTab, string> = {
  all: "All",
  "claude-code": "Claude Code",
  codex: "Codex",
};
const SOURCE_TAB_ORDER: readonly SourceTab[] = ["all", "claude-code", "codex"];

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
      {MODEL_CLASS_ORDER.map((cls) => {
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
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useStoredDateFilter();
  const [searchParams, setSearchParams] = useSearchParams();
  // Persisted in the URL (`?source=`/`?repo=`/`?page=`) rather than component
  // state so a reload or shared link keeps the selection — same pattern as
  // the lens segment / `?record=` param elsewhere in the router (see
  // router.ts).
  const sourceTab = parseSourceTab(searchParams.get("source"));
  const repoFilter = parseRepoParam(searchParams.get("repo"));
  const page = parseListPage(searchParams.get("page"));

  // Any client-side filter flips the list from server paging to
  // fetch-the-window-then-page (see `sessionsFetchWindow`) — a bound-less
  // "custom" date range counts too, which just means one slightly bigger
  // fetch before the user picks a bound.
  const filterActive =
    repoFilter !== ALL_REPOS || dateFilter.kind !== "all" || search.trim() !== "";
  const { limit: fetchLimit, offset: fetchOffset } = sessionsFetchWindow(
    filterActive,
    page,
    LIST_LIMIT,
  );

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
      .$get({
        query: sessionsListQuery(sourceTab, String(fetchLimit), String(fetchOffset)),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = await res.json();
        if (!stale) {
          setSessions(body.sessions);
          setTotal(body.total);
        }
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
    // Keyed on the resolved fetch window, not `page`/`filterActive` directly:
    // while a filter is active the window is constant ({500, 0}), so paging
    // through filtered rows never refetches.
  }, [sourceTab, fetchLimit, fetchOffset]);

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
    const now = Date.now();
    const needle = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (repoFilter !== ALL_REPOS && repoFilterKey(s) !== repoFilter) return false;
      if (needle !== "") {
        const title = (s.title ?? s.firstUserPrompt ?? s.sessionId).toLowerCase();
        if (!title.includes(needle)) return false;
      }
      return matchesDateFilter(s.startedAt, dateFilter, now);
    });
  }, [sessions, repoFilter, search, dateFilter]);

  // With a filter active the fetched window is the whole list, so the pager
  // is sized by (and slices) the FILTERED rows; plain browsing keeps
  // server-side paging sized by the server's unfiltered total.
  const pageCount = Math.max(1, Math.ceil((filterActive ? filtered.length : total) / LIST_LIMIT));
  // A stale `?page=` past the filtered range (shared link, or a filter that
  // shrank the list before its handler could reset the param) clamps to the
  // last page instead of rendering an empty page under a lying pager.
  const activePage = filterActive ? Math.min(page, pageCount) : page;
  const pageRows = filterActive
    ? filtered.slice((activePage - 1) * LIST_LIMIT, activePage * LIST_LIMIT)
    : filtered;
  const goToPage = (next: number) => {
    const params = new URLSearchParams(searchParams);
    // Page 1 is the canonical no-param URL, same as the "all" source tab.
    if (next <= 1) params.delete("page");
    else params.set("page", String(next));
    setSearchParams(params);
    window.scrollTo(0, 0);
  };
  // Filter changes that don't live in the URL (date preset, custom bounds,
  // title search) still need the same page reset a source/repo change does —
  // the paged series they define changes shape, so a held-over page number
  // would point at arbitrary rows.
  const resetPageParam = () => {
    if (!searchParams.has("page")) return;
    const params = new URLSearchParams(searchParams);
    params.delete("page");
    setSearchParams(params);
  };

  return (
    <div>
      <Band
        left={<span className="mono fs11 mut">{"// agent statistics analyzer"}</span>}
        right={<span className="mono fs11 mut">local · ~/.claude · ~/.codex</span>}
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
                // Each tab is its own paginated series — a page number from
                // the previous tab would land on arbitrary rows (or past the
                // end) in the new one.
                next.delete("page");
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
              // Same reset as the source-tab switch above — the repo filter
              // defines its own paged series.
              next.delete("page");
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
          <select
            className={dateFilter.kind === "all" ? "chip" : "chip on"}
            value={dateFilterSelectValue(dateFilter)}
            onChange={(e) => {
              setDateFilter(dateFilterFromSelectValue(e.target.value));
              resetPageParam();
            }}
            aria-label="Filter by date"
          >
            <option value="all">all dates</option>
            {DATE_FILTER_PRESET_DAYS.map((days) => (
              <option key={days} value={String(days)}>
                last {days} days
              </option>
            ))}
            <option value="custom">custom range…</option>
          </select>
          {dateFilter.kind === "custom" && (
            <>
              <input
                className="chip on"
                type="date"
                value={dateFilter.from ?? ""}
                max={dateFilter.to}
                onChange={(e) => {
                  setDateFilter({
                    ...dateFilter,
                    from: e.target.value === "" ? undefined : e.target.value,
                  });
                  resetPageParam();
                }}
                aria-label="From date"
              />
              <span className="mono fs11 mut">→</span>
              <input
                className="chip on"
                type="date"
                value={dateFilter.to ?? ""}
                min={dateFilter.from}
                onChange={(e) => {
                  setDateFilter({
                    ...dateFilter,
                    to: e.target.value === "" ? undefined : e.target.value,
                  });
                  resetPageParam();
                }}
                aria-label="To date"
              />
            </>
          )}
          <input
            className="chip"
            style={{ minWidth: "180px" }}
            type="text"
            placeholder="⌕ search title…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPageParam();
            }}
            aria-label="Search by title"
          />
          <span className="mono fs11 mut num nowrap">
            {sessions === null ? "…" : `${String(filtered.length)} of ${String(total)}`}
            {/* Same "incomplete" marker convention as the cost column's `*`:
                the filter only scanned the fetched window, so matches older
                than it can't be counted. */}
            {sessions !== null && filterActive && sessions.length < total && (
              <span title={`filtered over the newest ${String(sessions.length)} sessions only`}>
                *
              </span>
            )}{" "}
            sessions
          </span>
        </div>
      </div>

      {/* Rendered only once the rows are loaded — mirrors the old
          fetch-silently-then-appear behavior, and guarantees the band never
          aggregates a half-loaded list. */}
      {repoFilter !== ALL_REPOS && sessions !== null && <RepoOverviewBand sessions={filtered} />}

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
            <span className="lbl cellr nowrap" title="Failed tool calls">
              Tool err
            </span>
            <span className="lbl cellr">Cmp</span>
          </div>
          {pageRows.map((s) => (
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

      {sessions !== null && pageCount > 1 && (
        <div className="fx ac gap12" style={{ justifyContent: "center", padding: "16px 28px" }}>
          <button
            type="button"
            className="chip"
            disabled={activePage <= 1}
            onClick={() => {
              goToPage(activePage - 1);
            }}
          >
            ‹ prev
          </button>
          <span className="mono fs11 mut num nowrap">
            page {activePage} / {pageCount}
          </span>
          <button
            type="button"
            className="chip"
            disabled={activePage >= pageCount}
            onClick={() => {
              goToPage(activePage + 1);
            }}
          >
            next ›
          </button>
        </div>
      )}
    </div>
  );
}
