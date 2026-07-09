import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  fetchRecordDetail,
  type RecordDetail as RecordDetailData,
  type SessionRef,
} from "../api.js";
import { formatDuration, formatTimeMs, formatTokens, formatUsd } from "../format.js";
import { CopyButton, InlineCopyValue } from "./recordDetail/CopyButton.js";
import { KvGrid, type KvRow } from "./recordDetail/KvGrid.js";
import {
  isResultCapped,
  prettyJson,
  RECORD_KIND_LABEL,
  rawJson,
  resultSectionLabel,
} from "./recordDetail/recordFormat.js";

interface Props {
  sessionRef: SessionRef;
  line: number;
  /** Subagent id to scope the fetch to, when opened from an agent-scoped timeline (unused today —
   *  the Timeline lens only ever shows the main session — but the API already supports it). Claude-only. */
  agent?: string;
  /** Path to navigate to on close (the current session/lens with no `?record=` param). */
  closeHref: string;
}

function shortenToken(value: string, prefix = 12, suffix = 4): string {
  return value.length > prefix + suffix + 1
    ? `${value.slice(0, prefix)}…${value.slice(-suffix)}`
    : value;
}

function sourceLabel(callLine: number, resultLine: number | undefined): string {
  return resultLine !== undefined
    ? `call L${callLine} → result L${resultLine}`
    : `call L${callLine}`;
}

function costLabel(costUsd: number | undefined, costIsComplete: boolean | undefined): string {
  if (costUsd === undefined) return "—";
  return `${formatUsd(costUsd)}${costIsComplete === false ? "*" : ""}`;
}

/** Rows shared by every kind: just `Started`, when a timestamp exists. */
function baseRows(timestamp: string | undefined): KvRow[] {
  return timestamp !== undefined
    ? [{ label: "Started", value: <span className="num fs12">{formatTimeMs(timestamp)}</span> }]
    : [];
}

function ToolCallBody({
  detail,
  agent,
}: {
  detail: Extract<RecordDetailData, { kind: "tool-call" }>;
  agent: string | undefined;
}) {
  const rows: KvRow[] = [
    {
      label: "tool_use_id",
      value: <InlineCopyValue value={detail.toolUseId} display={shortenToken(detail.toolUseId)} />,
    },
    ...baseRows(detail.timestamp),
    ...(detail.durationMs !== undefined
      ? [
          {
            label: "Duration",
            value: <span className="num fs12">{formatDuration(detail.durationMs)}</span>,
          },
        ]
      : []),
    {
      label: "Source",
      value: <span className="mono fs11">{sourceLabel(detail.line, detail.resultLine)}</span>,
    },
    { label: "Agent", value: <span className="mono fs11">{agent ?? "main"}</span> },
  ];

  return (
    <>
      <KvGrid rows={rows} />
      <div className="fx ac jb mt16">
        <span className="lbl">Input</span>
        <CopyButton getText={() => rawJson(detail.input)} />
      </div>
      <div className="code">{prettyJson(detail.input)}</div>

      <div className="fx ac jb mt16">
        <span className="lbl">
          {resultSectionLabel("Result", detail.resultText, detail.status)}
        </span>
        {detail.resultText !== undefined && <CopyButton getText={() => detail.resultText ?? ""} />}
      </div>
      {detail.resultText !== undefined ? (
        <>
          <div className="code">{detail.resultText}</div>
          {isResultCapped(detail.resultText) && (
            <div className="mono fs10 mut mt8">result captured up to 2,000 chars</div>
          )}
        </>
      ) : (
        <div className="mono fs11 mut mt8">(no result captured)</div>
      )}
    </>
  );
}

function TextBody({ label, text, rows }: { label: string; text: string; rows: KvRow[] }) {
  return (
    <>
      <KvGrid rows={rows} />
      <div className="fx ac jb mt16">
        <span className="lbl">{label}</span>
        <CopyButton getText={() => text} />
      </div>
      <div className="code">{text}</div>
    </>
  );
}

