import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCommandPlan, parseShipArgs } from "./ship-pr.mjs";

const SCRIPT = fileURLToPath(new URL("./ship-pr.mjs", import.meta.url));

function planText(argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8" });
}

test("parseShipArgs requires the four core flags", () => {
  assert.throws(() => parseShipArgs(["--branch", "f"]), /missing required flag/);
});

test("parseShipArgs defaults base to main and collects flags", () => {
  const opts = parseShipArgs([
    "--branch",
    "feature/x",
    "--commit-file",
    "/tmp/msg",
    "--pr-title",
    "Add X",
    "--pr-body-file",
    "/tmp/body",
  ]);
  assert.equal(opts.base, "main");
  assert.equal(opts.branch, "feature/x");
  assert.equal(opts.runGates, false);
});

test("buildCommandPlan orders branch->commit->rebase->push->PR->watch", () => {
  const plan = buildCommandPlan({
    branch: "feature/x",
    commitFile: "/m",
    prTitle: "T",
    prBodyFile: "/b",
    base: "main",
    runGates: false,
  });
  const descs = plan.map((s) => s.desc);
  assert.deepEqual(descs, [
    "create/switch branch",
    "stage all changes",
    "commit from message file",
    "fetch base",
    "rebase onto base",
    "push branch",
    "open draft PR",
    "watch CI (after 10s settle)",
  ]);
});

test("buildCommandPlan inserts the gate triad when runGates is set", () => {
  const plan = buildCommandPlan({
    branch: "feature/x",
    commitFile: "/m",
    prTitle: "T",
    prBodyFile: "/b",
    base: "main",
    runGates: true,
  });
  assert.deepEqual(
    plan.filter((s) => s.desc.startsWith("gate:")).map((s) => s.desc),
    ["gate: typecheck", "gate: lint", "gate: test"],
  );
});

test("--dry-run prints the command plan with zero side effects", () => {
  const res = planText([
    "--dry-run",
    "--branch",
    "feature/x",
    "--commit-file",
    "/nonexistent/msg",
    "--pr-title",
    "Add X",
    "--pr-body-file",
    "/nonexistent/body",
  ]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /git checkout -B feature\/x/);
  assert.match(res.stdout, /gh pr create --draft/);
  assert.match(res.stdout, /no side effects/);
});

test("refuses to ship onto a protected branch, even in dry-run", () => {
  const res = planText([
    "--dry-run",
    "--branch",
    "main",
    "--commit-file",
    "/m",
    "--pr-title",
    "T",
    "--pr-body-file",
    "/b",
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /protected branch/);
});
