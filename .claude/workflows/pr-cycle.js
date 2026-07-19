// pr-cycle — the proven single-PR delegation cycle, encoded as code so the
// control flow lives here, not in a prompt. Cost-playbook R5: when code owns
// sequencing, pass rate roughly doubles and constraint violations collapse;
// writing the same steps into a prompt does NOT recover the gap. The stages are
// Implement (sonnet) -> Review (opus, adversarial) -> Fix-if-needed (sonnet) ->
// Ship-without-merge (pr-shepherd). Generic and spec-driven: point it at a
// specPath and it runs the cycle for any single PR.

export const meta = {
  name: "pr-cycle",
  description:
    "Implement -> Review -> Fix-if-needed -> Ship (draft PR, no merge) for one spec-driven PR.",
  args: {
    specPath: "Path to the implementation spec the worker must satisfy",
    branch: "Feature branch to create and push (never main/master)",
    commitMessage: "Commit subject/body for the ship stage",
    prTitle: "Draft PR title",
    worktree: "Absolute path to the git worktree root all work stays inside",
  },
};

// Args may arrive as an object, a JSON string, or undefined depending on how the
// workflow is invoked. Parse defensively and fail loudly listing what is missing,
// rather than letting an undefined branch reach a git command downstream.
function readArgs(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`pr-cycle: args was a string but not valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "pr-cycle: args missing — expected {specPath, branch, commitMessage, prTitle, worktree}",
    );
  }
  const required = ["specPath", "branch", "commitMessage", "prTitle", "worktree"];
  const missing = required.filter((k) => !parsed[k]);
  if (missing.length > 0) {
    throw new Error(`pr-cycle: missing required field(s): ${missing.join(", ")}`);
  }
  return parsed;
}

// Clauses every spawn prompt shares, so each worker inherits the same guardrails.
const BUDGET =
  "Turn budget: aim for ~60 tool calls; treat >150 as a design failure and stop to summarize.";
const READ_RULES =
  "Read files ONLY with Read/Grep/Glob — never cat/sed/awk via Bash (Bash is for pnpm/git/node). " +
  "Return conclusions (verdicts, file:line), not raw logs or dumps.";
// Toplevel check: every worker confirms it is in the intended worktree before
// writing, so a stray cwd can never mutate the main checkout.
const toplevelClause = (worktree) =>
  `Before your first write, verify \`git rev-parse --show-toplevel\` equals ${worktree}; never write outside it.`;

export default async function run(rawArgs) {
  const { specPath, branch, commitMessage, prTitle, worktree } = readArgs(rawArgs);
  const shared = `${toplevelClause(worktree)}\n${BUDGET}\n${READ_RULES}`;

  // Stage 1 — Implement on sonnet/high: a clear spec downgrades well off the
  // orchestrator tier (decision table: "feature implementation with a clear spec").
  await agent(
    `Implement the spec at ${specPath} in the worktree ${worktree}.\n${shared}\n` +
      "Run the quality gate once when done (node scripts/gate.mjs). Report: files changed + gate result.",
    { model: "sonnet", effort: "high" },
  );

  // Stage 2 — Review on opus/high: adversarial review from fresh context is the
  // one place the playbook still routes to opus (R3).
  const review = await agent(
    `Adversarially review the changes in ${worktree} against the spec at ${specPath}.\n${shared}\n` +
      "Output a verdict line PASS or CHANGES-NEEDED, then any defects as file:line — one per line.",
    { model: "opus", effort: "high" },
  );

  // Stage 3 — Fix only if review demanded it. Code owns the branch, not a prompt:
  // no defects => no fix spawn, so we never pay for an idle worker.
  const reviewText = typeof review === "string" ? review : JSON.stringify(review ?? "");
  if (/CHANGES-NEEDED/i.test(reviewText)) {
    await agent(
      `Address the review findings below in ${worktree}, then re-run node scripts/gate.mjs.\n${shared}\n` +
        `Findings:\n${reviewText}\nReport: what you changed + gate result.`,
      { model: "sonnet", effort: "high" },
    );
  }

  // Stage 4 — Ship without merging via the pr-shepherd role (its frontmatter pins
  // sonnet). It runs scripts/ship-pr.mjs: branch -> commit -> rebase -> push ->
  // draft PR -> CI watch, then stops. The merge decision stays with a human.
  return agent(
    `Ship the changes in ${worktree} as a DRAFT PR — do not merge.\n` +
      `${toplevelClause(worktree)}\n` +
      "Write the commit message to a temp file and the PR body to a temp file, then run:\n" +
      `node scripts/ship-pr.mjs --branch ${branch} --commit-file <msgfile> ` +
      `--pr-title ${JSON.stringify(prTitle)} --pr-body-file <bodyfile>\n` +
      `Commit message: ${JSON.stringify(commitMessage)}\n` +
      "Report the JSON result line from ship-pr (pr, url, headSha, ci).",
    { agentType: "pr-shepherd" },
  );
}