function SubagentLaunchBody({
  detail,
}: {
  detail: Extract<RecordDetailData, { kind: "subagent-launch" }>;
}) {
  const rows: KvRow[] = [
    {
      label: "tool_use_id",
      value: <InlineCopyValue value={detail.toolUseId} display={shortenToken(detail.toolUseId)} />,
    },
    ...(detail.agentId !== undefined
      ? [
          {
            label: "Agent id",
            value: <span className="mono fs11">{shortenToken(detail.agentId)}</span>,
          },
        ]
      : []),
    ...(detail.agentType !== undefined
      ? [{ label: "Agent type", value: <span className="mono fs11">{detail.agentType}</span> }]
      : []),
    ...(detail.model !== undefined
      ? [{ label: "Model", value: <span className="mono fs11">{detail.model}</span> }]
      : []),
    ...baseRows(detail.timestamp),
    ...(detail.durationMs !== undefined
      ? [
          {
            label: "Duration",
            value: <span className="num fs12">{formatDuration(detail.durationMs)}</span>,
          },
        ]
      : []),
    ...(detail.toolCallCount !== undefined
      ? [
          {
            label: "Tool calls",
            value: (
              <span className="num fs12">
                {detail.toolCallCount}
                {detail.toolErrorCount !== undefined && detail.toolErrorCount > 0 && (
                  <span className="errtx"> · {detail.toolErrorCount} error</span>
                )}
              </span>
            ),
          },
        ]
      : []),
    ...(detail.outputTokens !== undefined
      ? [
          {
            label: "Tokens / cost",
            value: (
              <span className="num fs12">
                {formatTokens(detail.outputTokens)} ·{" "}
                {costLabel(detail.costUsd, detail.costIsComplete)}
              </span>
            ),
          },
        ]
      : []),
    {
      label: "Source",
      value: <span className="mono fs11">{sourceLabel(detail.line, detail.resultLine)}</span>,
    },
  ];

  return (
    <>
      <KvGrid rows={rows} />
      <div className="fx ac jb mt16">
        <span className="lbl">Prompt</span>
        {detail.prompt !== undefined && <CopyButton getText={() => detail.prompt ?? ""} />}
      </div>
      {detail.prompt !== undefined ? (
        <div className="code">{detail.prompt}</div>
      ) : (
        <div className="mono fs11 mut mt8">(no prompt captured)</div>
      )}

      <div className="fx ac jb mt16">
        <span className="lbl">{resultSectionLabel("Returned", detail.returnedText)}</span>
        {detail.returnedText !== undefined && (
          <CopyButton getText={() => detail.returnedText ?? ""} />
        )}
      </div>
      {detail.returnedText !== undefined ? (
        <>
          <div className="code">{detail.returnedText}</div>
          {isResultCapped(detail.returnedText) && (
            <div className="mono fs10 mut mt8">result captured up to 2,000 chars</div>
          )}
        </>
      ) : (
        <div className="mono fs11 mut mt8">(not returned yet)</div>
      )}
    </>
  );
}

function GenericKvBody({ rows }: { rows: KvRow[] }) {
  return <KvGrid rows={rows} />;
}

function headerName(detail: RecordDetailData): string | undefined {
  switch (detail.kind) {
    case "tool-call":
      return detail.name;
    case "subagent-launch":
      return detail.name ?? detail.agentType;
    case "task-notification":
      return detail.taskId;
    case "assistant-text":
      return detail.model;
    case "thinking":
      return detail.model;
    default:
      return undefined;
  }
}

