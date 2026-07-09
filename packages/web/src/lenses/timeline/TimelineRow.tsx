import { memo } from "react";
import type { TimelineEntry } from "../../api.js";
import { formatDuration, formatTime, formatTokens, formatUsd } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";

export interface TimelineRowProps {
  entry: TimelineEntry;
  project: string;
  id: string;
  expanded: boolean;
  onToggleExpand: (line: number) => void;
  registerRef: (line: number, el: HTMLDivElement | null) => void;
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

/** Source-line ref — always in the DOM (accessibility), amber only on `.blk:hover` (CSS). */
function SourceLine({ line, auto = false }: { line: number; auto?: boolean }) {
  return (
    <span className="ln" style={auto ? { marginLeft: "auto" } : undefined}>
      L{line}
    </span>
  );
}

function UserBlock({ entry }: { entry: Extract<TimelineEntry, { kind: "user" }> }) {
  return (
    <div className="blk blk-q">
      <div className="bhd">
        <span className="lbl" style={{ color: "var(--amb)" }}>
          User
        </span>
        <SourceLine line={entry.line} />
      </div>
      <div className="btxt">{entry.text}</div>
    </div>
  );
}

function AssistantBlock({ entry }: { entry: Extract<TimelineEntry, { kind: "assistant-text" }> }) {
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
        <SourceLine line={entry.line} auto />
      </div>
      <div className="btxt">{entry.text}</div>
    </div>
  );
}

function ThinkingBlock({ entry }: { entry: Extract<TimelineEntry, { kind: "thinking" }> }) {
  return (
    <div className="blk dim">
      <div className="bhd">
        <span className="mut">▸</span>
        <span className="lbl">Thinking</span>
        <span className="mono fs10 mut">{formatTokens(entry.charCount)} chars · collapsed</span>
        <SourceLine line={entry.line} auto />
      </div>
    </div>
  );
}

function ToolBlock({
  entry,
  expanded,
  onToggleExpand,
}: {
  entry: Extract<TimelineEntry, { kind: "tool-call" }>;
  expanded: boolean;
  onToggleExpand: (line: number) => void;
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
      <button
        type="button"
        className="bhd tool-hd"
        onClick={() => onToggleExpand(entry.line)}
        aria-expanded={expanded}
      >
        <span className={isError ? "errtx" : expanded ? "amb" : "mut"}>{expanded ? "▾" : "▸"}</span>
        <span className="lbl" style={isError ? { color: "var(--err)" } : undefined}>
          {isError ? "Tool · error" : "Tool"}
        </span>
        <span className="mono fs12">
          {entry.name} {entry.inputSummary}
        </span>
        {meta !== undefined && (
          <span className={isError ? "mono fs10 errtx" : "mono fs10 mut"}>{meta}</span>
        )}
        <SourceLine line={entry.line} auto />
      </button>
      {isError && entry.resultSummary !== undefined && (
        <div className="btxt mono fs11 errtx" style={{ opacity: 0.85 }}>
          {entry.resultSummary}
        </div>
      )}
      {expanded && (
        // resultLine is kept as data-line for the record-detail slide-over landing in the next PR.
        <div className="code" data-line={entry.resultLine ?? entry.line}>
          {codeLines.join("\n")}
        </div>
      )}
    </div>
  );
}

function SubagentBlock({
  entry,
  project,
  id,
}: {
  entry: Extract<TimelineEntry, { kind: "subagent-launch" }>;
  project: string;
  id: string;
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
  const detailHref =
    entry.agentId !== undefined
      ? `#/session/${encodeURIComponent(project)}/${encodeURIComponent(id)}/agent/${encodeURIComponent(entry.agentId)}`
      : undefined;

  return (
    <div className="blk" style={{ borderStyle: "double", borderWidth: "3px" }}>
      <div className="bhd">
        <span className="amb">⟡</span>
        <span className="lbl">Subagent</span>
        <span className="mono fs12">{displayName}</span>
        <ModelBadge model={entry.model} />
        {metaParts.length > 0 && <span className="mono fs10 mut">{metaParts.join(" · ")}</span>}
        {detailHref !== undefined ? (
          <a className="linkc mono fs10" style={{ marginLeft: "auto" }} href={detailHref}>
            open detail →
          </a>
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

function TaskBlock({ entry }: { entry: Extract<TimelineEntry, { kind: "task-notification" }> }) {
  const metaParts: string[] = [];
  if (entry.status !== undefined) metaParts.push(entry.status);
  if (entry.exitCode !== undefined) metaParts.push(`exit ${entry.exitCode}`);
  if (entry.durationMs !== undefined) metaParts.push(formatDuration(entry.durationMs));
  metaParts.push(`L${entry.line}`);

  return (
    <div className="blk dim" style={{ background: "transparent" }}>
      <div className="bhd">
        <span className="mut">◷</span>
        <span className="lbl">Task</span>
        <span className="mono fs12">
          {entry.taskId} <span className="mut">background</span>
          {entry.name !== undefined && ` · ${entry.name}`}
        </span>
        <span className="mono fs10 mut">{metaParts.join(" · ")}</span>
      </div>
    </div>
  );
}

function ApiErrorBlock({ entry }: { entry: Extract<TimelineEntry, { kind: "api-error" }> }) {
  return (
    <div className="blk" style={{ borderColor: "var(--err)" }}>
      <div className="bhd">
        <span className="lbl" style={{ color: "var(--err)" }}>
          API error
        </span>
        <SourceLine line={entry.line} auto />
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
}: TimelineRowProps) {
  if (entry.kind === "compaction") {
    return <CompactionBreak entry={entry} registerRef={registerRef} />;
  }

  return (
    <div className="tlrow" ref={(el) => registerRef(entry.line, el)}>
      <span className="gut">
        {entry.timestamp !== undefined ? formatTime(entry.timestamp) : ""}
      </span>
      {entry.kind === "user" && <UserBlock entry={entry} />}
      {entry.kind === "assistant-text" && <AssistantBlock entry={entry} />}
      {entry.kind === "thinking" && <ThinkingBlock entry={entry} />}
      {entry.kind === "tool-call" && (
        <ToolBlock entry={entry} expanded={expanded} onToggleExpand={onToggleExpand} />
      )}
      {entry.kind === "subagent-launch" && (
        <SubagentBlock entry={entry} project={project} id={id} />
      )}
      {entry.kind === "task-notification" && <TaskBlock entry={entry} />}
      {entry.kind === "api-error" && <ApiErrorBlock entry={entry} />}
    </div>
  );
});
