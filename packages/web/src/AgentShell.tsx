import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { type AgentJson, client, type SessionJson, type SubagentNodeJson } from "./api.js";
import { cacheHitRate, formatDuration, formatTime, formatTokens, formatUsd } from "./format.js";
import { ContextCost } from "./lenses/ContextCost.js";
import { ContextGrowthChart } from "./lenses/ContextGrowthChart.js";
import { FilesSkills } from "./lenses/FilesSkills.js";
import { FirstPromptPanel } from "./lenses/FirstPromptPanel.js";
import {
  displayName,
  findAgentPath,
  nodeDurationMs,
  spawnedByLabel,
  totalTokensOf,
} from "./lenses/orchestration/agentTree.js";
import { RecordDetail } from "./lenses/RecordDetail.js";
import { Timeline } from "./lenses/Timeline.js";
import { classifyModel, modelShortLabel } from "./modelClass.js";
import {
  agentPath,
  agentRecordPath,
  LENS_LABEL,
  normalizeLens,
  parseRecordParam,
  sessionPath,
} from "./router.js";
import { Band } from "./shell/Band.js";
import { LensTabs } from "./shell/LensTabs.js";

function ModelBadge({ model }: { model: string | undefined }) {
  if (model === undefined) return null;
  return (
    <span className="mbdg">
      <span className={`mdot c-${classifyModel(model)}`} />
      {modelShortLabel(model)}
    </span>
  );
}

interface Crumb {
  key: string;
  label: string;
  /** Absent for the current (deepest) crumb — rendered as `.bc-cur` plain text instead of a link. */
  href?: string;
}

/**
 * `.bc` breadcrumb — every crumb but the current one is a link back up the
 * chain (session title, then each ancestor agent). See
 * design-spec/16-subagent-detail.md's breadcrumb + depth-cue component spec.
 */
