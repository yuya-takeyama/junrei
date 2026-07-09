import type { SessionJson } from "../api.js";
import { FileAccessTree } from "./filesSkills/FileAccessTree.js";
import { RepetitionFindingsPanel } from "./filesSkills/RepetitionFindingsPanel.js";
import { SkillInvocationsPanel } from "./filesSkills/SkillInvocationsPanel.js";
import { TaskExecutionsPanel } from "./filesSkills/TaskExecutionsPanel.js";
import { ToolStatsTable } from "./filesSkills/ToolStatsTable.js";

interface Props {
  session: SessionJson;
}

/**
 * Files & skills lens (L2) — see design-spec/15-files-skills.md. Row 1: file
 * access tree + skill invocations / repetition findings. Row 2: tool stats
 * table + task executions. Reused as-is by the agent detail shell (L3),
 * exactly like `ContextCost`/`Orchestration` — every field comes from
 * whichever `SessionAnalysis` JSON is passed in.
 */
export function FilesSkills({ session }: Props) {
  return (
    <>
      <div className="hpad fx gap16 mt16">
        <FileAccessTree session={session} />
        <div className="col gap12" style={{ width: "430px", flex: "none" }}>
          <SkillInvocationsPanel session={session} />
          <RepetitionFindingsPanel session={session} />
        </div>
      </div>
      <div className="hpad fx gap16 mt16">
        <ToolStatsTable session={session} />
        <TaskExecutionsPanel session={session} />
      </div>
    </>
  );
}
