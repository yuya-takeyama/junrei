import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { SessionListItem } from "./api.js";
import { type Briefing, type BriefingWaste, client, fetchBriefing, postLearning } from "./api.js";
import { BriefingView } from "./briefing/BriefingView.js";
import {
  ALL_REPOS,
  BRIEFING_PERIOD_DAYS,
  DEFAULT_BRIEFING_PERIOD_DAYS,
  parseBriefingPeriodDays,
  parseRepoParam,
} from "./router.js";
import { LIST_WINDOW_LIMIT, repoOptionsFor, sessionsListQuery } from "./sessionListHelpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIOD_LABEL: Record<number, string> = { 1: "Today", 7: "7d", 30: "30d" };

/**
 * Briefing home (`/`, the app's new landing screen) — the fetch/routing
 * wrapper around `BriefingView`. Window (Today/7d/30d) and repo are persisted
 * in the URL (`?days=`/`?repo=`), same convention the session list uses, so a
 * reload or shared link keeps the selection. Follows the app's standard
 * fetch-effect shape (a `stale` flag so a rapid control change can't let an
 * older response clobber a newer one).
 *
 * The repo dropdown enumerates `repoFilterKey` buckets from a plain session
 * list (the exact `repoOptionsFor` the session list's own filter uses) — the
 * briefing API returns no repo catalog of its own. A failure there just leaves
 * the dropdown at "repo: all"; it never blocks the briefing fetch.
 */
export function Home() {
  const [searchParams, setSearchParams] = useSearchParams();
  const days = parseBriefingPeriodDays(searchParams.get("days"));
  const repoFilter = parseRepoParam(searchParams.get("repo"));

  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [loggingKey, setLoggingKey] = useState<string | undefined>(undefined);
  // Bumped after a successful learning write to force a briefing refetch (the
  // learning counts / ledger cards on the home reflect the new state).
  const [reloadNonce, setReloadNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is a refetch retrigger, not read in the effect body
  useEffect(() => {
    setBriefing(null);
    setError(null);
    let stale = false;
    fetchBriefing({ days, ...(repoFilter !== ALL_REPOS && { repo: repoFilter }) })
      .then((b) => {
        if (!stale) setBriefing(b);
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [days, repoFilter, reloadNonce]);

  // Repo-dropdown catalog — a 30-day session list, purely to enumerate repos.
  useEffect(() => {
    let stale = false;
    const untilMs = Date.now();
    const sinceMs = untilMs - 30 * DAY_MS;
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
  }, []);

  const repoOptions = useMemo(
    () => (sessions === null ? [] : repoOptionsFor(sessions)),
    [sessions],
  );
  const repoOptionByKey = useMemo(() => {
    const map = new Map<string, (typeof repoOptions)[number]>();
    for (const opt of repoOptions) map.set(opt.key, opt);
    return map;
  }, [repoOptions]);

  const onLogWaste = useCallback((waste: BriefingWaste) => {
    setLoggingKey(waste.provenance.sessionId);
    postLearning({
      source: waste.provenance.source,
      sessionId: waste.provenance.sessionId,
      finding: waste.title,
      change: waste.fix,
      proposedBy: "agent",
    })
      .then(() => {
        setReloadNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        setError(`Failed to log learning: ${String(e)}`);
      })
      .finally(() => {
        setLoggingKey(undefined);
      });
  }, []);

  const setDays = (next: number) => {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_BRIEFING_PERIOD_DAYS) params.delete("days");
    else params.set("days", String(next));
    setSearchParams(params);
  };
  const setRepo = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === ALL_REPOS) params.delete("repo");
    else params.set("repo", next);
    setSearchParams(params);
  };

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <div className="masthead">
        <div>
          <div className="dateline mono">{today}</div>
          <div className="mast-sub fs12 mut">
            {briefing === null
              ? "Analyzing your agents…"
              : `${String(briefing.summary.sessionCount)} sessions · ${String(briefing.summary.wasteCount)} waste findings · ${String(briefing.learnings.open)} open learnings`}
          </div>
        </div>
        <div className="mast-ctl">
          <select
            className="chip on"
            value={repoFilter}
            onChange={(e) => {
              setRepo(e.target.value);
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
          {/* biome-ignore lint/a11y/useSemanticElements: a period toggle is a group of buttons, not a <fieldset> form control */}
          <div className="seg" role="group" aria-label="Period">
            {BRIEFING_PERIOD_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                className={d === days ? "seg-btn on" : "seg-btn"}
                onClick={() => {
                  setDays(d);
                }}
              >
                {PERIOD_LABEL[d] ?? `${String(d)}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error !== null && <div className="mut hpad mt16">Failed to load briefing: {error}</div>}
      {error === null && briefing === null && (
        <div className="mut hpad mt16">Analyzing briefing…</div>
      )}
      {briefing !== null && (
        <BriefingView
          briefing={briefing}
          approxTokens={briefing._meta.approxTokens}
          onLogWaste={onLogWaste}
          loggingKey={loggingKey}
        />
      )}
    </>
  );
}
