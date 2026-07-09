/**
 * Compact "estimated" marker rendered next to any Codex cost figure.
 *
 * Codex CLI has no equivalent of Claude Code's session cost_usd field — its
 * dollar figures are computed from OpenAI's public API list prices
 * (`@junrei/core`'s pricing table), which can diverge meaningfully from what
 * a ChatGPT-plan user actually pays (subscription, not metered). Every place
 * a Codex cost renders (list rows, detail totals, per-model breakdowns) shows
 * this badge so the number is never mistaken for a billed amount the way
 * Claude Code's cost figures are.
 */
export function EstBadge() {
  return (
    <span className="mut" style={{ fontSize: "9px" }} title="estimated at OpenAI API list prices">
      {" "}
      est.
    </span>
  );
}
