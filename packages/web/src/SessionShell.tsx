import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  type AnySessionJson,
  type CodexSessionResponseBody,
  client,
  type SessionJson,
  unwrapCodexSessionResponse,
} from "./api.js";
import { formatDuration, formatTime } from "./format.js";
import { CodexTurns } from "./lenses/CodexTurns.js";
import { ContextCost } from "./lenses/ContextCost.js";
import { FilesSkills } from "./lenses/FilesSkills.js";
import { Orchestration } from "./lenses/Orchestration.js";
import { Overview } from "./lenses/Overview.js";
import { RecordDetail } from "./lenses/RecordDetail.js";
import { Timeline } from "./lenses/Timeline.js";
import {
  CLAUDE_LENSES,
  CODEX_LENSES,
  normalizeLens,
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
 * chips (`originator`/`cliVersion`/`archived`) are each harness-specific and
 * only pushed for their own source.
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
      to={sessionPath("codex", parentId)}
      style={{ display: "inline-flex" }}
    >
      ↑ sub-agent of {shortenId(parentId)}
    </Link>
  );
}

/**
 * Shell shared by every session route: identity band with breadcrumb +
 * copyable session id, title block, session-level stat strip, then the
 * persistent lens tab bar, then the active lens's content — see
 * design-spec/01-shell.md.
 *
 * Rendered directly as the `session/:project/:id/:lens?` route element (see
 * main.tsx) — project/id/lens/record all come from the router rather than
 * props, so opening/closing the record slide-over is a plain navigation and
 * never remounts this component or its active lens.
 *
 * Doubles as the Codex session shell: the literal `project === "codex"`
 * segment (matching the sentinel `projectDirName` Codex list rows carry —
 * see `sessions.ts` on the server) is dispatched to the Codex detail
 * endpoint instead of a dedicated route, so every Codex session URL stays
 * `sessionPath("codex", id, lens)` like any other session link. Files &
 * skills is a Claude-only endpoint that doesn't exist for Codex (see api.ts)
 * and is never reached for a Codex session — `CODEX_LENSES` doesn't offer
 * that tab. Timeline, Orchestration, and the record slide-over, by
 * contrast, ARE available for Codex: Orchestration renders the same
 * `Orchestration` component for both sources (a Codex sub-agent is its own
 * rollout file, not a sidecar, but `getCodexSession` on the server attaches
 * the same `subagents`/`subagentCount` shape — see
 * `codex/orchestration.ts` in `@junrei/core`); Timeline and the record
 * slide-over fetch through the same generic `:project/:id/timeline` /
 * `:project/:id/record/:line` routes/components used for Claude, since the
 * server registers Codex-specific handlers ahead of those generic routes
 * (see app.ts) that return the exact same `TimelineEntry`/`RecordDetail`
 * shapes — no separate dispatch needed here.
 */
export function SessionShell() {
  const {
    project: projectParam,
    id: idParam,
    lens: lensParam,
  } = useParams<"project" | "id" | "lens">();
  const project = projectParam ?? "";
  const id = idParam ?? "";
  const isCodex = project === "codex";
  const lens = normalizeLens(lensParam);
  const [searchParams] = useSearchParams();
  const record = parseRecordParam(searchParams);
  const navigate = useNavigate();

  const [session, setSession] = useState<AnySessionJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const recordOpen = record !== undefined;
  const closeRecordHref = sessionPath(project, id, lens);

  useEffect(() => {
    setSession(null);
    setError(null);
    if (isCodex) {
      client.api.sessions.codex[":id"]
        .$get({ param: { id } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
          const body = (await res.json()) as CodexSessionResponseBody;
          const analysis = unwrapCodexSessionResponse(body);
          if (analysis === undefined) throw new Error("malformed Codex session response");
          setSession(analysis);
        })
        .catch((e: unknown) => setError(String(e)));
      return;
    }
    client.api.sessions[":project"][":id"]
      .$get({ param: { project, id } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        setSession((await res.json()) as SessionJson);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [project, id, isCodex]);

  const title = session?.title ?? session?.sessionId ?? "…";
  const lensTabs = isCodex ? CODEX_LENSES : CLAUDE_LENSES;
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
            <span className="mono fs11 mut nowrap">
              <Link to="/">Sessions</Link> / {project} / {title}
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
          <LensTabs project={project} id={id} active={lens} lenses={lensTabs} />
        </div>
        {error !== null && <div className="hpad mt16 mut">Failed to load session: {error}</div>}
        {error === null && session === null && (
          <div className="hpad mt16 mut">Analyzing session…</div>
        )}
        {error === null && session !== null && !lensAvailable && (
          <div className="hpad mt16">
            <div className="pan tile mut">
              {isCodex
                ? "This lens isn't available for Codex sessions."
                : "This lens isn't available for this session."}
            </div>
          </div>
        )}
        {error === null && session !== null && lens === "overview" && (
          <Overview session={session} />
        )}
        {error === null && session !== null && lens === "timeline" && (
          <Timeline
            project={project}
            id={id}
            onOpenRecord={(line) => {
              navigate(recordPath(project, id, lens, line));
            }}
          />
        )}
        {error === null && session !== null && lens === "orchestration" && (
          <Orchestration session={session} />
        )}
        {error === null && session !== null && lens === "context" && (
          <ContextCost session={session} />
        )}
        {error === null &&
          session !== null &&
          session.source === "claude-code" &&
          lens === "files" && <FilesSkills session={session} />}
        {error === null && session !== null && session.source === "codex" && lens === "turns" && (
          <CodexTurns session={session} />
        )}
      </div>
      {record !== undefined && (
        <RecordDetail project={project} id={id} line={record} closeHref={closeRecordHref} />
      )}
    </div>
  );
}