function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <div className="bc">
      {crumbs.map((crumb, i) => (
        <Fragment key={crumb.key}>
          {i > 0 && <span>▸</span>}
          {crumb.href !== undefined ? (
            <Link to={crumb.href} style={{ color: "inherit" }}>
              {crumb.label}
            </Link>
          ) : (
            <span className="bc-cur">{crumb.label}</span>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** One `.dbar` tick per level of nesting below the session root. */
function DepthTicks({ depth }: { depth: number }) {
  return (
    <div className="fx ac gap10">
      <span className="fx gap4">
        {Array.from({ length: depth }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ticks are unlabeled and never reorder
          <span key={i} className="dbar" />
        ))}
      </span>
      <span className="mono fs10 mut">depth {depth}</span>
    </div>
  );
}

function AgentMetaLine({ node, session }: { node: SubagentNodeJson; session: SessionJson }) {
  const spawnedAt = node.launchedAt ?? node.startedAt;
  const durationMs = nodeDurationMs(node);
  const parts: ReactNode[] = [
    <span key="spawn" className="nowrap">
      spawned by <span className="amb">{spawnedByLabel(node, session.subagents)}</span>
      {spawnedAt !== undefined && <> at {formatTime(spawnedAt)}</>}
      {node.launchLine !== undefined && <> · L{node.launchLine}</>}
    </span>,
  ];
  if (durationMs !== undefined) {
    parts.push(<span key="dur">{formatDuration(durationMs)}</span>);
  }
  if (node.returnedChars !== undefined) {
    parts.push(<span key="ret">returned {formatTokens(node.returnedChars)} chars to parent</span>);
  } else if (node.asyncLaunch === true) {
    parts.push(<span key="ret">async launch · return not captured</span>);
  }

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
 * Agent-scoped KPI row — same `.b-strip`/`.b-cell` markup as the session-level
 * `StatStrip`, but every number is scoped to this agent (see
 * design-spec/16-subagent-detail.md's KPI table). `agent` is this agent's own
 * analysis (tokens/cost/msgs/cache); `node` is this agent's entry in the
 * session-level subagent tree, which is the only place launch/child linkage
 * (returnedChars, children) is resolved — an agent analyzed from its own
 * sidecar in isolation can never discover its own children (they're
 * discovered via the *session-wide* tool-call ownership scan), so it always
 * reports `subagents: []` even when the tree shows otherwise.
 */
function AgentStatStrip({
  session,
  agent,
  node,
}: {
  session: SessionJson;
  agent: AgentJson;
  node: SubagentNodeJson;
}) {
  const costPct =
    session.totalUsage.costUsd > 0
      ? Math.round((agent.totalUsage.costUsd / session.totalUsage.costUsd) * 100)
      : 0;
  const childCount = node.children.length;

  return (
    <div className="b-strip mt16">
      <div className="b-cell">
        <div className="lbl">Cost</div>
        <div className="big mt8 amb">
          {formatUsd(agent.totalUsage.costUsd)}
          {agent.totalUsage.costIsComplete ? "" : "*"}
        </div>
        <div className="sub">{costPct}% of session</div>
      </div>
      <div className="b-cell">
        <div className="lbl">Tokens</div>
        <div className="big mt8">{formatTokens(totalTokensOf(agent.totalUsage))}</div>
        <div className="sub num">
          {node.returnedChars !== undefined
            ? `${formatTokens(node.returnedChars)} chars returned`
            : node.asyncLaunch === true
              ? "async · not captured"
              : "not returned yet"}
        </div>
      </div>
      <div className="b-cell">
        <div className="lbl">API msgs</div>
        <div className="big mt8">{agent.apiMessageCount}</div>
        <div className="sub">
          {agent.userTurnCount} turn{agent.userTurnCount === 1 ? "" : "s"}
        </div>
      </div>
      <div className="b-cell">
        <div className="lbl">Cache hit</div>
        <div className="big mt8">{(cacheHitRate(agent.totalUsage) * 100).toFixed(0)}%</div>
        <div className="sub">of input tokens</div>
      </div>
      <div className="b-cell">
        <div className="lbl">Tool calls</div>
        <div className="big mt8">{node.toolCallCount}</div>
        <div className="sub num">{node.toolErrorCount} errors</div>
      </div>
      <div className="b-cell" style={{ borderRight: 0 }}>
        <div className="lbl">Subagents</div>
        <div className={childCount === 0 ? "big mt8 mut" : "big mt8"}>{childCount}</div>
        <div className="sub">
          {childCount === 0
            ? "leaf agent"
            : `${childCount} ${childCount === 1 ? "child" : "children"}`}
        </div>
      </div>
    </div>
  );
}

/**
 * "Return to parent" panel — the literal text this agent handed back to its
 * caller (design-spec/16's replacement for L1's cost-by-model chart). Uses
 * `returnedChars`/`returnedPreview` honestly: never fabricates a token count
 * for what's actually a captured character count.
 */
function ReturnToParentPanel({ node }: { node: SubagentNodeJson }) {
  return (
    <div
      className="pan"
      style={{ width: "400px", flex: "none", padding: "18px 20px", boxSizing: "border-box" }}
    >
      <div className="lbl" style={{ marginBottom: "12px" }}>
        Return to parent
      </div>
      {node.returnedPreview !== undefined ? (
        <>
          <div className="btxt mut" style={{ fontSize: "12.5px" }}>
            &quot;{node.returnedPreview}&quot;
          </div>
          <div
            className="ann mt12"
            style={{ borderTop: "1px dotted var(--bd)", paddingTop: "10px" }}
          >
            {node.returnedChars !== undefined
              ? `${node.returnedChars.toLocaleString()} chars · `
              : ""}
            ref · typical subagent summary: 1–2k tok
          </div>
        </>
      ) : node.asyncLaunch === true ? (
        <div className="mono fs11 mut">
          This launch was asynchronous — the parent-side result is only the completion
          acknowledgment. The agent&apos;s actual return text isn&apos;t captured in the transcript.
        </div>
      ) : (
        <div className="mono fs11 mut">No return captured for this launch.</div>
      )}
    </div>
  );
}

function AgentOverview({
  project,
  id,
  agentId,
  agent,
  node,
}: {
  project: string;
  id: string;
  agentId: string;
  agent: AgentJson;
  node: SubagentNodeJson;
}) {
  return (
    <>
      <FirstPromptPanel session={agent} label="Launch prompt" />
      <div className="hpad fx gap16 mt16">
        <ContextGrowthChart
          session={agent}
          contextHref={agentPath(project, id, agentId, "context")}
          bare
        />
        <ReturnToParentPanel node={node} />
      </div>
    </>
  );
}

/**
 * Subagent detail (L3) — the entire L1+L2 shell applied to one agent's own
 * transcript instead of the main session, per design-spec/16. Route element
 * for `AGENT_ROUTE_PATH` (`session/:project/:id/agent/:agentId/:lens?`).
 *
 * Fetches two things: the session analysis (for the session title, session
 * totals used in "% of session", and this agent's place in the subagent
 * tree — including launch/return linkage that only the session-wide scan
 * resolves), and this agent's own analysis (for agent-scoped KPIs and
 * charts, analyzed straight off its sidecar transcript — see
 * `getAgentSession` on the server).
 */
export function AgentShell() {
  const {
    project: projectParam,
    id: idParam,
    agentId: agentIdParam,
    lens: lensParam,
  } = useParams<"project" | "id" | "agentId" | "lens">();
  const project = projectParam ?? "";
  const id = idParam ?? "";
  const agentId = agentIdParam ?? "";
  const lens = normalizeLens(lensParam);
  const [searchParams] = useSearchParams();
  const record = parseRecordParam(searchParams);
  const navigate = useNavigate();

  const [session, setSession] = useState<SessionJson | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentJson | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const recordOpen = record !== undefined;
  const closeRecordHref = agentPath(project, id, agentId, lens);

  useEffect(() => {
    setSession(null);
    setSessionError(null);
    client.api.sessions[":project"][":id"]
      .$get({ param: { project, id } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        setSession((await res.json()) as SessionJson);
      })
      .catch((e: unknown) => setSessionError(String(e)));
  }, [project, id]);

  useEffect(() => {
    setAgent(null);
    setAgentError(null);
    client.api.sessions[":project"][":id"].agents[":agentId"]
      .$get({ param: { project, id, agentId } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        setAgent((await res.json()) as AgentJson);
      })
      .catch((e: unknown) => setAgentError(String(e)));
  }, [project, id, agentId]);

  const ancestorChain = session !== null ? findAgentPath(session.subagents, agentId) : undefined;
  const node = ancestorChain?.[ancestorChain.length - 1];
  const notFoundError =
    session !== null && ancestorChain === undefined ? "agent not found in this session" : undefined;
  const error = sessionError ?? agentError ?? notFoundError ?? null;
  const loading = error === null && (session === null || agent === null);
  const ready = error === null && session !== null && agent !== null && node !== undefined;

  const crumbs: Crumb[] =
    session !== null && ancestorChain !== undefined
      ? [
          {
            key: "session",
            label: session.title ?? session.sessionId,
            href: sessionPath(project, id),
          },
          ...ancestorChain.slice(0, -1).map((ancestor) => ({
            key: ancestor.agentId,
            label: displayName(ancestor),
            href: agentPath(project, id, ancestor.agentId),
          })),
          {
            key: agentId,
            label: displayName(ancestorChain[ancestorChain.length - 1] as SubagentNodeJson),
          },
        ]
      : [{ key: "loading", label: "…" }];
  const depth = ancestorChain?.length ?? 1;

  const buildAgentLensPath = (l: typeof lens) => agentPath(project, id, agentId, l);

  return (
    <div className="posrel">
      <div
        className={recordOpen ? "dim" : undefined}
        style={recordOpen ? { pointerEvents: "none" } : undefined}
      >
        <Band
          left={
            <span className="fx ac gap12">
              <Breadcrumb crumbs={crumbs} />
            </span>
          }
          right={ready ? <DepthTicks depth={depth} /> : undefined}
        />
        {session !== null && agent !== null && node !== undefined && (
          <>
            <div className="hpad" style={{ paddingTop: "20px" }}>
              <div className="fx ac gap12">
                <h1 className="ttl" style={{ fontSize: "21px" }}>
                  {displayName(node)}
                </h1>
                <ModelBadge model={node.model} />
              </div>
              <AgentMetaLine node={node} session={session} />
            </div>
            <AgentStatStrip session={session} agent={agent} node={node} />
          </>
        )}
        <div className="hpad mt16">
          <LensTabs project={project} id={id} active={lens} buildPath={buildAgentLensPath} />
        </div>
        {error !== null && <div className="hpad mt16 mut">Failed to load agent: {error}</div>}
        {loading && <div className="hpad mt16 mut">Analyzing agent…</div>}
        {session !== null && agent !== null && node !== undefined && lens === "overview" && (
          <div className="hpad mt16">
            <AgentOverview project={project} id={id} agentId={agentId} agent={agent} node={node} />
          </div>
        )}
        {ready && lens === "timeline" && (
          <Timeline
            project={project}
            id={id}
            agent={agentId}
            onOpenRecord={(line) => {
              navigate(agentRecordPath(project, id, agentId, lens, line));
            }}
          />
        )}
        {session !== null && agent !== null && node !== undefined && lens === "context" && (
          <div className="hpad mt16">
            <ContextCost session={agent} contextHref={agentPath(project, id, agentId, "context")} />
          </div>
        )}
        {session !== null && agent !== null && node !== undefined && lens === "files" && (
          <FilesSkills session={agent} />
        )}
        {ready &&
          lens !== "overview" &&
          lens !== "timeline" &&
          lens !== "context" &&
          lens !== "files" && (
            <div className="hpad mt16">
              <div className="pan tile mut">
                {LENS_LABEL[lens]} isn&apos;t built yet — coming in a later PR.
              </div>
            </div>
          )}
      </div>
      {record !== undefined && (
        <RecordDetail
          project={project}
          id={id}
          line={record}
          agent={agentId}
          closeHref={closeRecordHref}
        />
      )}
    </div>
  );
}
