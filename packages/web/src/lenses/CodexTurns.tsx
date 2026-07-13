import type { CodexSessionJson } from "../api.js";
import { formatDuration, formatTime, formatTokens } from "../format.js";
import { classifyModel, modelShortLabel } from "../modelClass.js";

interface Props {
  session: CodexSessionJson;
}

const EM_DASH = "—";

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="mbdg">
      <span className="mut">{label}</span> {value}
    </span>
  );
}

/**
 * Meta chips for Codex-specific session provenance — no Claude Code
 * equivalent exists for any of these (originator/CLI version/archived state/
 * agent role are Codex CLI concepts), so unlike `ContextCost`/`Overview`
 * this is a wholly new, Codex-only component rather than a branch inside a
 * shared one.
 */
function CodexMetaChips({ session }: Props) {
  const { codex } = session;
  const chips: Array<{ key: string; label: string; value: string }> = [];
  if (codex.originator !== undefined) {
    chips.push({ key: "originator", label: "origin", value: codex.originator });
  }
  if (codex.cliVersion !== undefined) {
    chips.push({ key: "cli", label: "codex", value: codex.cliVersion });
  }
  if (codex.agentRole !== undefined) {
    chips.push({ key: "role", label: "role", value: codex.agentRole });
  }
  if (codex.agentNickname !== undefined) {
    chips.push({ key: "nick", label: "as", value: codex.agentNickname });
  }
  if (codex.archived) {
    chips.push({ key: "archived", label: "", value: "archived" });
  }
  if (codex.reasoningOutputTokens > 0) {
    chips.push({
      key: "reasoning",
      label: "reasoning",
      value: formatTokens(codex.reasoningOutputTokens),
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="hpad fx gap8 mt16" style={{ flexWrap: "wrap" }}>
      {chips.map((chip) => (
        <MetaChip key={chip.key} label={chip.label} value={chip.value} />
      ))}
    </div>
  );
}

/**
 * Turns lens (Codex-only) — per-turn model/duration/token breakdown from
 * `codex.turns`, Codex's analog of the Claude Code Context & cost lens's
 * `TurnCompositionChart`. Rendered as a dense table (like
 * `contextCost/CostByModelTable`) rather than a stacked bar chart because
 * Codex turns carry a `model` per turn (a session can switch models
 * mid-conversation) and a `reasoningOutputTokens` figure with no Claude
 * counterpart — a bar chart tuned for Claude's fixed cache-read/write/fresh
 * stack wouldn't represent either honestly.
 */
export function CodexTurns({ session }: Props) {
  const turns = session.codex.turns;

  return (
    <>
      <CodexMetaChips session={session} />
      <div className="hpad mt16">
        <div className="pan" style={{ padding: "6px 0" }}>
          <div
            className="cmg hdr"
            style={{ gridTemplateColumns: "36px 1fr 96px 72px repeat(4, 84px)" }}
          >
            <span className="lbl">#</span>
            <span className="lbl">Model</span>
            <span className="lbl">Started</span>
            <span className="lbl cellr">Dur</span>
            <span className="lbl cellr">Input</span>
            <span className="lbl cellr">Cache read</span>
            <span className="lbl cellr">Output</span>
            <span className="lbl cellr">Reasoning</span>
          </div>
          {turns.length === 0 ? (
            <p className="mut fs12" style={{ padding: "10px 16px", margin: 0 }}>
              No turns recorded for this session.
            </p>
          ) : (
            turns.map((turn, i) => (
              <div
                className="cmg"
                key={turn.turnId ?? `turn-${String(i)}`}
                style={{ gridTemplateColumns: "36px 1fr 96px 72px repeat(4, 84px)" }}
              >
                <span className="mono fs11 mut">{i + 1}</span>
                <span className="fx ac gap6" title={turn.model}>
                  {turn.model !== undefined ? (
                    <>
                      <span className={`mdot c-${classifyModel(turn.model)}`} />
                      <span className="mono fs11">{modelShortLabel(turn.model)}</span>
                    </>
                  ) : (
                    <span className="mono fs11 mut">{EM_DASH}</span>
                  )}
                </span>
                <span className="mono fs11 mut">
                  {turn.startedAt !== undefined ? formatTime(turn.startedAt) : EM_DASH}
                </span>
                <span className="num fs12 cellr mut">
                  {turn.durationMs !== undefined ? formatDuration(turn.durationMs) : EM_DASH}
                </span>
                <span className="num fs12 cellr">{formatTokens(turn.inputTokens)}</span>
                <span className="num fs12 cellr">{formatTokens(turn.cacheReadTokens)}</span>
                <span className="num fs12 cellr">{formatTokens(turn.outputTokens)}</span>
                <span
                  className={
                    turn.reasoningOutputTokens === 0 ? "num fs12 cellr mut" : "num fs12 cellr"
                  }
                >
                  {formatTokens(turn.reasoningOutputTokens)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
