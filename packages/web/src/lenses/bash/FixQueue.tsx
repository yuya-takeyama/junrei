import type { BashStatsJson } from "../../api.js";
import { CopyButton } from "../recordDetail/CopyButton.js";
import { buildOpportunityCards, capList, type OpportunityCardModel } from "./bashLensFormat.js";

/** Cards beyond this rank collapse into a "+N more not shown" footer — `TaskExecutionsPanel`'s cap-with-footer convention. Opportunities are already ranked (savings desc — see `computeBashOpportunities`), so the top `FIX_QUEUE_LIMIT` are the ones worth screen space. */
const FIX_QUEUE_LIMIT = 10;

interface Props {
  opportunities: BashStatsJson["opportunities"];
  /** Which cards' evidence lists are expanded — owned by `Bash.tsx` (one `useState` up, same pattern as every sort spec in this lens), so this stays a pure function component. */
  expandedKeys: ReadonlySet<string>;
  onToggleExpand: (key: string) => void;
  /** Opens the record slide-over (L3) at an evidence row's own line — same `onOpenRecord` wiring `HeavyHittersTable` uses. */
  onOpenRecord?: (line: number, agentId?: string) => void;
}

function SavingsFigure({ card }: { card: OpportunityCardModel }) {
  if (card.savingsIsCandidate) {
    return <span className="chip mut">candidate</span>;
  }
  return (
    <span className="mono fs13 amb" style={{ fontWeight: 600 }}>
      {card.savingsText}
      {card.savingsIsHeuristic && (
        <span
          className="mut"
          title={card.heuristicNote}
          style={{ cursor: "help", marginLeft: "4px" }}
        >
          ⓘ
        </span>
      )}
    </span>
  );
}

function EvidenceList({
  card,
  onOpenRecord,
}: {
  card: OpportunityCardModel;
  onOpenRecord?: (line: number, agentId?: string) => void;
}) {
  return (
    <div className="col gap4 mt8">
      {card.evidence.map((e) => (
        <div className="fx ac gap8 mono fs10" key={e.key}>
          <span className={e.thread.isMain ? "mut" : "amb"} style={{ width: "80px", flex: "none" }}>
            {e.thread.text}
          </span>
          {onOpenRecord !== undefined ? (
            <button
              type="button"
              className="lnbtn mono fs10 mut"
              onClick={() => onOpenRecord(e.line, e.agentId)}
            >
              L{e.line}
            </button>
          ) : (
            <span className="mut">L{e.line}</span>
          )}
          <span className="mut">{e.resultCharsText}</span>
          {e.estUsdText !== undefined && <span className="mut">{e.estUsdText}</span>}
        </div>
      ))}
    </div>
  );
}

function FixQueueCard({
  card,
  expanded,
  onToggleExpand,
  onOpenRecord,
}: {
  card: OpportunityCardModel;
  expanded: boolean;
  onToggleExpand: (key: string) => void;
  onOpenRecord?: (line: number, agentId?: string) => void;
}) {
  return (
    <div className="pan" style={{ padding: "14px 16px" }}>
      <div className="fx ac jb" style={{ flexWrap: "wrap", gap: "10px" }}>
        <div className="fx ac gap8" style={{ flexWrap: "wrap" }}>
          <span className="mono fs11 mut">#{card.rank}</span>
          <span className="chip">{card.class}</span>
          <span className="chip mut">{card.lever}</span>
        </div>
        <SavingsFigure card={card} />
      </div>
      <div className="mono fs12 mt8">{card.title}</div>
      <div className="mono fs10 mut mt8">
        {card.occurrenceCount} occurrence{card.occurrenceCount === 1 ? "" : "s"} ·{" "}
        {card.totalCharsText} chars ·{" "}
        {card.threads.map((t, i) => (
          <span key={t.text}>
            {i > 0 && ", "}
            <span className={t.isMain ? "mut" : "amb"}>{t.text}</span>
          </span>
        ))}
      </div>

      <div className="fx ac jb mt16">
        <span className="lbl">Fix</span>
        <CopyButton getText={() => card.fixText} />
      </div>
      <div className="code">{card.fixText}</div>

      <button
        type="button"
        className="exp-toggle mono fs10 mut mt8"
        onClick={() => onToggleExpand(card.key)}
        aria-expanded={expanded}
      >
        {expanded ? "▾" : "▸"} evidence ({card.evidence.length})
      </button>
      {expanded && (
        <EvidenceList card={card} {...(onOpenRecord !== undefined && { onOpenRecord })} />
      )}
    </div>
  );
}

/**
 * Fix Queue (Bash lens — the core section) — ranked, templated fix
 * suggestions from `BashStats.opportunities` (`computeBashOpportunities`,
 * `@junrei/core`'s `bash-opportunities.ts`), already sorted savings-desc by
 * the core engine. Quantitative-plus-templates throughout: `title`/`fixText`
 * render VERBATIM from core (see `OpportunityCardModel`'s doc comment in
 * `bashLensFormat.ts`) — this component never generates its own advice text,
 * only formats the numeric fields core already computed.
 *
 * Zero opportunities renders a POSITIVE empty state ("no recoverable waste
 * detected") — the absence of a Fix Queue entry is good news, not a
 * "nothing to show" placeholder.
 *
 * Stays a pure function component: the evidence-expand toggle's state
 * (`expandedKeys`/`onToggleExpand`) is owned by `Bash.tsx`, same "state
 * lives one level up" pattern every sortable table in this lens already
 * uses — this repo's component tests call components directly as functions
 * and walk the returned element tree, which only works hook-free. The one
 * genuinely stateful leaf is the existing `CopyButton` (`recordDetail/
 * CopyButton.tsx`, reused as-is rather than re-invented) — its own
 * "copied ✓" flash state stays self-contained inside that component.
 */
export function FixQueue({ opportunities, expandedKeys, onToggleExpand, onOpenRecord }: Props) {
  if (opportunities.length === 0) {
    return (
      <div className="pan tile mut" style={{ padding: "14px 16px" }}>
        no recoverable waste detected
      </div>
    );
  }

  const cards = buildOpportunityCards(opportunities);
  const { shown, hiddenCount } = capList(cards, FIX_QUEUE_LIMIT);

  return (
    <div className="col gap12">
      {shown.map((card) => (
        <FixQueueCard
          key={card.key}
          card={card}
          expanded={expandedKeys.has(card.key)}
          onToggleExpand={onToggleExpand}
          {...(onOpenRecord !== undefined && { onOpenRecord })}
        />
      ))}
      {hiddenCount > 0 && <div className="mono fs11 mut">+{hiddenCount} more not shown</div>}
    </div>
  );
}
