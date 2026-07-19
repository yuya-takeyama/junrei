import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { extractLeadingDocLine, listTrackedFiles, renderRepoMap } from "./repo-map.mjs";

test("extractLeadingDocLine returns the first content line of a leading block comment", () => {
  const src =
    "/**\n * Harness-neutral Bash engine.\n * More detail here.\n */\nexport const x = 1;\n";
  assert.equal(extractLeadingDocLine(src), "Harness-neutral Bash engine.");
});

test("extractLeadingDocLine skips a blank first comment line", () => {
  const src = "/**\n *\n * Real role line.\n */\n";
  assert.equal(extractLeadingDocLine(src), "Real role line.");
});

test("extractLeadingDocLine returns null without a leading block comment", () => {
  assert.equal(extractLeadingDocLine("import x from 'y';\n/** later */\n"), null);
  assert.equal(extractLeadingDocLine("// line comment\nconst a = 1;\n"), null);
});

// Structural assertions on this repo — deliberately about shape, not volatile
// counts, so the test stays stable as files come and go.
test("renderRepoMap emits the package/script/docs sections for this repo", () => {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  const files = listTrackedFiles(root);
  const md = renderRepoMap(root, files);
  assert.match(md, /^# Repo map/);
  assert.match(md, /## Packages/);
  assert.match(md, /@junrei\/core/);
  assert.match(md, /## Scripts/);
  // Assert on an already-tracked script — git ls-files omits not-yet-committed
  // files, so the new toolkit scripts only appear after they are staged.
  assert.match(md, /scripts\/junrei-launcher\.mjs/);
  assert.match(md, /## Docs/);
  assert.match(md, /docs\/cost-playbook\.md/);
});
