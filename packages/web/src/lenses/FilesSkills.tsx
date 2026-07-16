import type { AnySessionJson } from "../api.js";
import { FileAccessTree } from "./filesSkills/FileAccessTree.js";
import { RepetitionFindingsPanel } from "./filesSkills/RepetitionFindingsPanel.js";
import { SkillInvocationsPanel } from "./filesSkills/SkillInvocationsPanel.js";
import { TaskExecutionsPanel } from "./filesSkills/TaskExecutionsPanel.js";
import { ToolStatsTable } from "./filesSkills/ToolStatsTable.js";

interface Props {
  session: AnySessionJson;
  /** Opens the record slide-over (L3) for a source line — see `FileAccessTree`. */
  onOpenRecord?: (line: number) => void;
}

/**
 * Files & skills lens (L2) — see design-spec/15-files-skills.md. Row 1: file
 * access tree + skill invocations / repetition findings. Row 2: tool stats
 * table + task executions. Reused as-is by the agent detail shell (L3),
 * exactly like `ContextCost`/`Orchestration` — every field comes from
 * whichever `ClaudeSessionAnalysis` JSON is passed in.
 *
 * `fileAccess`/`skillInvocations` are `SessionAnalysisCore` fields (both
 * harnesses populate them — see `codex/files-skills.ts` in `@junrei/core`),
 * so `FileAccessTree`/`SkillInvocationsPanel` render unbranched for either
 * source. Repetition findings and the per-tool/task-execution row are
 * Claude-only concepts with no honest Codex equivalent (no repetition
 * detector, no per-tool/task-tool breakdown for Codex — see `SourceCaps`'s
 * `hasRepetitions`/`hasToolStats`/`hasTaskExecutions` in `sourceCaps.ts`) and
 * are skipped for Codex, same pattern `ContextCost` uses for its own
 * Claude-only panels. Narrowed once here (rather than a `session.source ===
 * "claude-code"` check at each panel) since `RepetitionFindingsPanel`/
 * `ToolStatsTable`/`TaskExecutionsPanel` all take a Claude-only `SessionJson`
 * prop, not the `AnySessionJson` union.
 */
export function FilesSkills({ session, onOpenRecord }: Props) {
  const claude = session.source === "claude-code" ? session : undefined;
  return (
    <>
      <div className="hpad fx gap16 mt16">
        <FileAccessTree session={session} {...(onOpenRecord !== undefined && { onOpenRecord })} />
        <div className="col gap12" style={{ width: "430px", flex: "none" }}>
          <SkillInvocationsPanel session={session} />
          {claude !== undefined && <RepetitionFindingsPanel session={claude} />}
        </div>
      </div>
      {claude !== undefined && (
        <div className="hpad fx gap16 mt16">
          <ToolStatsTable session={claude} />
          <TaskExecutionsPanel session={claude} />
        </div>
      )}
    </>
  );
}
