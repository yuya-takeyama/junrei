/**
 * Structural invariant for the shared/claude/codex peer layout (see
 * docs/design.md's Architecture section): `shared/` must never import from
 * `claude/` or `codex/`, and `claude/`/`codex/` must never import from each
 * other. A plain import-statement scan (no TS compiler API, no extra
 * dependency) is enough to enforce this — every violation is a relative
 * `from "..."` specifier that resolves into the forbidden sibling tree.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

type Tree = "shared" | "claude" | "codex" | undefined;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every relative (`./` or `../`) import/export specifier a file's `from "..."` clauses name. */
const IMPORT_SPECIFIER = /from\s+["']([^"']+)["']/g;

function relativeImportSpecifiers(filePath: string): string[] {
  const text = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
}

/** Which peer tree a `src`-relative path belongs to — `undefined` for top-level files (e.g. `index.ts`). */
function treeOf(srcRelativePath: string): Tree {
  if (srcRelativePath.startsWith("shared/")) return "shared";
  if (srcRelativePath.startsWith("claude/")) return "claude";
  if (srcRelativePath.startsWith("codex/")) return "codex";
  return undefined;
}

/** Every cross-tree violation among files whose own tree is `fromTree`, importing into `forbiddenTree`. */
function findViolations(files: readonly string[], fromTree: Tree, forbiddenTree: Tree): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const relFile = relative(SRC_DIR, file);
    if (treeOf(relFile) !== fromTree) continue;
    for (const specifier of relativeImportSpecifiers(file)) {
      const resolvedRelPath = relative(SRC_DIR, resolve(dirname(file), specifier));
      if (treeOf(resolvedRelPath) === forbiddenTree) {
        violations.push(`${relFile} imports "${specifier}" (resolves into ${forbiddenTree}/)`);
      }
    }
  }
  return violations;
}

describe("shared/claude/codex peer-tree import boundaries", () => {
  const files = listTsFiles(SRC_DIR);

  it("src/shared/ never imports from claude/", () => {
    expect(findViolations(files, "shared", "claude")).toEqual([]);
  });

  it("src/shared/ never imports from codex/", () => {
    expect(findViolations(files, "shared", "codex")).toEqual([]);
  });

  it("src/claude/ never imports from codex/", () => {
    expect(findViolations(files, "claude", "codex")).toEqual([]);
  });

  it("src/codex/ never imports from claude/", () => {
    expect(findViolations(files, "codex", "claude")).toEqual([]);
  });
});
