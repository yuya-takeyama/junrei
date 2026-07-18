/**
 * Attachment-rebuilt injections. The agent-listing and skill-listing
 * `<system-reminder>` blocks the harness injects into the first user turn are
 * NOT stored verbatim in the log — but they rebuild BYTE-EXACTLY from the
 * structured `attachment` record (its `addedLines` / `content`) wrapped in a
 * fixed, version-stable harness template. Measured: these injections
 * reconstructed byte-for-byte (docs/milestones/goshuin.md). Only the generic
 * wrapper literals live here; the payload text comes entirely from the log's
 * attachment record, so the result is `exact`-confidence.
 */

/**
 * The agent-listing reminder. `addedLines` are the attachment record's own
 * lines (one per available agent type); the surrounding text is the fixed
 * wrapper.
 */
export function renderAgentListingBlock(addedLines: string[]): string {
  return `<system-reminder>
Available agent types for the Agent tool:
${addedLines.join("\n")}

When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.
</system-reminder>`;
}

/**
 * The skill-listing reminder. `content` is the attachment record's verbatim
 * skill list; the surrounding text is the fixed wrapper (note the trailing
 * newline after the closing tag — part of the measured byte-exact block).
 */
export function renderSkillListingBlock(content: string): string {
  return `<system-reminder>
The following skills are available for use with the Skill tool:

${content}
</system-reminder>
`;
}
