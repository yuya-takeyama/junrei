import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  type AgentJson,
  type AnySessionJson,
  type CodexSessionJson,
  fetchAgentSession,
  fetchSessionDetail,
  type SubagentNodeJson,
} from "./api.js";
import { cacheHitRate, formatDuration, formatTime, formatTokens, formatUsd } from "./format.js";
import { ContextCost } from "./lenses/ContextCost.js";
import { ContextGrowthChart } from "./lenses/ContextGrowthChart.js";
import { FilesSkills } from "./lenses/FilesSkills.js";
import { FirstPromptPanel } from "./lenses/FirstPromptPanel.js";
import { Orchestration } from "./lenses/Orchestration.js";
import {
  activeModels,
  displayName,
  findAgentPath,
  nodeDurationMs,
  spawnedByLabel,
  totalTokensOf,
} from "./lenses/orchestration/agentTree.js";
import { ModelBadges } from "./lenses/orchestration/ModelBadges.js";
import { RecordDetail } from "./lenses/RecordDetail.js";
import { Timeline } from "./lenses/Timeline.js";
import {
  agentPath,
  agentRecordPath,
  LENS_LABEL,
  LENSES_BY_SOURCE,
  normalizeLens,
  parseRecordParam,
  type SessionRef,
  sessionPath,
} from "./router.js";
import { Band } from "./shell/Band.js";
import { LensTabs } from "./shell/LensTabs.js";
import { capsFor } from "./sourceCaps.js";

/**
 * The agent's own analysis, whichever source produced it: a Claude agent is
 * analyzed from its sidecar transcript (`fetchAgentSession`); a Codex
 * sub-agent IS a full session (its own rollout file), so its "own analysis"
 * is just `fetchSessionDetail` on its own session id.
 */
type AnyAgentJson = AgentJson | CodexSessionJson;

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

function AgentMetaLine({ node, session }: { node: SubagentNodeJson; session: AnySessionJson }) {
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
 * (returnedChars, children) is resolved — a Claude agent analyzed from its
 * own sidecar in isolation can never discover its own children (they're
 * discovered via the *session-wide* tool-call ownership scan), so it always
 * reports `subagents: []` even when the tree shows otherwise. Source
 * asymmetries mirror the session-level `StatStrip` and are expressed by the
 * entity interface, not `source` checks: `apiMessageCount` is present only
 * where the harness has the concept (Turns cell otherwise), and return
 * capture is a `capsFor` capability.
 */
function AgentStatStrip({
  session,
  agent,
  node,
}: {
  session: AnySessionJson;
  agent: AnyAgentJson;
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
              : capsFor(agent).capturesSubagentReturn
                ? "not returned yet"
                : "return not in log"}
        </div>
      </div>
      {agent.apiMessageCount !== undefined ? (
        <div className="b-cell">
          <div className="lbl">API msgs</div>
          <div className="big mt8">{agent.apiMessageCount}</div>
          <div className="sub">
            {agent.userTurnCount} turn{agent.userTurnCount === 1 ? "" : "s"}
          </div>
        </div>
      ) : (
        <div className="b-cell">
          <div className="lbl">Turns</div>
          <div className="big mt8">{agent.userTurnCount}</div>
          <div className="sub">user turns</div>
        </div>
      )}
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
 * for what's actually a captured character count. `capturesReturn` (the
 * `capturesSubagentReturn` capability — see sourceCaps.ts) swaps the empty
 * state for the honest no-capture story: when the log format records no
 * parent-side return at all, "no return captured" isn't a gap in THIS
 * launch, it's a property of the log.
 */
function ReturnToParentPanel({
  node,
  capturesReturn,
}: {
  node: SubagentNodeJson;
  capturesReturn: boolean;
}) {
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
      ) : !capturesReturn ? (
        <div className="mono fs11 mut">
          Codex rollouts don&apos;t record what a sub-agent thread hands back to its parent — the
          return text isn&apos;t in the log.
        </div>
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
  sessionRef,
  agentScopedRef,
  agentId,
  agentParam,
  agent,
  node,
}: {
  /** The parent session this agent is viewed under — breadcrumb/URL root. */
  sessionRef: SessionRef;
  /** Where this agent's own transcript is fetched from — see `AgentShell`. */
  agentScopedRef: SessionRef;
  agentId: string;
  /** `agentId` for Claude (sidecar-scoped fetches), undefined for Codex. */
  agentParam: string | undefined;
  agent: AnyAgentJson;
  node: SubagentNodeJson;
}) {
  return (
    <>
      <FirstPromptPanel
        session={agent}
        sessionRef={agentScopedRef}
        {...(agentParam !== undefined && { agentId: agentParam })}
        label="Launch prompt"
      />
      <div className="hpad fx gap16 mt16">
        <ContextGrowthChart
          session={agent}
          contextHref={agentPath(sessionRef, agentId, "context")}
          bare
        />
        <ReturnToParentPanel node={node} capturesReturn={capsFor(agent).capturesSubagentReturn} />
      </div>
    </>
  );
}

