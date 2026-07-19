import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { type AnySessionJson, fetchSessionDetail, type SessionRef } from "./api.js";
import { formatDuration, formatTime } from "./format.js";
import { Evidence } from "./lenses/Evidence.js";
import { Orchestration } from "./lenses/Orchestration.js";
import { RecordDetail } from "./lenses/RecordDetail.js";
import { Story } from "./lenses/Story.js";
import {
  isLegacyClaudeProjectScopedUrl,
  LENSES_BY_SOURCE,
  legacySessionLensRedirect,
  normalizeEvidenceSub,
  normalizeLens,
  normalizeToolsSub,
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
 * "tools" renders the same way for both sources now — `SessionAnalysisCore.
 * bashStats`/`.toolUsageStats` (see `@junrei/core`'s
 * `shared/session-analysis.ts`) are populated by both `analyzeClaudeSession`
 * and `analyzeCodexSession`/`getCodexSession` (the latter overriding them
 * with a forest-joint recompute once a session's sub-agent forest is known,
 * mirroring how `fileAccess` is already handled — see `sources/codex.ts`), so
 * `Tools` takes the `AnySessionJson` union like every other source-uniform
 * lens here. Its `sub` (`toolsSub`) picks the All vs Bash sub-tab from the
 * URL's `:sub?` segment.
 */
export function SessionShell({ source }: Props) {
  const {
    id: idParam,
    lens: lensParam,
    sub: subParam,
    sub2: sub2Param,
  } = useParams<"id" | "lens" | "sub" | "sub2">();
  const isCodex = source === "codex";
  const [searchParams] = useSearchParams();

  // Legacy bookmark guard — see `isLegacyClaudeProjectScopedUrl`'s doc
  // comment (router.ts) for the exact URL shape this catches. Codex never
  // had a `:project` segment, so this is always false for that source.
  const isLegacyProjectScopedUrl = !isCodex && isLegacyClaudeProjectScopedUrl(idParam, lensParam);

  // Legacy LENS redirect (current-shape URL, but an old lens segment like
  // /timeline or /tools/bash) — rewrite it to the canonical Story/Evidence
  // path so old bookmarks land on the right tab (see router.ts). Skipped for
  // the project-scoped shape above, which is handled by its own redirect.
  const legacyLensSuffix = isLegacyProjectScopedUrl
    ? undefined
    : legacySessionLensRedirect(lensParam, subParam, sub2Param);

  const id = isLegacyProjectScopedUrl ? "" : (idParam ?? "");
  const ref: SessionRef = isCodex ? { source: "codex", id } : { source: "claude-code", id };
  const lens = normalizeLens(isLegacyProjectScopedUrl ? undefined : lensParam);
  // Evidence sub-tab (Context/Files/Tools) + the Tools All|Bash sub — only
  // meaningful for the "evidence" lens.
  const evidenceSub = lens === "evidence" ? normalizeEvidenceSub(subParam) : undefined;
  const toolsSub =
    lens === "evidence" && evidenceSub === "tools" ? normalizeToolsSub(sub2Param) : undefined;
  const record = parseRecordParam(searchParams);
  const recordAgent = parseRecordAgentParam(searchParams);
  const navigate = useNavigate();

  const [session, setSession] = useState<AnySessionJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const recordOpen = record !== undefined;
  const closeRecordHref = sessionPath(ref, lens, evidenceSub, toolsSub);

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
    // Don't fetch when we're about to redirect (either legacy shape).
    if (isLegacyProjectScopedUrl || legacyLensSuffix !== undefined) return;
    setSession(null);
    setError(null);
    fetchSessionDetail(ref)
      .then(setSession)
      .catch((e: unknown) => setError(String(e)));
  }, [source, id, isLegacyProjectScopedUrl, legacyLensSuffix]);

  if (isLegacyProjectScopedUrl) {
    // For this legacy shape the real UUID sits in `lensParam`, with the old
    // trailing segments in `subParam`/`sub2Param`
    // (`/<project>/<uuid>[/<a>[/<b>]]` matches `:lens?/:sub?/:sub2?`). Strip the
    // stale project segment and preserve the trailing path VERBATIM, then let it
    // re-resolve: a legacy lens (`…/timeline`) re-mounts here and gets
    // normalized to Story/Evidence by `legacySessionLensRedirect` below, while a
    // short agent-drilldown (`…/agent/<id>`) re-matches the agent route instead
    // (its static `agent` segment outranks the session route). Rebuilding via
    // `canonicalLensSuffix` here would misread `agent`/`<id>` as a lens/sub and
    // drop the drilldown, so we intentionally do NOT map lenses at this hop.
    const rest = [subParam, sub2Param].filter((s) => s !== undefined).join("/");
    const base = sessionPath({ source: "claude-code", id: lensParam as string });
    const target = rest === "" ? base : `${base}/${rest}`;
    const search = searchParams.toString();
    return <Navigate replace to={search === "" ? target : `${target}?${search}`} />;
  }

  if (legacyLensSuffix !== undefined) {
    // Current-shape URL with a legacy lens segment (e.g. `/timeline`,
    // `/tools/bash`) — rewrite to its canonical Story/Evidence path, preserving
    // any `?record=`/`?agent=` query so an open record survives the redirect.
    const base = sessionPath(ref);
    const target = legacyLensSuffix === "" ? base : `${base}/${legacyLensSuffix}`;
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
        {error === null && session !== null && lens === "story" && (
          <Story
            session={session}
            sessionRef={ref}
            onOpenRecord={(line) => {
              navigate(recordPath(ref, lens, line));
            }}
          />
        )}
        {error === null && session !== null && lens === "orchestration" && (
          <Orchestration session={session} />
        )}
        {error === null && session !== null && lens === "evidence" && evidenceSub !== undefined && (
          <Evidence
            session={session}
            sessionRef={ref}
            sub={evidenceSub}
            toolsSub={toolsSub ?? "all"}
            onOpenRecord={(line, agentId) => {
              // The Evidence › Tools heavy hitters rank tool/Bash calls across
              // every thread (see `HeavyHittersTable`/`ToolHeavyHittersTable`),
              // so most rows belong to a subagent. `recordPath`'s optional agent
              // argument carries the subagent id as a query param so we stay on
              // THIS page (see `recordSessionRef`/`recordAgentParam` above), and
              // `evidenceSub`/`toolsSub` keep the record's URL/close href on the
              // right sub-tab.
              navigate(
                recordPath(ref, lens, line, {
                  ...(agentId !== undefined && { agentId }),
                  ...(evidenceSub !== undefined && { sub: evidenceSub }),
                  ...(toolsSub !== undefined && { toolsSub }),
                }),
              );
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
