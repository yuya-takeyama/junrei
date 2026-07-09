import { useMemo, useState } from "react";
import type { SessionJson } from "../../api.js";
import { formatTokens, formatUsd } from "../../format.js";
import { MAIN_ID, type SelectedId } from "./agentTree.js";
import { buildFlameRows, type FlameBlock, type FlameMetric } from "./flame.js";

interface Props {
  session: SessionJson;
  selected: SelectedId;
  onSelect: (id: SelectedId) => void;
}

const LABEL_WIDTH_THRESHOLD = 5;

function formatValue(value: number, metric: FlameMetric): string {
  return metric === "cost" ? formatUsd(value) : formatTokens(value);
}

function blockLabel(block: FlameBlock, metric: FlameMetric): string {
  if (block.placeholder || block.widthPct < LABEL_WIDTH_THRESHOLD) return "";
  return `${block.label} · ${formatValue(block.value, metric)}`;
}

function FlameRow({
  blocks,
  metric,
  selected,
  onSelect,
  onHover,
}: {
  blocks: FlameBlock[];
  metric: FlameMetric;
  selected: SelectedId;
  onSelect: (id: SelectedId) => void;
  onHover: (block: FlameBlock | null) => void;
}) {
  return (
    <div className="frow">
      {blocks.map((block) =>
        block.placeholder ? (
          <div
            key={block.key}
            className="fb"
            style={{
              width: `${block.widthPct}%`,
              background: "transparent",
              borderColor: "transparent",
            }}
          />
        ) : (
          <button
            key={block.key}
            type="button"
            className={`fb${block.colorClass !== undefined ? ` c-${block.colorClass}` : ""}${
              block.agentId === selected || (block.key === "main-self" && selected === MAIN_ID)
                ? " sel"
                : ""
            }`}
            style={{ width: `${block.widthPct}%` }}
            onClick={() => onSelect(block.agentId ?? MAIN_ID)}
            onMouseEnter={() => onHover(block)}
            onMouseLeave={() => onHover(null)}
          >
            {blockLabel(block, metric)}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * Flame view — width = cost (or tokens, toggle). See
 * design-spec/13-orchestration.md's 3-row `.frow`/`.fb` sample.
 */
export function FlameView({ session, selected, onSelect }: Props) {
  const [metric, setMetric] = useState<FlameMetric>("cost");
  const [hovered, setHovered] = useState<FlameBlock | null>(null);
  const { total, row2, row3 } = useMemo(() => buildFlameRows(session, metric), [session, metric]);

  return (
    <div className="hpad mt16">
      <div className="pan" style={{ padding: "16px 20px", position: "relative" }}>
        <div className="chartcap">
          <span className="lbl">Same toggle · Flame — width = {metric}</span>
          <span className="fx ac gap8">
            <button
              type="button"
              className={metric === "cost" ? "chip on" : "chip"}
              onClick={() => setMetric("cost")}
            >
              cost
            </button>
            <button
              type="button"
              className={metric === "tokens" ? "chip on" : "chip"}
              onClick={() => setMetric("tokens")}
            >
              tokens
            </button>
            <span className="mono fs11 mut">{formatValue(total, metric)} total</span>
          </span>
        </div>
        <div className="frow">
          <div
            className="fb"
            style={{ width: "100%", background: "var(--bd)", color: "var(--tx)" }}
          >
            session · {formatValue(total, metric)}
          </div>
        </div>
        <FlameRow
          blocks={row2}
          metric={metric}
          selected={selected}
          onSelect={onSelect}
          onHover={setHovered}
        />
        <FlameRow
          blocks={row3}
          metric={metric}
          selected={selected}
          onSelect={onSelect}
          onHover={setHovered}
        />
        {hovered !== null && (
          <div
            className="chart-tooltip"
            style={{ left: `${hovered.widthPct === 0 ? 0 : hovered.widthPct}%`, top: "40px" }}
          >
            {hovered.label || "block"} · {formatValue(hovered.value, metric)} ·{" "}
            {hovered.parentValue > 0 ? Math.round((hovered.value / hovered.parentValue) * 100) : 0}%
            of parent
          </div>
        )}
        <div className="ann mt8">
          third row: nested agents · width = cost (or tokens, toggle) · hover a block for tokens / %
          of parent
        </div>
      </div>
    </div>
  );
}
