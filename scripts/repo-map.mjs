import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// B5 — the deterministic repo map. One studied session made 1,278 bash calls
// re-exploring the tree (cost-playbook B5 / R6); every fresh subagent paid to
// rediscover the same package layout. This produces a stable markdown snapshot —
// no LLM involved — meant to be pasted into a spawn prompt so a worker starts
// oriented instead of grepping. Nothing here estimates or judges; it only
// reflects what `git ls-files` already tracks, so output is reproducible.

// Read the leading `/** ... */` block comment's first content line, used as a
// one-line role for a source file. Returns null when the file has no leading
// block comment so the caller can omit the role rather than invent one.
export function extractLeadingDocLine(content) {
  const trimmed = content.replace(/^﻿/, "").trimStart();
  if (!trimmed.startsWith("/**")) return null;
  const end = trimmed.indexOf("*/");
  if (end === -1) return null;
  const body = trimmed.slice(3, end);
  for (const raw of body.split("\n")) {
    // Strip the decorative leading `*` and surrounding whitespace per JSDoc line.
    const line = raw.replace(/^\s*\*?\s?/, "").trim();
    if (line.length > 0) return line;
  }
  return null;
}

// git ls-files is the .gitignore-respecting source of truth: it lists exactly the
// tracked files, so the map never wanders into node_modules or build output.
export function listTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${result.stderr ?? ""}`);
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Immediate children of `packages/<pkg>/src/` — files keep their extension, and
// a nested directory is reported once (as `name/`) without descending, since the
// map is a top-level orientation aid, not a full file tree.
function topLevelSrcEntries(files, pkgDir) {
  const prefix = `${pkgDir}/src/`;
  const entries = new Map(); // name -> { isDir, path }
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) entries.set(rest, { isDir: false, path: file });
    else {
      const dir = rest.slice(0, slash);
      if (!entries.has(dir)) entries.set(dir, { isDir: true, path: null });
    }
  }
  return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function renderRepoMap(root, files) {
  const lines = [
    "# Repo map",
    "",
    "_Deterministic snapshot from `git ls-files` — paste into spawn prompts._",
    "",
  ];

  // --- Packages -----------------------------------------------------------
  const pkgManifests = files.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f)).sort();
  lines.push("## Packages", "");
  for (const manifest of pkgManifests) {
    const pkgDir = manifest.slice(0, manifest.length - "/package.json".length);
    const json = readJson(join(root, manifest)) ?? {};
    const name = json.name ?? pkgDir;
    const desc = json.description ? ` — ${json.description}` : "";
    lines.push(`### ${name}${desc}`, `\`${pkgDir}\``, "");
    const entries = topLevelSrcEntries(files, pkgDir);
    if (entries.length > 0) {
      for (const [entryName, info] of entries) {
        if (info.isDir) {
          lines.push(`- \`${entryName}/\``);
        } else {
          const role = extractLeadingDocLine(safeRead(join(root, info.path)));
          lines.push(role ? `- \`${entryName}\` — ${firstSentence(role)}` : `- \`${entryName}\``);
        }
      }
      lines.push("");
    }
  }

  // --- Scripts ------------------------------------------------------------
  const scripts = files.filter((f) => /^scripts\/[^/]+$/.test(f)).sort();
  lines.push("## Scripts", "");
  for (const script of scripts) {
    lines.push(`- \`${script}\``);
  }
  lines.push("");

  // --- Docs ---------------------------------------------------------------
  const docs = files.filter((f) => /^docs\/[^/]+\.md$/.test(f)).sort();
  lines.push("## Docs", "");
  for (const doc of docs) {
    lines.push(`- \`${doc}\``);
  }
  lines.push("");

  return lines.join("\n");
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Keep a role to a single readable clause: the JSDoc first line can be long, so
// cut at the first sentence boundary and hard-cap the length for tidy output.
function firstSentence(text) {
  const dot = text.indexOf(". ");
  const clause = dot === -1 ? text : text.slice(0, dot);
  return clause.length > 100 ? `${clause.slice(0, 97)}...` : clause;
}

function main(argv) {
  let outPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      outPath = argv[i + 1];
      i += 1;
      if (!outPath) throw new Error("repo-map: --out requires a path");
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/repo-map.mjs [--out <path>]");
      return 0;
    } else {
      throw new Error(`repo-map: unknown argument "${argv[i]}"`);
    }
  }
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  const files = listTrackedFiles(root);
  const markdown = renderRepoMap(root, files);
  if (outPath) {
    writeFileSync(outPath, markdown);
    console.error(`repo-map written to ${outPath}`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
