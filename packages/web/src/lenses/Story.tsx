import { useCallback, useEffect, useState } from "react";
import {
  type AnySessionJson,
  fetchSessionInsight,
  postLearning,
  type SessionInsight,
  type SessionInsightRecommendation,
  type SessionRef,
} from "../api.js";
import { InsightCallout, recommendationKey } from "./story/InsightCallout.js";
import { Timeline } from "./Timeline.js";

interface Props {
  session: AnySessionJson;
  sessionRef: SessionRef;
  /** Opens the record slide-over (L3) for a Timeline source line. */
  onOpenRecord: (line: number) => void;
}

/**
 * Story lens (L1, PR4) — the conclusion-first read of a session: the
 * FROM-THIS-SESSION insight callout (`GET /api/sessions/<source>/:id/insight`)
 * over the embedded Timeline. Absorbs the old Overview + Timeline lenses; the
 * old Overview charts (context growth / cost-by-model) now live in the Evidence
 * lens's Context sub-tab, and the old First-prompt strip was removed (it
 * duplicated the Timeline's first row).
 *
 * Owns the callout's Log-learning writes: a recommendation's "Log learning"
 * button POSTs `POST /api/learnings` (the same upsert `log_learning` runs) with
 * this session as the learning's `sourceSessions` provenance. The insight fetch
 * is best-effort — a failure (or a 404 for an unresolved analysis) simply hides
 * the callout, leaving the Timeline; it's an enhancement, not a dependency.
 */
export function Story({ session, sessionRef, onOpenRecord }: Props) {
  const [insight, setInsight] = useState<SessionInsight | undefined>(undefined);
  const [loggingKey, setLoggingKey] = useState<string | undefined>(undefined);
  const [loggedKeys, setLoggedKeys] = useState<ReadonlySet<string>>(new Set());

  // Re-fetch (and reset logged state) whenever the session identity changes —
  // depend on the primitive parts, not the freshly-rebuilt `sessionRef` object
  // (the parent rebuilds `ref` every render), and rebuild the ref inside so the
  // effect has no dependency on the object identity.
  const { source, id } = sessionRef;
  useEffect(() => {
    let stale = false;
    setInsight(undefined);
    setLoggedKeys(new Set());
    const ref: SessionRef =
      source === "codex" ? { source: "codex", id } : { source: "claude-code", id };
    // `detail: "full"` so the response carries the what-if simulations (D1/D5)
    // the callout's "What if" card renders — a full-only field.
    fetchSessionInsight(ref, "full")
      .then((result) => {
        if (!stale) setInsight(result);
      })
      .catch(() => {
        // Best-effort — the Timeline below is the load the Story tab depends on.
      });
    return () => {
      stale = true;
    };
  }, [source, id]);

  const onLog = useCallback(
    (rec: SessionInsightRecommendation) => {
      const key = recommendationKey(rec);
      setLoggingKey(key);
      postLearning({
        source,
        sessionId: id,
        finding: rec.logLearningCall.finding,
        change: rec.logLearningCall.change,
        ...(rec.logLearningCall.expectedEffect !== undefined && {
          expectedEffect: rec.logLearningCall.expectedEffect,
        }),
        proposedBy: "agent",
      })
        .then(() => {
          setLoggedKeys((prev) => new Set(prev).add(key));
        })
        .catch(() => {
          // Leave the button re-enabled so the write can be retried.
        })
        .finally(() => {
          setLoggingKey(undefined);
        });
    },
    [source, id],
  );

  return (
    <>
      {insight !== undefined && (
        <InsightCallout
          insight={insight}
          sessionRef={sessionRef}
          onLog={onLog}
          loggingKey={loggingKey}
          loggedKeys={loggedKeys}
        />
      )}
      <Timeline sessionRef={sessionRef} session={session} onOpenRecord={onOpenRecord} />
    </>
  );
}