interface Props {
  /** Which harness this route serves — passed by the route config (main.tsx), same as `SessionShell`. */
  source: "claude-code" | "codex";
}

/**
 * Subagent detail (L3) — the entire L1+L2 shell applied to one agent's own
 * transcript instead of the main session, per design-spec/16. Route element
 * for `CLAUDE_AGENT_ROUTE_PATH`/`CODEX_AGENT_ROUTE_PATH`
 * (`session/<source>/:id/agent/:agentId/:lens?`).
 *
 * Fetches two things: the session analysis (for the session title, session
 * totals used in "% of session", and this agent's place in the subagent
 * tree — including launch/return linkage that only the session-wide scan
 * resolves), and this agent's own analysis. The second fetch is where the
 * sources diverge: a Claude agent is a sidecar transcript under its parent
 * session (`getAgentSession` on the server, record/timeline fetches scoped
 * with an `agent` param), while a Codex sub-agent is a full session of its
 * own — its analysis, timeline, and records are all fetched by its own
 * session id (`agentScopedRef`), no agent param anywhere. Codex agents also
 * get the real Orchestration lens (their own analysis carries a `subagents`
 * forest, so nested delegation is visible at any depth).
 */
export function AgentShell({ source }: Props) {
  const {
    id: idParam,
    agentId: agentIdParam,
    lens: lensParam,
  } = useParams<"id" | "agentId" | "lens">();
  const id = idParam ?? "";
  const agentId = agentIdParam ?? "";
  const lens = normalizeLens(lensParam);
  const [searchParams] = useSearchParams();
  const record = parseRecordParam(searchParams);
  const navigate = useNavigate();
  const isCodex = source === "codex";

  const sessionRef: SessionRef = isCodex ? { source: "codex", id } : { source: "claude-code", id };
  // Transcript-scoped fetches (timeline/records/launch prompt): Claude reads
  // the agent's sidecar through the PARENT session (+ `agent` query param);
  // Codex reads the agent's OWN session (a sub-agent is a full rollout file).
  const agentScopedRef: SessionRef = isCodex ? { source: "codex", id: agentId } : sessionRef;
  const agentParam = isCodex ? undefined : agentId;

  const [session, setSession] = useState<AnySessionJson | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [agent, setAgent] = useState<AnyAgentJson | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const recordOpen = record !== undefined;
  const closeRecordHref = agentPath(sessionRef, agentId, lens);

  useEffect(() => {
    setSession(null);
    setSessionError(null);
    const ref: SessionRef =
      source === "codex" ? { source: "codex", id } : { source: "claude-code", id };
    fetchSessionDetail(ref)
      .then(setSession)
      .catch((e: unknown) => setSessionError(String(e)));
  }, [source, id]);

  useEffect(() => {
    setAgent(null);
    setAgentError(null);
    const fetchAgent: Promise<AnyAgentJson> =
      source === "codex"
        ? fetchSessionDetail({ source: "codex", id: agentId })
        : fetchAgentSession(id, agentId);
    fetchAgent.then(setAgent).catch((e: unknown) => setAgentError(String(e)));
  }, [source, id, agentId]);

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
            href: sessionPath(sessionRef),
          },
          ...ancestorChain.slice(0, -1).map((ancestor) => ({
            key: ancestor.agentId,
            label: displayName(ancestor),
            href: agentPath(sessionRef, ancestor.agentId),
          })),
          {
            key: agentId,
            label: displayName(ancestorChain[ancestorChain.length - 1] as SubagentNodeJson),
          },
        ]
      : [{ key: "loading", label: "…" }];
  const depth = ancestorChain?.length ?? 1;

  const lensTabs = LENSES_BY_SOURCE[source];
  const lensAvailable = (lensTabs as readonly string[]).includes(lens);
  const buildAgentLensPath = (l: typeof lens) => agentPath(sessionRef, agentId, l);

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
                <ModelBadges models={activeModels(node.usage.byModel)} />
              </div>
              <AgentMetaLine node={node} session={session} />
            </div>
            <AgentStatStrip session={session} agent={agent} node={node} />
          </>
        )}
        <div className="hpad mt16">
          <LensTabs active={lens} buildPath={buildAgentLensPath} lenses={lensTabs} />
        </div>
        {error !== null && <div className="hpad mt16 mut">Failed to load agent: {error}</div>}
        {loading && <div className="hpad mt16 mut">Analyzing agent…</div>}
        {ready && !lensAvailable && (
          <div className="hpad mt16">
            <div className="pan tile mut">This lens isn&apos;t available for this agent.</div>
          </div>
        )}
        {session !== null && agent !== null && node !== undefined && lens === "overview" && (
          <div className="hpad mt16">
            <AgentOverview
              sessionRef={sessionRef}
              agentScopedRef={agentScopedRef}
              agentId={agentId}
              agentParam={agentParam}
              agent={agent}
              node={node}
            />
          </div>
        )}
        {ready && lens === "timeline" && (
          <Timeline
            sessionRef={agentScopedRef}
            {...(agentParam !== undefined && { agent: agentParam })}
            onOpenRecord={(line) => {
              navigate(agentRecordPath(sessionRef, agentId, lens, line));
            }}
          />
        )}
        {session !== null && agent !== null && node !== undefined && lens === "context" && (
          <div className="hpad mt16">
            <ContextCost session={agent} contextHref={agentPath(sessionRef, agentId, "context")} />
          </div>
        )}
        {session !== null && agent !== null && node !== undefined && lens === "files" && (
          <FilesSkills
            session={agent}
            onOpenRecord={(line) => {
              navigate(agentRecordPath(sessionRef, agentId, lens, line));
            }}
          />
        )}
        {session !== null &&
          agent !== null &&
          node !== undefined &&
          lens === "orchestration" &&
          (agent.source === "codex" ? (
            // A Codex sub-agent's own analysis carries its own `subagents`
            // forest (see `getCodexSession` on the server), so the real lens
            // renders here — nested delegation stays visible at any depth.
            <Orchestration session={agent} />
          ) : (
            <div className="hpad mt16">
              <div className="pan tile mut">
                {LENS_LABEL[lens]} isn&apos;t built yet — coming in a later PR.
              </div>
            </div>
          ))}
        {ready && lens === "tools" && (
          // `tools` is in both `CLAUDE_LENSES` and `CODEX_LENSES` (see
          // `LENSES_BY_SOURCE`), so `lensAvailable` is true for either
          // source's agent — but this shell has no agent-SCOPED Tools view for
          // either one yet (the Tools lens ranks calls across a whole
          // session's threads jointly, see `ToolHeavyHittersTable`'s doc
          // comment; a single-agent slice of that ranking isn't a
          // straightforward "just filter" and hasn't been built). Same
          // "not built yet" placeholder the orchestration branch above uses
          // for a Claude agent, now unconditional on source.
          <div className="hpad mt16">
            <div className="pan tile mut">
              {LENS_LABEL[lens]} isn&apos;t built yet for subagent detail — coming in a later PR.
            </div>
          </div>
        )}
      </div>
      {record !== undefined && (
        <RecordDetail
          sessionRef={agentScopedRef}
          line={record}
          {...(agentParam !== undefined && { agent: agentParam })}
          closeHref={closeRecordHref}
        />
      )}
    </div>
  );
}
