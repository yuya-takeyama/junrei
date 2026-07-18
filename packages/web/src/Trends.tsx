import type { TrendsReport } from "@junrei/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { client, fetchTrends, type SessionListItem } from "./api.js";
import {
  ALL_REPOS,
  DEFAULT_TRENDS_WINDOW_DAYS,
  parseRepoParam,
  parseTrendsWindowDays,
  TRENDS_WINDOW_DAYS,
} from "./router.js";
import { LIST_WINDOW_LIMIT, repoOptionsFor, sessionsListQuery } from "./sessionListHelpers.js";
import { Band } from "./shell/Band.js";
import { TrendsView } from "./trends/TrendsView.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cost & usage trends screen (`/trends`) — an L0 sibling to the session list
 * (`SessionList.tsx`), not a session-scoped lens: window (7/14/30 days) and
 * repo controls up top, then `TrendsView`'s KPI row / charts / panels below.
 * Follows the same fetch-effect + loading/error-state shape SessionList and
 * SessionShell both use (fetch on mount/param change into local state, a
 * `stale` flag so a rapid control change can't let a stale response clobber
 * a newer one).
 */
export function Trends() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Persisted in the URL (`?days=`/`?repo=`), same as the session list's own
  // `?source=`/`?repo=`/`?page=` — a reload or shared link keeps the selection.
  const windowDays = parseTrendsWindowDays(searchParams.get("days"));
  const repoFilter = parseRepoParam(searchParams.get("repo"));
  // Computed once (never changes for the lifetime of the tab) — sent on
  // every trends fetch per the option's spec, so the server buckets by the
  // VIEWER's local calendar day, not UTC.
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const [report, setReport] = useState<TrendsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    let stale = false;
    fetchTrends({
      days: windowDays,
      timeZone,
      ...(repoFilter !== ALL_REPOS && { repo: repoFilter }),
    })
      .then((r) => {
        if (!stale) setReport(r);
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [windowDays, repoFilter, timeZone]);

  // Best-effort repo-dropdown catalog: `GET /api/trends` itself returns no
  // repo list, so this fetches a plain session list spanning the same 2x-days
  // lookback the server aggregates over (see app.ts's `/api/trends` doc
  // comment) purely to enumerate `repoFilterKey` buckets via `repoOptionsFor`
  // — the exact function the session list's own repo filter already uses
  // (see SessionList.tsx), reused rather than reimplemented. A failure here
  // just leaves the dropdown at "repo: all" only; it never blocks or fails
  // the trends report fetch above, which is the screen's actual data.
  useEffect(() => {
    let stale = false;
    const untilMs = Date.now();
    const sinceMs = untilMs - 2 * windowDays * DAY_MS;
    client.api.sessions
      .$get({
        query: sessionsListQuery("all", String(LIST_WINDOW_LIMIT), "0", { sinceMs, untilMs }),
      })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = await res.json();
        if (!stale) setSessions(body.sessions);
      })
      .catch(() => {
        if (!stale) setSessions([]);
      });
    return () => {
      stale = true;
    };
  }, [windowDays]);

  const repoOptions = useMemo(
    () => (sessions === null ? [] : repoOptionsFor(sessions)),
    [sessions],
  );
  const repoOptionByKey = useMemo(() => {
    const map = new Map<string, (typeof repoOptions)[number]>();
    for (const opt of repoOptions) map.set(opt.key, opt);
    return map;
  }, [repoOptions]);

  return (
    <div>
      <Band
        left={<span className="mono fs11 mut">{"// cost & usage trends"}</span>}
        right={
          <Link className="linkc mono fs11" to="/">
            → sessions
          </Link>
        }
      />
      <div className="fx ac jb hpad gap12" style={{ padding: "18px 28px 14px", flexWrap: "wrap" }}>
        <h1 className="ttl" style={{ fontSize: "20px" }}>
          Trends
        </h1>
        <div className="fx ac gap8">
          {TRENDS_WINDOW_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              className={d === windowDays ? "chip on" : "chip"}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (d === DEFAULT_TRENDS_WINDOW_DAYS) next.delete("days");
                else next.set("days", String(d));
                setSearchParams(next);
              }}
            >
              {d}d
            </button>
          ))}
        </div>
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
      </div>

      {error !== null && <div className="mut hpad">Failed to load trends: {error}</div>}
      {error === null && report === null && <div className="mut hpad">Analyzing trends…</div>}
      {error === null && report !== null && (
        <TrendsView
          report={report}
          windowDays={windowDays}
          repoOptionByKey={repoOptionByKey}
          repoFilter={repoFilter}
        />
      )}
    </div>
  );
}
