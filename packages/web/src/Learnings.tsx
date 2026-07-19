import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { SessionListItem } from "./api.js";
import {
  type Briefing,
  type BriefingWaste,
  client,
  fetchBriefing,
  fetchLearnings,
  type Learning,
  postLearning,
} from "./api.js";
import { LearningsBoard } from "./learnings/LearningsBoard.js";
import { ALL_REPOS, parseRepoParam } from "./router.js";
import { LIST_WINDOW_LIMIT, repoOptionsFor, sessionsListQuery } from "./sessionListHelpers.js";
import { RailLayout } from "./shell/RailLayout.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The board's Measure feed and its verified-effect windows both read a 14-day briefing — the loop's natural cadence. */
const BOARD_BRIEFING_DAYS = 14;

/**
 * Learnings loop board (`/learnings`) — the fetch/routing wrapper around
 * `LearningsBoard`. Pulls the repo-local ledger (`GET /api/learnings`, the
 * LEARN/CHANGE/VERIFY columns) and a 14-day briefing (`GET /api/briefing`,
 * whose waste feed is the MEASURE column). Accept/Dismiss/Log all POST the
 * same upsert `log_learning` runs, then refetch both sources so the board
 * reflects the write. Repo is persisted in the URL (`?repo=`), same as the
 * home.
 */
export function Learnings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const repoFilter = parseRepoParam(searchParams.get("repo"));

  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [learnings, setLearnings] = useState<Learning[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined);
  const [reloadNonce, setReloadNonce] = useState(0);

  const repoArg = repoFilter === ALL_REPOS ? undefined : repoFilter;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is a refetch retrigger, not read in the effect body
  useEffect(() => {
    setBriefing(null);
    setLearnings(null);
    setError(null);
    let stale = false;
    Promise.all([
      fetchBriefing({ days: BOARD_BRIEFING_DAYS, ...(repoArg !== undefined && { repo: repoArg }) }),
      fetchLearnings(repoArg),
    ])
      .then(([b, l]) => {
        if (!stale) {
          setBriefing(b);
          setLearnings(l.learnings);
        }
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [repoArg, reloadNonce]);

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

  const runWrite = useCallback((key: string, write: () => Promise<unknown>) => {
    setPendingKey(key);
    write()
      .then(() => {
        setReloadNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        setError(`Failed to update learning: ${String(e)}`);
      })
      .finally(() => {
        setPendingKey(undefined);
      });
  }, []);

  const onAccept = useCallback(
    (l: Learning) => {
      runWrite(l.id, () => postLearning({ repoPath: l.repo, id: l.id, status: "applied" }));
    },
    [runWrite],
  );
  const onDismiss = useCallback(
    (l: Learning) => {
      runWrite(l.id, () => postLearning({ repoPath: l.repo, id: l.id, status: "rejected" }));
    },
    [runWrite],
  );
  const onLogWaste = useCallback(
    (w: BriefingWaste) => {
      runWrite(w.provenance.sessionId, () =>
        postLearning({
          source: w.provenance.source,
          sessionId: w.provenance.sessionId,
          finding: w.title,
          change: w.fix,
          proposedBy: "agent",
        }),
      );
    },
    [runWrite],
  );

  return (
    <RailLayout active="learnings">
      <div className="fx ac jb hpad gap12" style={{ padding: "22px 28px 14px", flexWrap: "wrap" }}>
        <div>
          <h1 className="ttl" style={{ fontSize: "20px" }}>
            Learnings ledger
          </h1>
          <div className="mut fs12 mt8">
            Every change the agents proposed, applied, or verified against their own activity.
          </div>
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

      {error !== null && <div className="mut hpad">Failed to load learnings: {error}</div>}
      {error === null && (briefing === null || learnings === null) && (
        <div className="mut hpad">Loading the loop…</div>
      )}
      {briefing !== null && learnings !== null && (
        <LearningsBoard
          learnings={learnings}
          waste={briefing.waste}
          briefingApproxTokens={briefing._meta.approxTokens}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onLogWaste={onLogWaste}
          pendingKey={pendingKey}
        />
      )}
    </RailLayout>
  );
}
