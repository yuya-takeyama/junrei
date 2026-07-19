import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { type AnySessionJson, fetchSessionDetail, type SessionRef } from "./api.js";
import { formatDuration, formatTime } from "./format.js";
import { Bash } from "./lenses/Bash.js";
import { ContextCost } from "./lenses/ContextCost.js";
import { FilesSkills } from "./lenses/FilesSkills.js";
import { Orchestration } from "./lenses/Orchestration.js";
import { Overview } from "./lenses/Overview.js";
import { RecordDetail } from "./lenses/RecordDetail.js";
import { Timeline } from "./lenses/Timeline.js";
import {
  isLegacyClaudeProjectScopedUrl,
  LENSES_BY_SOURCE,
  normalizeLens,
  parseRecordAgentParam,
  parseRecordParam,
  recordPath,
  sessionPath,
} from "./router.js";
import { Band } from "./shell/Band.js";
import { LensTabs } from "./shell/LensTabs.js";
import { StatStrip } from "./shell/StatStrip.js";

const COPY_FLASH_MS = 800;

function shortenId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/**
 * Meta-line chips for both harnesses — `gitBranch`/`startedAt`/`endedAt`/
 * `durationMs` are `SessionAnalysisCore` fields shared by Claude and Codex;
 * `version` (Claude Code's own CLI version) and the Codex CLI provenance
 * chips (`originator`/`cliVersion`/`agentRole`/`agentNickname`/`archived`)
 * are each harness-specific and only pushed for their own source.
 *
 * `agentRole`/`agentNickname` were dropped along with Phase 2's
 * `CodexMetaChips` (see docs/roadmap.md's "Unified Timeline") when that
 * component's own tab disappeared — this is their only surface again,
 * presence-driven like every other Codex-only field here (they only exist on
 * a Codex sub-agent thread's own analysis, so no `source ===` check is
 * needed beyond the block below). The session-total reasoning badge
 * `CodexMetaChips` also used to show stays dropped: per-turn Reasoning is
 * now a visible Timeline column, so the aggregate would be redundant.
 */
function metaParts(session: AnySessionJson): ReactNode[] {
  const parts: ReactNode[] = [];
  if (session.gitBranch !== undefined) {
    parts.push(<span key="branch">⎇ {session.gitBranch}</span>);
  }
  if (session.startedAt !== undefined && session.endedAt !== undefined) {
    parts.push(
      <span key="range">
        {formatTime(session.startedAt)} → {formatTime(session.endedAt)}
      </span>,
    );
  }
  if (session.durationMs !== undefined) {
    parts.push(<span key="dur">{formatDuration(session.durationMs)}</span>);
  }
  if (session.source === "claude-code" && session.version !== undefined) {
    parts.push(<span key="ver">CC {session.version}</span>);
  }
  if (session.source === "codex") {
    if (session.codex.originator !== undefined) {
      parts.push(<span key="origin">{session.codex.originator}</span>);
    }
    if (session.codex.cliVersion !== undefined) {
      parts.push(<span key="cli">codex {session.codex.cliVersion}</span>);
    }
    if (session.codex.agentRole !== undefined) {
      parts.push(<span key="role">role {session.codex.agentRole}</span>);
    }
    if (session.codex.agentNickname !== undefined) {
      parts.push(<span key="nick">as {session.codex.agentNickname}</span>);
    }
    if (session.codex.archived) {
      parts.push(
        <span key="archived" className="amb">
          archived
        </span>,
      );
    }
  }
  return parts;
}

