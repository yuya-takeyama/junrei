import assert from "node:assert/strict";
import test from "node:test";
import { buildGateSteps, parseGateArgs } from "./gate.mjs";

test("parseGateArgs defaults to a full, writing gate", () => {
  assert.deepEqual(parseGateArgs([]), { help: false, checkOnly: false });
});

test("parseGateArgs recognizes --check-only", () => {
  assert.equal(parseGateArgs(["--check-only"]).checkOnly, true);
});

test("parseGateArgs rejects an unknown flag", () => {
  assert.throws(() => parseGateArgs(["--nope"]), /unknown argument/);
});

test("buildGateSteps leads with the writing formatter by default", () => {
  const steps = buildGateSteps({ checkOnly: false });
  assert.deepEqual(steps[0].argv, ["pnpm", "exec", "biome", "format", "--write", "."]);
  assert.deepEqual(
    steps.map((s) => s.name),
    ["biome format --write", "biome check", "typecheck", "test"],
  );
});

test("buildGateSteps drops the writing formatter under --check-only", () => {
  const steps = buildGateSteps({ checkOnly: true });
  assert.deepEqual(
    steps.map((s) => s.name),
    ["biome check", "typecheck", "test"],
  );
});
