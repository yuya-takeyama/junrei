import { formatTokens } from "../../format.js";

/**
 * Headline size for a `Skill` invocation's injected SKILL.md payload — e.g.
 * "5.6k chars loaded" (see core issue #27). `injectedChars` is undefined
 * whenever no matching `isMeta` injection record was found (older transcript
 * formats, or a skill whose frontmatter renders a templated prompt instead of
 * injecting the file verbatim), in which case this returns undefined too —
 * the panel renders nothing rather than falling back to `resultChars` (the
 * ~44-char launch ACK), which would misrepresent the ACK as the payload.
 */
export function formatInjectedSize(injectedChars: number | undefined): string | undefined {
  if (injectedChars === undefined) return undefined;
  return `${formatTokens(injectedChars)} chars loaded`;
}