function MetaLine({ session }: { session: AnySessionJson }) {
  const parts = metaParts(session);
  if (parts.length === 0) return null;
  return (
    <div className="metas mt8 mono" style={{ fontSize: "11.5px" }}>
      {parts.map((part, i) => (
        <Fragment key={`meta-${String(i)}`}>
          {i > 0 && <span className="amb">·</span>}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Small pill linking a Codex sub-agent session back to its parent
 * (`codex.parentThreadId`, always a full session in its own right — see
 * `codex/orchestration.ts` in `@junrei/core`). Reuses the `.chip` style
 * already used for the source-tab filter chips; `undefined` (renders
 * nothing) for a non-sub-agent session, or when a sub-agent's parent isn't
 * itself resolvable (its own rollout was deleted/archived away, or the
 * linkage came from a schema variant with no parent id at all).
 */
function SubagentOfChip({ session }: { session: AnySessionJson }) {
  if (session.source !== "codex" || session.codex.parentThreadId === undefined) return null;
  const parentId = session.codex.parentThreadId;
  return (
    <Link
      className="chip mt8"
      to={sessionPath({ source: "codex", id: parentId })}
      style={{ display: "inline-flex" }}
    >
      ↑ sub-agent of {shortenId(parentId)}
    </Link>
  );
}

interface Props {
  /**
   * Which harness this route serves — passed by the route config (main.tsx)
   * rather than inferred from URL params, since the Codex route pattern has
   * no `:project` segment to sniff a sentinel from (the pre-refactor
   * `project === "codex"` convention is gone — see router.ts's `SessionRef`).
   */
  source: "claude-code" | "codex";
}

/**
 * Shell shared by every session route: identity band with the session title
 * (the JUNREI wordmark is the link back to the sessions list) + copyable
 * session id, title block, session-level stat strip, then the
 * persistent lens tab bar, then the active lens's content — see
 * design-spec/01-shell.md.
 *
 * Rendered as either the `session/claude-code/:id/:lens?` or
 * `session/codex/:id/:lens?` route element (see main.tsx) — id/lens/record
 * all come from the router rather than props, so opening/closing the record
 * slide-over is a plain navigation and never remounts this component or its
 * active lens.
 *
 * Every lens renders the exact same component for both sources —
 * `FilesSkills` included, now that `fileAccess`/`skillInvocations` live on
 * `SessionAnalysisCore` and Codex populates them too (see
 * `codex/files-skills.ts` in `@junrei/core`); Orchestration likewise renders
 * unchanged (a Codex sub-agent is its own rollout file, not a sidecar, but
 * `getCodexSession` on the server attaches the same `subagents`/
 * `subagentCount` shape — see `codex/orchestration.ts`); Timeline and the
 * record slide-over fetch through `fetchTimeline`/`fetchRecordDetail`
 * (api.ts), which dispatch to each source's own route shape internally — no
 * per-source branching needed here. The formerly Codex-only "turns" lens is
 * gone (see `CLAUDE_LENSES`/`CODEX_LENSES`, now identical) — its per-turn
 * table folded into Timeline's own turn-grouped spine, picked by data
 * presence (see `Timeline.tsx`'s `turnGroupable`), and `normalizeLens`
 * redirects the old `"turns"` URL segment to `"timeline"` so bookmarks keep
 * working.
 *
 * "bash" renders the same way for both sources now — `SessionAnalysisCore.
 * bashStats` (see `@junrei/core`'s `shared/session-analysis.ts`) is populated
 * by both `analyzeClaudeSession` and `analyzeCodexSession`/`getCodexSession`
 * (the latter overriding it with a forest-joint recompute once a session's
 * sub-agent forest is known, mirroring how `fileAccess` is already handled —
 * see `sources/codex.ts`), so `Bash` takes the `AnySessionJson` union like
 * every other source-uniform lens here.
 */
export function SessionShell({ source }: Props) {
  const { id: idParam, lens: lensParam } = useParams<"id" | "lens">();
  const isCodex = source === "codex";
  const [searchParams] = useSearchParams();

  // Legacy bookmark guard — see `isLegacyClaudeProjectScopedUrl`'s doc
  // comment (router.ts) for the exact URL shape this catches. Codex never
  // had a `:project` segment, so this is always false for that source.
  const isLegacyProjectScopedUrl = !isCodex && isLegacyClaudeProjectScopedUrl(idParam, lensParam);

  const id = isLegacyProjectScopedUrl ? "" : (idParam ?? "");
  const ref: SessionRef = isCodex ? { source: "codex", id } : { source: "claude-code", id };
  const lens = normalizeLens(isLegacyProjectScopedUrl ? undefined : lensParam);
  const record = parseRecordParam(searchParams);
  const recordAgent = parseRecordAgentParam(searchParams);
  const navigate = useNavigate();

  const [session, setSession] = useState<AnySessionJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const recordOpen = record !== undefined;
  const closeRecordHref = sessionPath(ref, lens);

  // Where the open record actually gets fetched from — mirrors AgentShell's
  // `agentScopedRef`/`agentParam` split (see its doc comment), but keyed off
  // the `?agent=` query param (`recordAgent`) instead of a fixed route param,
  // since here the record can belong to EITHER the main session or a
  // subagent's own thread while the URL itself stays on this session page. A
  // Claude subagent is a sidecar scoped by an `?agent=` query param on the
  // SAME session id (`fetchRecordDetail`'s `agentId` argument); a Codex
  // subagent is a full sibling session in its own right, so its record can
  // only be fetched by swapping in ITS session id — the codex record route
  // takes no `agent` query at all (see `app.ts`).
  const recordSessionRef: SessionRef =
    isCodex && recordAgent !== undefined ? { source: "codex", id: recordAgent } : ref;
  const recordAgentParam = isCodex ? undefined : recordAgent;

  // `ref` is rebuilt fresh (a new object) on every render — depend on its
  // primitive parts (`source`/`id`, already plain locals above) instead so
  // this effect doesn't re-fire every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on ref's primitive parts (see comment above), not the object itself.
  useEffect(() => {
    if (isLegacyProjectScopedUrl) return;
    setSession(null);
    setError(null);
    fetchSessionDetail(ref)
      .then(setSession)
      .catch((e: unknown) => setError(String(e)));
  }, [source, id, isLegacyProjectScopedUrl]);

  if (isLegacyProjectScopedUrl) {
    const target = sessionPath({ source: "claude-code", id: lensParam as string });
    const search = searchParams.toString();
    return <Navigate replace to={search === "" ? target : `${target}?${search}`} />;
  }

  const title = session?.title ?? session?.sessionId ?? "…";
  const lensTabs = LENSES_BY_SOURCE[source];
  const lensAvailable = (lensTabs as readonly string[]).includes(lens);

  const handleCopy = () => {
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPY_FLASH_MS);
      })
      .catch(() => undefined);
  };

  return (
    <div className="posrel">
      <div
        className={recordOpen ? "dim" : undefined}
        style={recordOpen ? { pointerEvents: "none" } : undefined}
      >
        <Band
          left={
            <span className="bc">
              <span className="bc-cur">{title}</span>
            </span>
          }
          right={
            <button type="button" className="cp" onClick={handleCopy}>
              {shortenId(id)} {copied ? "copied" : "⧉"}
            </button>
          }
        />
        {session !== null && (
          <>
            <div className="hpad" style={{ paddingTop: "22px" }}>
              <h1 className="ttl" style={{ fontSize: "24px" }}>
                {title}
              </h1>
              <MetaLine session={session} />
              <SubagentOfChip session={session} />
            </div>
            <StatStrip session={session} />
          </>
        )}
        <div className="hpad mt16">
          <LensTabs sessionRef={ref} active={lens} lenses={lensTabs} />
        </div>
        {error !== null && <div className="hpad mt16 mut">Failed to load session: {error}</div>}
        {error === null && session === null && (
          <div className="hpad mt16 mut">Analyzing session…</div>
        )}
        {error === null && session !== null && !lensAvailable && (
          <div className="hpad mt16">
            <div className="pan tile mut">This lens isn&apos;t available for this session.</div>
          </div>
        )}
        {error === null && session !== null && lens === "overview" && (
          <Overview session={session} sessionRef={ref} />
        )}
        {error === null && session !== null && lens === "timeline" && (
          <Timeline
            sessionRef={ref}
            session={session}
            onOpenRecord={(line) => {
              navigate(recordPath(ref, lens, line));
            }}
          />
        )}
        {error === null && session !== null && lens === "orchestration" && (
          <Orchestration session={session} />
        )}
        {error === null && session !== null && lens === "context" && (
          <ContextCost session={session} />
        )}
        {error === null && session !== null && lens === "files" && (
          <FilesSkills
            session={session}
            onOpenRecord={(line) => {
              navigate(recordPath(ref, lens, line));
            }}
          />
        )}
        {error === null && session !== null && lens === "bash" && (
          <Bash
            session={session}
            onOpenRecord={(line, agentId) => {
              // Heavy hitters rank Bash calls across every thread (see
              // `HeavyHittersTable`'s doc comment), so most rows belong to
              // a subagent. Opening those used to navigate to the agent
              // shell (`agentRecordPath`), which lost whatever context the
              // click came from (e.g. the Fix Queue's evidence list).
              // `recordPath`'s optional agent argument carries the subagent
              // id as a query param instead, so we stay on THIS page — see
              // `recordSessionRef`/`recordAgentParam` above for how that
              // param gets resolved back into the right fetch per source.
              navigate(recordPath(ref, lens, line, agentId));
            }}
          />
        )}
      </div>
      {record !== undefined && (
        <RecordDetail
          sessionRef={recordSessionRef}
          line={record}
          {...(recordAgentParam !== undefined && { agent: recordAgentParam })}
          closeHref={closeRecordHref}
        />
      )}
    </div>
  );
}