function RecordBody({ detail, agent }: { detail: RecordDetailData; agent: string | undefined }) {
  switch (detail.kind) {
    case "tool-call":
      return <ToolCallBody detail={detail} agent={agent} />;
    case "subagent-launch":
      return <SubagentLaunchBody detail={detail} />;
    case "user":
      return <TextBody label="Message" text={detail.text} rows={baseRows(detail.timestamp)} />;
    case "assistant-text": {
      const rows: KvRow[] = [
        ...(detail.model !== undefined
          ? [{ label: "Model", value: <span className="mono fs11">{detail.model}</span> }]
          : []),
        ...(detail.outputTokens !== undefined
          ? [
              {
                label: "Output tok",
                value: <span className="num fs12">{formatTokens(detail.outputTokens)}</span>,
              },
            ]
          : []),
        ...(detail.costUsd !== undefined
          ? [
              {
                label: "Cost",
                value: <span className="num fs12 amb">{formatUsd(detail.costUsd)}</span>,
              },
            ]
          : []),
        ...baseRows(detail.timestamp),
      ];
      return <TextBody label="Message" text={detail.text} rows={rows} />;
    }
    case "thinking": {
      const rows: KvRow[] = [
        ...(detail.model !== undefined
          ? [{ label: "Model", value: <span className="mono fs11">{detail.model}</span> }]
          : []),
        {
          label: "Length",
          value: <span className="num fs12">{formatTokens(detail.charCount)} chars</span>,
        },
        ...baseRows(detail.timestamp),
      ];
      return (
        <>
          <KvGrid rows={rows} />
          <div className="mono fs11 mut mt16">
            Thinking content isn&apos;t retained by the parser — length only.
          </div>
        </>
      );
    }
    case "task-notification": {
      const rows: KvRow[] = [
        { label: "Task id", value: <span className="mono fs11">{detail.taskId}</span> },
        ...(detail.name !== undefined
          ? [{ label: "Name", value: <span className="mono fs11">{detail.name}</span> }]
          : []),
        { label: "Background", value: <span>{detail.background ? "yes" : "no"}</span> },
        ...(detail.status !== undefined
          ? [{ label: "Status", value: <span className="mono fs11">{detail.status}</span> }]
          : []),
        ...(detail.exitCode !== undefined
          ? [{ label: "Exit code", value: <span className="num fs12">{detail.exitCode}</span> }]
          : []),
        ...(detail.durationMs !== undefined
          ? [
              {
                label: "Duration",
                value: <span className="num fs12">{formatDuration(detail.durationMs)}</span>,
              },
            ]
          : []),
        ...(detail.startLine !== undefined
          ? [{ label: "Source", value: <span className="mono fs11">L{detail.startLine}</span> }]
          : []),
        ...baseRows(detail.timestamp),
      ];
      return <GenericKvBody rows={rows} />;
    }
    case "compaction": {
      const rows: KvRow[] = [
        ...(detail.trigger !== undefined
          ? [{ label: "Trigger", value: <span className="mono fs11">{detail.trigger}</span> }]
          : []),
        ...(detail.preTokens !== undefined && detail.postTokens !== undefined
          ? [
              {
                label: "Tokens",
                value: (
                  <span className="num fs12">
                    {formatTokens(detail.preTokens)} → {formatTokens(detail.postTokens)}
                  </span>
                ),
              },
            ]
          : []),
        ...baseRows(detail.timestamp),
      ];
      return <GenericKvBody rows={rows} />;
    }
    case "api-error": {
      const rows: KvRow[] = [
        ...(detail.message !== undefined
          ? [{ label: "Message", value: <span className="mono fs11 errtx">{detail.message}</span> }]
          : []),
        ...(detail.status !== undefined
          ? [{ label: "Status", value: <span className="num fs12">{detail.status}</span> }]
          : []),
        ...(detail.retryAttempt !== undefined
          ? [
              {
                label: "Retry attempt",
                value: <span className="num fs12">{detail.retryAttempt}</span>,
              },
            ]
          : []),
        ...baseRows(detail.timestamp),
      ];
      return <GenericKvBody rows={rows} />;
    }
    default:
      return null;
  }
}

/**
 * Record-detail slide-over (L3, screen 8) — see design-spec/17-record-detail.md.
 * Opens over the current lens (dimmed via the `.dim` wrapper the caller renders
 * around lens content), `esc`/backdrop-click/close-button all navigate back to
 * `closeHref`. See router.ts's `recordPath` doc comment for why this is
 * hash-addressed rather than component-local state.
 */
export function RecordDetail({ sessionRef, line, agent, closeHref }: Props) {
  const [detail, setDetail] = useState<RecordDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const navigate = useNavigate();

  // `sessionRef` is rebuilt fresh (a new object) on every caller render —
  // depend on its primitive parts instead so this effect doesn't re-fire
  // every render just because the caller re-rendered for an unrelated reason.
  const refSource = sessionRef.source;
  const refProject = refSource === "claude-code" ? sessionRef.project : undefined;
  const refId = sessionRef.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on sessionRef's primitive parts (see comment above), not the object itself.
  useEffect(() => {
    setDetail(null);
    setError(null);
    setNotFound(false);
    fetchRecordDetail(sessionRef, line, agent)
      .then((result) => {
        if ("notFound" in result) setNotFound(true);
        else setDetail(result.detail);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [refSource, refProject, refId, line, agent]);

  const close = () => {
    navigate(closeHref);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate(closeHref);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeHref, navigate]);

  const name = detail !== null ? headerName(detail) : undefined;

  return (
    <>
      <button
        type="button"
        className="so-backdrop"
        onClick={close}
        aria-label="Close record detail"
      />
      <div className="so" role="dialog" aria-modal="true">
        <div className="fx ac jb">
          <div className="fx ac gap10">
            <span className="lbl" style={{ color: "var(--amb)" }}>
              {detail !== null ? RECORD_KIND_LABEL[detail.kind] : "Record"}
            </span>
            {name !== undefined && (
              <span className="mono fs13" style={{ fontWeight: 500 }}>
                {name}
              </span>
            )}
          </div>
          <button type="button" className="mono fs11 mut so-close" onClick={close}>
            esc ✕
          </button>
        </div>

        {error !== null && (
          <div className="hpad mt16 mut" style={{ padding: 0 }}>
            Failed to load record: {error}
          </div>
        )}
        {notFound && <div className="mut mt16">Record not found at line {line}.</div>}
        {error === null && !notFound && detail === null && <div className="mut mt16">Loading…</div>}
        {detail !== null && <RecordBody detail={detail} agent={agent} />}
      </div>
    </>
  );
}
