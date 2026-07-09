import { useEffect, useState } from "react";
import type { AnySessionJson } from "../api.js";
import { MAIN_ID, type SelectedId } from "./orchestration/agentTree.js";
import { FlameView } from "./orchestration/FlameView.js";
import { ModelMixStrip } from "./orchestration/ModelMixStrip.js";
import { TreeView } from "./orchestration/TreeView.js";
import { WaterfallView } from "./orchestration/WaterfallView.js";

interface Props {
  session: AnySessionJson;
}

type ViewDial = "tree" | "waterfall" | "flame";

const DIAL_STOPS: readonly ViewDial[] = ["tree", "waterfall", "flame"];

/**
 * Orchestration lens (L2) — whether subagent delegation was cost-effective.
 * One view dial (tree/waterfall/flame) over the same subagent-forest
 * dataset; selection persists across all three. See
 * design-spec/13-orchestration.md.
 */
export function Orchestration({ session }: Props) {
  const [dial, setDial] = useState<ViewDial>("tree");
  const [selected, setSelected] = useState<SelectedId>(MAIN_ID);

  // Selection is session-scoped — jumping to a different session (e.g. via a
  // drill-down link) shouldn't keep a stale agentId selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset key is session.sessionId, not selected/dial
  useEffect(() => {
    setSelected(MAIN_ID);
  }, [session.sessionId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && /^(input|textarea)$/i.test(target.tagName)) return;
      if (e.key === "1") setDial("tree");
      else if (e.key === "2") setDial("waterfall");
      else if (e.key === "3") setDial("flame");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (session.subagentCount === 0) {
    return (
      <div className="hpad mt16">
        <div className="pan tile mut">This session didn&apos;t delegate to any subagents.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="hpad fx ac jb mt12" style={{ flexWrap: "wrap", gap: "10px" }}>
        <div className="fx ac gap12">
          <span className="lbl">View</span>
          <div className="dial">
            {DIAL_STOPS.map((stop) => (
              <button
                key={stop}
                type="button"
                className={stop === dial ? "dseg on" : "dseg"}
                onClick={() => setDial(stop)}
              >
                {stop}
              </button>
            ))}
          </div>
        </div>
        <ModelMixStrip session={session} />
      </div>

      {dial === "tree" && <TreeView session={session} selected={selected} onSelect={setSelected} />}
      {dial === "waterfall" && (
        <WaterfallView session={session} selected={selected} onSelect={setSelected} />
      )}
      {dial === "flame" && (
        <FlameView session={session} selected={selected} onSelect={setSelected} />
      )}
    </div>
  );
}
