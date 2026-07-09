import { memo } from "react";
import { Link } from "react-router";
import type { TimelineEntry } from "../../api.js";
import { formatDuration, formatTime, formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import { agentPath } from "../../router.js";

export interface TimelineRowProps {
  entry: TimelineEntry;
  project: string;
  id: string;
  expanded: boolean;
  onToggleExpand: (line: number) => void;
  registerRef: (line: number, el: HTMLDivElement | null) => void;
  /** Opens the record slide-over (L3, screen 8) for a given source line. */
  onOpenRecord: (line: number) => void;
}

function ModelBadge({ model }: { model: string | undefined }) {
  if (model === undefined) return null;
  return (
    <span className="mbdg">
      <span className={`mdot c-${classifyModel(model)}`} />
      {modelShortLabel(model)}
    </span>
  );
}

/**
 * Source-line ref — always in the DOM (accessibility), amber only on
 * `.blk:hover` (CSS). Doubles as the affordance that opens the record
 * slide-over (design-spec/17-record-detail.md) for this block's source line.
 */
function SourceLine({
  line,
  auto = false,
  onOpenRecord,
}: {
  line: number;
  auto?: boolean;
  onOpenRecord: (line: number) => void;
}) {
  return (
    <button
      type="button"
      className="ln lnbtn"
      style={auto ? { marginLeft: "auto" } : undefined}
      onClick={() => onOpenRecord(line)}
      title="Open record detail"
    >
      L{line}
    </button>
  );
}

function UserBlock({
  entry,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "user" }>;
  onOpenRecord: (line: number) => void;
}) {
  return (
    <div className="blk blk-q">
      <div className="bhd">
        <span className="lbl" style={{ color: "var(--amb)" }}>
          User
        </span>
        <SourceLine line={entry.line} onOpenRecord={onOpenRecord} />
      </div>
      <div className="btxt">{entry.text}</div>
    </div>
  );
}

function AssistantBlock({
  entry,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "assistant-text" }>;
  onOpenRecord: (line: number) => void;
}) {
  // apiDurationMs is never populated by the API today — omit rather than fake a duration.
  const metaParts: string[] = [];
  if (entry.outputTokens !== undefined) metaParts.push(`${formatTokens(entry.outputTokens)} out`);
  if (entry.costUsd !== undefined) metaParts.push(formatUsd(entry.costUsd));

  return (
    <div className="blk">
      <div className="bhd">
        <span className="lbl">Assistant</span>
        <ModelBadge model={entry.model} />
        {metaParts.length > 0 && <span className="mono fs10 mut">{metaParts.join(" · ")}</span>}
        <SourceLine line={entry.line} auto onOpenRecord={onOpenRecord} />
      </div>
      <div className="btxt">{entry.text}</div>
    </div>
  );
}

function ThinkingBlock({
  entry,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "thinking" }>;
  onOpenRecord: (line: number) => void;
}) {
  return (
    <div className="blk dim">
      <div className="bhd">
        <span className="mut">▸</span>
        <span className="lbl">Thinking</span>
        <span className="mono fs10 mut">{formatTokens(entry.charCount)} chars · collapsed</span>
        <SourceLine line={entry.line} auto onOpenRecord={onOpenRecord} />
      </div>
    </div>
  );
}

