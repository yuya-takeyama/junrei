import { spawnSync } from "node:child_process";
import process from "node:process";

// B3 — the single quality gate. Agents kept re-deriving the format/lint/type/test
// sequence and burned ~7 whack-a-mole cycles per feature fixing one lint error at
// a time (cost-playbook B3 / R6). This runs the whole gate once, fail-fast, so a
// worker reports "gate green" instead of a stream of partial fixes.
//
// Order matters: `biome format --write` first so any purely-cosmetic diff is
// applied before `biome check` would otherwise fail on it, then typecheck, then
// the workspace test suite. `--check-only` drops the writing step for CI-style
// verification where the tree must stay untouched.

export function parseGateArgs(argv) {
  let checkOnly = false;
  for (const arg of argv) {
    if (arg === "--check-only") checkOnly = true;
    else if (arg === "--help" || arg === "-h") return { help: true, checkOnly };
    else throw new Error(`gate: unknown argument "${arg}" (supported: --check-only)`);
  }
  return { help: false, checkOnly };
}

// Pure so a test can assert the plan without spawning anything. Each step is a
// [command, ...args] argv run through the package manager so the local biome /
// turbo binaries resolve the same way `pnpm lint` does.
export function buildGateSteps({ checkOnly }) {
  const steps = [];
  if (!checkOnly) {
    // Writing formatter first; skipped under --check-only so the gate is read-only.
    steps.push({
      name: "biome format --write",
      argv: ["pnpm", "exec", "biome", "format", "--write", "."],
    });
  }
  steps.push({ name: "biome check", argv: ["pnpm", "exec", "biome", "check", "."] });
  steps.push({ name: "typecheck", argv: ["pnpm", "typecheck"] });
  steps.push({ name: "test", argv: ["pnpm", "test"] });
  return steps;
}

const HELP = `Usage: node scripts/gate.mjs [--check-only]

Runs the single quality gate, fail-fast:
  biome format --write  (skipped with --check-only)
  biome check
  pnpm typecheck
  pnpm test

Exit code reflects the first failing step.`;

function runGate(argv) {
  const { help, checkOnly } = parseGateArgs(argv);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const steps = buildGateSteps({ checkOnly });
  for (const step of steps) {
    const [command, ...rest] = step.argv;
    const result = spawnSync(command, rest, { stdio: "inherit" });
    if (result.error) {
      console.error(`FAIL ${step.name} — ${result.error.message}`);
      return 1;
    }
    // One summary line per step so the tail of the log reads as a checklist.
    if (result.status !== 0) {
      console.error(`FAIL ${step.name} (exit ${result.status})`);
      return result.status ?? 1;
    }
    console.log(`PASS ${step.name}`);
  }
  console.log("PASS gate (all steps green)");
  return 0;
}

// Only run when invoked directly; importing for tests must have no side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(runGate(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
