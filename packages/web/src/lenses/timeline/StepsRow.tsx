import { formatTokens } from "../../format.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";
import type { TurnGroup } from "./turnGroups.js";

export type TurnStep = NonNullable<TurnGroup["steps"]>[number];

/** Compact "sN · in X · out Y" line — the collapsed preview's per-step treatment (no cache columns, mock's exact text). */
export function formatStepCompact(step: TurnStep, index: number): string {
  return `s${String(index)} · in ${formatTokens(step.inputTokens)} · out ${formatTokens(step.outputTokens)}`;
}

/** Full per-call breakdown line for the expanded steps list. */
export function formatStepDetail(step: TurnStep, index: number): string {
  return (
    `s${String(index)} · in ${formatTokens(step.inputTokens)} · ` +
    `c·r ${formatTokens(step.cacheReadTokens)} · c·w ${formatTokens(step.cacheCreationTokens)} · ` +
    `out ${formatTokens(step.outputTokens)}`
  );
}

/** First two steps, compact-formatted — the collapsed row's inline preview. */
export function stepPreviewLines(steps: readonly TurnStep[]): string[] {
  return steps.slice(0, 2).map((step, i) => formatStepCompact(step, i + 1));
}

/** "… sN" overflow trailer once more than two steps exist, else undefined. */
export function stepOverflowLabel(steps: readonly TurnStep[]): string | undefined {
  return steps.length > 2 ? `… s${String(steps.length)}` : undefined;
}

/** Model dot, no label — reused inline before a step's own text so mixed-model turns read at a glance which call used which model. */
function StepModelDot({ model }: { model: string | undefined }) {
  if (model === undefined) return null;
  return (
    <span className="dcl">
      <span className={`mdot c-${classifyModel(model)}`} />
    </span>
  );
}

function StepAttribution({ model, showModel }: { model: string | undefined; showModel: boolean }) {
  if (!showModel) return null;
  return (
    <>
      <StepModelDot model={model} />
      {model !== undefined && (
        <span className="mono fs11 mut noshrink">{modelShortLabel(model)}</span>
      )}
    </>
  );
}

interface Props {
  steps: readonly TurnStep[];
  /** Attribution only pays off once a turn actually spans more than one model — dot+label is noise otherwise (see TurnRow's own `ModelCluster`). */
  mixedModel: boolean;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Per-API-call breakdown inside an expanded turn (design mock panel 2a's
 * `.steprow`) — rendered at the top of a turn's `.ex` content only when
 * `group.steps` is defined and non-empty (presence-driven: Codex turns never
 * define `steps`, so this component simply never mounts for them).
 *
 * Collapsed by default: one line doubles as the toggle AND a preview of the
 * first two steps, so the breakdown is legible before expanding. Expanded:
 * every step gets its own full-detail line below the toggle.
 */
export function StepsRow({ steps, mixedModel, expanded, onToggle }: Props) {
  if (steps.length === 0) return null;

  return (
    <div>
      <div className="steprow">
        <button type="button" className="stepstoggle" onClick={onToggle} aria-expanded={expanded}>
          <span className={expanded ? "amb" : "mut"}>{expanded ? "▾" : "▸"}</span>
          {`steps ×${String(steps.length)}`}
        </button>
        {!expanded &&
          steps.slice(0, 2).map((step, i) => (
            // Steps carry no id (line/timestamp are dropped at the adapter —
            // see turnGroups.ts) and never reorder within a turn, so the
            // index is a stable key here.
            // biome-ignore lint/suspicious/noArrayIndexKey: stable, non-reordering list
            <span key={i} className="fx ac gap4">
              <StepAttribution model={step.model} showModel={mixedModel} />
              <span>{formatStepCompact(step, i + 1)}</span>
            </span>
          ))}
        {!expanded && stepOverflowLabel(steps) !== undefined && (
          <span className="mut">{stepOverflowLabel(steps)}</span>
        )}
      </div>
      {expanded &&
        steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable, non-reordering list (see above)
          <div key={i} className="steprow">
            <StepAttribution model={step.model} showModel={mixedModel} />
            <span>{formatStepDetail(step, i + 1)}</span>
          </div>
        ))}
    </div>
  );
}