function ToolBlock({
  entry,
  expanded,
  onToggleExpand,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "tool-call" }>;
  expanded: boolean;
  onToggleExpand: (line: number) => void;
  onOpenRecord: (line: number) => void;
}) {
  const isError = entry.status === "error";
  const metaParts: string[] = [];
  if (isError) metaParts.push("error");
  else if (entry.resultSummary !== undefined) metaParts.push(entry.resultSummary);
  if (entry.durationMs !== undefined) metaParts.push(formatDuration(entry.durationMs));
  const meta = metaParts.length > 0 ? `→ ${metaParts.join(" · ")}` : undefined;
  const codeLines = [
    entry.resultSummary ?? "(no result captured)",
    entry.resultLineCount !== undefined ? `${entry.resultLineCount} lines` : undefined,
  ].filter((line): line is string => line !== undefined);

  return (
    <div className="blk" style={isError ? { borderColor: "var(--err)" } : undefined}>
      <div className="bhd">
        <button
          type="button"
          className="tool-hd"
          onClick={() => onToggleExpand(entry.line)}
          aria-expanded={expanded}
        >
          <span className={isError ? "errtx" : expanded ? "amb" : "mut"}>
            {expanded ? "▾" : "▸"}
          </span>
          <span className="lbl" style={isError ? { color: "var(--err)" } : undefined}>
            {isError ? "Tool · error" : "Tool"}
          </span>
          <span className="mono fs12">
            {entry.name} {entry.inputSummary}
          </span>
          {meta !== undefined && (
            <span className={isError ? "mono fs10 errtx" : "mono fs10 mut"}>{meta}</span>
          )}
        </button>
        <SourceLine line={entry.line} auto onOpenRecord={onOpenRecord} />
      </div>
      {isError && entry.resultSummary !== undefined && (
        <div className="btxt mono fs11 errtx" style={{ opacity: 0.85 }}>
          {entry.resultSummary}
        </div>
      )}
      {expanded && (
        // Note: resultLine (the tool_result carrier line) isn't independently
        // addressable by the record API — record detail is always keyed by
        // the tool_use's own line, which SourceLine above already opens.
        <div className="code">{codeLines.join("\n")}</div>
      )}
    </div>
  );
}

function SubagentBlock({
  entry,
  project,
  id,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "subagent-launch" }>;
  project: string;
  id: string;
  onOpenRecord: (line: number) => void;
}) {
  const displayName = entry.name ?? entry.agentType ?? "subagent";
  const metaParts: string[] = [];
  if (entry.outputTokens !== undefined) {
    metaParts.push(`${formatTokens(entry.outputTokens)} tok`);
    if (entry.costUsd !== undefined) {
      metaParts.push(`${formatUsd(entry.costUsd)}${entry.costIsComplete === false ? "*" : ""}`);
    }
    if (entry.durationMs !== undefined) metaParts.push(formatDuration(entry.durationMs));
  }
  return (
    <div className="blk" style={{ borderStyle: "double", borderWidth: "3px" }}>
      <div className="bhd">
        <span className="amb">⟡</span>
        <span className="lbl">Subagent</span>
        <span className="mono fs12">{displayName}</span>
        <ModelBadge model={entry.model} />
        {metaParts.length > 0 && <span className="mono fs10 mut">{metaParts.join(" · ")}</span>}
        <SourceLine line={entry.line} onOpenRecord={onOpenRecord} />
        {entry.agentId !== undefined ? (
          <Link
            className="linkc mono fs10"
            style={{ marginLeft: "auto" }}
            to={agentPath(project, id, entry.agentId)}
          >
            open detail →
          </Link>
        ) : (
          <span className="linkc mono fs10 mut" style={{ marginLeft: "auto" }}>
            open detail →
          </span>
        )}
      </div>
      {entry.promptPreview !== undefined && (
        <div className="btxt mut" style={{ fontSize: "12.5px" }}>
          &quot;{entry.promptPreview}&quot;
        </div>
      )}
      {entry.returnedChars !== undefined && (
        <div className="mono fs10 mut mt8">
          returned {formatTokens(entry.returnedChars)} chars to parent
          {entry.resultLine !== undefined && ` · L${entry.resultLine}`}
        </div>
      )}
    </div>
  );
}

