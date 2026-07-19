import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";

// B2 — the deterministic ship procedure. Agents re-derived this same
// branch→commit→rebase→push→PR→CI-watch dance every session, costing 8–11
// pr-shepherd spawns (cost-playbook B2 / R10). Encoding it as one script means a
// worker runs a single command and reports the JSON result line instead of
// improvising git plumbing. Deliberately NOT a merger: it opens a draft PR and
// watches CI, leaving the merge decision to a human.

const MAIN_BRANCHES = new Set(["main", "master"]);

// gh pr create prints the PR URL on stdout; the number is its trailing path
// segment. Kept as a named regex so the parse intent is obvious at the call site.
const PR_URL_RE = /https?:\/\/\S*?\/pull\/(\d+)/;

export function parseShipArgs(argv) {
  const opts = { base: "main", runGates: false, dryRun: false };
  const need = new Map([
    ["--branch", "branch"],
    ["--commit-file", "commitFile"],
    ["--pr-title", "prTitle"],
    ["--pr-body-file", "prBodyFile"],
    ["--base", "base"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run-gates") opts.runGates = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") return { help: true, ...opts };
    else if (need.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`ship-pr: ${arg} requires a value`);
      opts[need.get(arg)] = value;
      i += 1;
    } else {
      throw new Error(`ship-pr: unknown argument "${arg}"`);
    }
  }
  const missing = ["branch", "commitFile", "prTitle", "prBodyFile"].filter((k) => !opts[k]);
  if (missing.length > 0 && !opts.help) {
    throw new Error(
      `ship-pr: missing required flag(s): ${missing.join(", ")} ` +
        "(--branch --commit-file --pr-title --pr-body-file)",
    );
  }
  return { help: false, ...opts };
}

// Pure command plan so a --dry-run and a test see the exact same steps the real
// run would execute. Gates are the playbook's typecheck && lint && test triad,
// run inline (not the fuller gate.mjs set) to match the shipper's contract.
export function buildCommandPlan({ branch, commitFile, prTitle, prBodyFile, base, runGates }) {
  const plan = [
    { desc: "create/switch branch", argv: ["git", "checkout", "-B", branch] },
    { desc: "stage all changes", argv: ["git", "add", "-A"] },
    { desc: "commit from message file", argv: ["git", "commit", "-F", commitFile] },
    { desc: "fetch base", argv: ["git", "fetch", "origin", base] },
    { desc: "rebase onto base", argv: ["git", "rebase", `origin/${base}`] },
  ];
  if (runGates) {
    plan.push({ desc: "gate: typecheck", argv: ["pnpm", "typecheck"] });
    plan.push({ desc: "gate: lint", argv: ["pnpm", "lint"] });
    plan.push({ desc: "gate: test", argv: ["pnpm", "test"] });
  }
  plan.push({ desc: "push branch", argv: ["git", "push", "-u", "origin", branch] });
  plan.push({
    desc: "open draft PR",
    argv: [
      "gh",
      "pr",
      "create",
      "--draft",
      "--base",
      base,
      "--head",
      branch,
      "--title",
      prTitle,
      "--body-file",
      prBodyFile,
    ],
  });
  plan.push({ desc: "watch CI (after 10s settle)", argv: ["gh", "pr", "checks", "--watch"] });
  return plan;
}

function run(argv, options = {}) {
  const [command, ...rest] = argv;
  return spawnSync(command, rest, { encoding: "utf8", ...options });
}

function fail(message) {
  console.error(`ship-pr: ${message}`);
  return 1;
}

function ship(rawArgv) {
  const opts = parseShipArgs(rawArgv);
  if (opts.help) {
    console.log(
      "Usage: node scripts/ship-pr.mjs --branch <name> --commit-file <path> " +
        "--pr-title <t> --pr-body-file <path> [--base main] [--run-gates] [--dry-run]",
    );
    return 0;
  }

  // Refuse to ship straight onto a trunk branch — the whole point is a reviewable
  // draft PR, never a direct push to main/master. This guard fires even in
  // --dry-run so a mistargeted branch is caught before any real invocation.
  if (MAIN_BRANCHES.has(opts.branch)) {
    return fail(`refusing to ship onto protected branch "${opts.branch}" — pass a feature branch`);
  }

  const plan = buildCommandPlan(opts);

  if (opts.dryRun) {
    console.log("ship-pr dry-run — no side effects. Planned commands:");
    for (const step of plan) {
      console.log(`  $ ${step.argv.join(" ")}   # ${step.desc}`);
    }
    console.log(
      `  (a 10s settle precedes the CI watch; final stdout line is JSON {pr,url,headSha,ci})`,
    );
    return 0;
  }

  // Guard 1: we must be at the root of the git repo this cwd belongs to. Running
  // the plan from a stray directory would stage/commit the wrong tree.
  const topResult = run(["git", "rev-parse", "--show-toplevel"]);
  if (topResult.status !== 0) return fail("not inside a git repository");
  const toplevel = realpathSync(topResult.stdout.trim());
  if (toplevel !== realpathSync(process.cwd())) {
    return fail(`run from the repo root (${toplevel}), not ${process.cwd()}`);
  }

  // Guard 2: there must be something to ship. An empty working tree means the
  // caller forgot to make the change, and `git commit` would fail confusingly.
  const statusResult = run(["git", "status", "--porcelain"]);
  if (statusResult.status !== 0) return fail("git status failed");
  if (statusResult.stdout.trim() === "") {
    return fail("working tree has no changes to ship");
  }

  let prUrl = null;
  let prNumber = null;
  for (const step of plan) {
    if (step.desc.startsWith("watch CI")) {
      // Settle before watching: CI checks are not registered the instant the PR
      // is created, so an immediate watch reports "no checks" and exits early.
      spawnSync("sleep", ["10"], { stdio: "inherit" });
      const ci = run(step.argv, { stdio: "inherit" });
      // gh pr checks --watch exits non-zero when any check fails; that is CI
      // status, not a shipper error, so it does not abort the JSON summary.
      emitSummary(prNumber, prUrl, ci.status === 0 ? "pass" : "fail");
      return 0;
    }

    if (step.desc === "open draft PR") {
      const created = run(step.argv, { encoding: "utf8" });
      process.stdout.write(created.stdout ?? "");
      process.stderr.write(created.stderr ?? "");
      if (created.status !== 0) return fail("gh pr create failed");
      const match = (created.stdout ?? "").match(PR_URL_RE);
      if (match) {
        prUrl = match[0];
        prNumber = Number(match[1]);
      }
      continue;
    }

    const result = run(step.argv, { stdio: "inherit" });
    if (result.status !== 0) {
      // Never auto-resolve a rebase conflict: abort to restore a clean tree and
      // hand the conflict back to a human, exiting non-zero.
      if (step.desc === "rebase onto base") {
        run(["git", "rebase", "--abort"], { stdio: "inherit" });
        return fail(
          `rebase onto origin/${opts.base} hit conflicts — aborted and left the ` +
            "tree clean. Resolve manually, then re-run ship-pr.",
        );
      }
      return fail(`step failed: ${step.desc} (exit ${result.status})`);
    }
  }
  return 0;
}

function emitSummary(prNumber, prUrl, ci) {
  const headSha = run(["git", "rev-parse", "HEAD"]).stdout?.trim() ?? null;
  // Single machine-readable line as the last thing on stdout, per the B2 contract.
  console.log(JSON.stringify({ pr: prNumber, url: prUrl, headSha, ci }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(ship(process.argv.slice(2)));
  } catch (error) {
    process.exit(fail(error.message));
  }
}
