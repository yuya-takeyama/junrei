import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// B6 — environment preflight. One studied session spent 4.4 minutes hunting for
// `gh` on PATH before it could do any real work (cost-playbook B6 / R10). This
// checks the toolchain up front and prints a single readable report, so a fresh
// worktree is either confirmed ready or told the exact remediation — no guessing,
// no per-agent PATH archaeology.

// The tools every session assumes. aqua provisions them (see aqua.yaml); if any
// are missing and aqua is present, `aqua i -l` installs the pinned versions.
const REQUIRED_TOOLS = ["gh", "node", "pnpm"];

function resolveTool(tool) {
  // `command -v` via the login shell mirrors how the tools actually resolve for
  // the user, including aqua shims, rather than reimplementing PATH lookup.
  const which = spawnSync("command", ["-v", tool], { shell: true, encoding: "utf8" });
  const path = which.status === 0 ? which.stdout.trim() : null;
  let version = null;
  if (path) {
    const ver = spawnSync(tool, ["--version"], { encoding: "utf8" });
    if (ver.status === 0) version = ver.stdout.trim().split("\n")[0];
  }
  return { tool, path, version };
}

function repoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

function main(argv) {
  const install = argv.includes("--install");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: node scripts/bootstrap.mjs [--install]\n\n" +
        "Preflight the toolchain. --install runs `pnpm install` when node_modules is absent.",
    );
    return 0;
  }

  const root = repoRoot();
  let ok = true;

  // Step 1: aqua provisions the toolchain. If tools are missing but aqua is on
  // PATH, install the locked set before reporting — that is aqua's whole job here.
  const aqua = resolveTool("aqua");
  console.log(`aqua: ${aqua.path ? `${aqua.path} (${aqua.version ?? "?"})` : "NOT FOUND"}`);
  const missingBefore = REQUIRED_TOOLS.map(resolveTool).filter((t) => !t.path);
  if (missingBefore.length > 0 && aqua.path) {
    console.log(
      `  installing missing tools via aqua i -l (${missingBefore.map((t) => t.tool).join(", ")})...`,
    );
    const res = spawnSync("aqua", ["i", "-l"], { cwd: root, stdio: "inherit" });
    if (res.status !== 0) console.log("  aqua i -l returned non-zero — continuing to report state");
  }

  // Step 2: report each required tool's resolved path + version.
  for (const tool of REQUIRED_TOOLS) {
    const info = resolveTool(tool);
    if (info.path) {
      console.log(`${tool}: ${info.path} (${info.version ?? "version unknown"})`);
    } else {
      console.log(`${tool}: NOT FOUND — install via aqua (aqua i -l) or your package manager`);
      ok = false;
    }
  }

  // Step 3: dependency install state. Missing node_modules is the classic
  // "why won't anything run" trap; we print the exact fix and only auto-install
  // when explicitly asked, so a preflight never mutates the tree by surprise.
  const nodeModules = join(root, "node_modules");
  if (existsSync(nodeModules)) {
    console.log(`deps: node_modules present at ${nodeModules}`);
  } else if (install) {
    console.log("deps: node_modules missing — running pnpm install...");
    const res = spawnSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
    if (res.status !== 0) {
      console.log("deps: pnpm install failed");
      ok = false;
    }
  } else {
    console.log(
      `deps: node_modules MISSING — run: pnpm install   (or: node scripts/bootstrap.mjs --install)`,
    );
    ok = false;
  }

  console.log(ok ? "bootstrap: environment ready" : "bootstrap: action required (see above)");
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