function TaskBlock({
  entry,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "task-notification" }>;
  onOpenRecord: (line: number) => void;
}) {
  const metaParts: string[] = [];
  if (entry.status !== undefined) metaParts.push(entry.status);
  if (entry.exitCode !== undefined) metaParts.push(`exit ${entry.exitCode}`);
  if (entry.durationMs !== undefined) metaParts.push(formatDuration(entry.durationMs));

  return (
    <div className="blk dim" style={{ background: "transparent" }}>
      <div className="bhd">
        <span className="mut">◷</span>
        <span className="lbl">Task</span>
        <span className="mono fs12">
          {entry.taskId} <span className="mut">background</span>
          {entry.name !== undefined && ` · ${entry.name}`}
        </span>
        {metaParts.length > 0 && <span className="mono fs10 mut">{metaParts.join(" · ")}</span>}
        <SourceLine line={entry.line} auto onOpenRecord={onOpenRecord} />
      </div>
    </div>
  );
}

function ApiErrorBlock({
  entry,
  onOpenRecord,
}: {
  entry: Extract<TimelineEntry, { kind: "api-error" }>;
  onOpenRecord: (line: number) => void;
}) {
  return (
    <div className="blk" style={{ borderColor: "var(--err)" }}>
      <div className="bhd">
        <span className="lbl" style={{ color: "var(--err)" }}>
          API error
        </span>
        <SourceLine line={entry.line} auto onOpenRecord={onOpenRecord} />
      </div>
      {entry.message !== undefined && (
        <div className="btxt mono fs11 errtx" style={{ opacity: 0.85 }}>
          {entry.message}
        </div>
      )}
    </div>
  );
}

function CompactionBreak({
  entry,
  registerRef,
}: {
  entry: Extract<TimelineEntry, { kind: "compaction" }>;
  registerRef: (line: number, el: HTMLDivElement | null) => void;
}) {
  const timeLabel = entry.timestamp !== undefined ? formatTime(entry.timestamp) : undefined;
  const tokenLabel =
    entry.preTokens !== undefined && entry.postTokens !== undefined
      ? `${formatTokens(entry.preTokens)} → ${formatTokens(entry.postTokens)} tokens`
      : undefined;
  const label = ["✕ compaction", timeLabel, tokenLabel].filter((p) => p !== undefined).join(" · ");

  return (
    <div
      className="cbreak"
      style={{ marginLeft: "54px" }}
      ref={(el) => registerRef(entry.line, el)}
    >
      <span className="cbline" />
      <span>{label}</span>
      <span className="cbline" />
    </div>
  );
}

/**
 * One transcript entry — dispatches to the block variant for its kind (see
 * design-spec/12-timeline.md's block-variant catalogue). Memoized so
 * toggling one tool-call's expansion, or hovering a block (pure CSS, no
 * state), never re-renders its siblings.
 */
export const TimelineRow = memo(function TimelineRow({
  entry,
  project,
  id,
  expanded,
  onToggleExpand,
  registerRef,
  onOpenRecord,
}: TimelineRowProps) {
  if (entry.kind === "compaction") {
    return <CompactionBreak entry={entry} registerRef={registerRef} />;
  }

  return (
    <div className="tlrow" ref={(el) => registerRef(entry.line, el)}>
      <span className="gut">
        {entry.timestamp !== undefined ? formatTime(entry.timestamp) : ""}
      </span>
      {entry.kind === "user" && <UserBlock entry={entry} onOpenRecord={onOpenRecord} />}
      {entry.kind === "assistant-text" && (
        <AssistantBlock entry={entry} onOpenRecord={onOpenRecord} />
      )}
      {entry.kind === "thinking" && <ThinkingBlock entry={entry} onOpenRecord={onOpenRecord} />}
      {entry.kind === "tool-call" && (
        <ToolBlock
          entry={entry}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onOpenRecord={onOpenRecord}
        />
      )}
      {entry.kind === "subagent-launch" && (
        <SubagentBlock entry={entry} project={project} id={id} onOpenRecord={onOpenRecord} />
      )}
      {entry.kind === "task-notification" && (
        <TaskBlock entry={entry} onOpenRecord={onOpenRecord} />
      )}
      {entry.kind === "api-error" && <ApiErrorBlock entry={entry} onOpenRecord={onOpenRecord} />}
    </div>
  );
});
