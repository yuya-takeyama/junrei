import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { client, type SessionJson } from "./api.js";
import { formatDuration, formatTime } from "./format.js";
import { Overview } from "./lenses/Overview.js";
import { RecordDetail } from "./lenses/RecordDetail.js";
import { Timeline } from "./lenses/Timeline.js";
import { buildHash, buildRecordHash, type Lens } from "./router.js";
import { Band } from "./shell/Band.js";
import { LensTabs } from "./shell/LensTabs.js";
import { StatStrip } from "./shell/StatStrip.js";

interface Props {
  project: string;
  id: string;
  lens: Lens;
  /** Source line of the record slide-over (L3, screen 8) to show over this lens, if any. */
  record?: number;
}

const LENS_LABEL: Record<Lens, string> = {
  overview: "Overview",
  timeline: "Timeline",
  orchestration: "Orchestration",
  context: "Context & cost",
  files: "Files & skills",
};

const COPY_FLASH_MS = 800;

function shortenId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function metaParts(session: SessionJson): ReactNode[] {
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
  if (session.version !== undefined) {
    parts.push(<span key="ver">CC {session.version}</span>);
  }
  return parts;
}

function MetaLine({ session }: { session: SessionJson }) {
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
 * Shell shared by every session route: identity band with breadcrumb +
 * copyable session id, title block, session-level stat strip, then the
 * persistent lens tab bar, then the active lens's content — see
 * design-spec/01-shell.md. Only "overview" renders real content in this PR;
 * the rest are placeholders for later PRs.
 */
export function SessionShell({ project, id, lens, record }: Props) {
  const [session, setSession] = useState<SessionJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const recordOpen = record !== undefined;
  const closeRecordHref = buildHash(project, id, lens);

  useEffect(() => {
    setSession(null);
    setError(null);
    client.api.sessions[":project"][":id"]
      .$get({ param: { project, id } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        setSession((await res.json()) as SessionJson);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [project, id]);

  const title = session?.title ?? session?.sessionId ?? "…";

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
              <a href="#/">Sessions</a> / {project} / {title}
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
            </div>
            <StatStrip session={session} />
          </>
        )}
        <div className="hpad mt16">
          <LensTabs project={project} id={id} active={lens} />
        </div>
        {error !== null && <div className="hpad mt16 mut">Failed to load session: {error}</div>}
        {error === null && session === null && (
          <div className="hpad mt16 mut">Analyzing session…</div>
        )}
        {error === null && session !== null && lens === "overview" && (
          <Overview session={session} />
        )}
        {error === null && session !== null && lens === "timeline" && (
          <Timeline
            project={project}
            id={id}
            onOpenRecord={(line) => {
              window.location.hash = buildRecordHash(project, id, lens, line);
            }}
          />
        )}
        {error === null && session !== null && lens !== "overview" && lens !== "timeline" && (
          <div className="hpad mt16">
            <div className="pan tile mut">
              {LENS_LABEL[lens]} isn&apos;t built yet — coming in a later PR.
            </div>
          </div>
        )}
      </div>
      {record !== undefined && (
        <RecordDetail project={project} id={id} line={record} closeHref={closeRecordHref} />
      )}
    </div>
  );
}
