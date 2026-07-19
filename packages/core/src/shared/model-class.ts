/**
 * Opus-class model detection — the ONE cost-relevant model split the insight
 * layer needs: is a model in the TOP price tier the cost-performance study's
 * R3/A4 lever is about ("Opus only for adversarial review; Sonnet/Haiku for
 * implement, verify, inventory")?
 *
 * Core has no general model-family classifier: the web's `modelClass.ts` is
 * the display-side one (codenames + colour accents) and can't be imported
 * here (wrong dependency direction — the web depends on core, not vice
 * versa). Rather than pull that whole table down, this is a single-purpose
 * matcher on the model id. It matches by id SEGMENT (not bare substring) so
 * "opus"/"fable" can never fire mid-word — the same boundary rule the web
 * classifier's `seg()` uses.
 *
 * `fable` is included alongside `opus` because it is the top-tier orchestrator
 * codename that shares Opus's price class (the web treats them as one accent,
 * "f", for the same reason). The lever this metric measures is "a top-tier
 * model ran on a subagent, where a cheaper tier would usually do" — and a
 * fable subagent is exactly that.
 */
const OPUS_CLASS_SEGMENT = /(^|[-._/ ])(opus|fable)($|[-._/ ])/;

/** True when the model id names a top-tier (Opus-class) Claude model — see the module doc comment for why `fable` counts. */
export function isOpusClassModel(model: string): boolean {
  return OPUS_CLASS_SEGMENT.test(model.toLowerCase());
}
