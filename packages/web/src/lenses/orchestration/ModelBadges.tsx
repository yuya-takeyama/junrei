import type { ModelUsageSummary } from "../../api.js";
import { classifyModel, modelShortLabel } from "../../modelClass.js";

function Badge({ model }: { model: string }) {
  return (
    <span className="mbdg">
      <span className={`mdot c-${classifyModel(model)}`} />
      {modelShortLabel(model)}
    </span>
  );
}

/**
 * Every active model for a node/session, as `.mbdg` badges — a single
 * active model renders the exact same lone-badge markup as before (no
 * layout change for the common case); zero active models renders nothing,
 * leaving the "—" placeholder to whichever caller already has one (TreeView
 * rows) or omitting the badge entirely (DetailPanel's title line, which
 * never showed one for an unpriced/unknown model either). See
 * `activeModels` in agentTree.ts for what counts as "active".
 */
export function ModelBadges({ models }: { models: readonly ModelUsageSummary[] }) {
  if (models.length === 0) return null;
  if (models.length === 1) {
    const [only] = models;
    return only === undefined ? null : <Badge model={only.model} />;
  }
  return (
    <span className="fx ac gap6" style={{ flexWrap: "wrap" }}>
      {models.map((m) => (
        <Badge key={m.model} model={m.model} />
      ))}
    </span>
  );
}
