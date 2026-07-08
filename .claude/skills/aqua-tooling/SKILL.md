---
name: aqua-tooling
description: How to manage dev tools with aqua (aquaproj) in this repo — adding tools, updating versions, and keeping aqua-checksums.json in sync. Use whenever aqua.yaml or aqua-checksums.json is touched, when the user asks to add/update/pin a CLI tool (node, gh, pnpm, etc.), when tool versions drift between local and CI, or when aqua install fails with a checksum/policy error. Version bumps are NOT complete until checksums are regenerated.
---

# aqua Tooling Workflow

This repo pins all dev tools (node, gh, pnpm) with [aqua](https://aquaproj.github.io/)
so local dev and CI resolve identical versions. Facts below were verified against
the official docs (2026-07-09); source URLs at the bottom.

## Repo-specific invariants

- `aqua.yaml` at repo root is the source of truth. CI installs tools from it via
  `aquaproj/aqua-installer`, cached on `hashFiles('aqua.yaml')`.
- **Checksum verification is enforced** (`checksum.enabled: true` +
  `require_checksum: true`), so every version bump MUST regenerate
  `aqua-checksums.json` — otherwise `aqua i` fails for everyone, including CI.
- `nodejs/node` version must equal `.nvmrc` (user shell resolves node via nvm,
  non-interactive shells via aqua). Keep them in sync in the same commit.
- `pnpm/pnpm` version must equal `packageManager` in root `package.json`.
- The standard registry `ref` carries a `# renovate: depName=aquaproj/aqua-registry`
  marker — keep the comment when editing the line.

## Workflow: update tool versions

1. Find latest versions. Either run `aqua update` (`aqua up`) which rewrites
   `aqua.yaml` in place (updates BOTH registry refs and package versions; it
   edits config only, installs nothing), or look up tags manually
   (`gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`) and edit
   `aqua.yaml`. To update a single tool: `aqua update gh`.
2. Sync the mirrors: `.nvmrc` for node, `packageManager` for pnpm (see above).
3. Regenerate checksums:
   ```bash
   aqua -c aqua.yaml update-checksum -prune
   ```
   **Always pass `-c aqua.yaml`.** Without it, aqua walks parent directories and
   processes every config it finds on the way to `/` — inside a
   `.claude/worktrees/*` worktree this writes a stray `aqua-checksums.json` into
   the main repo checkout. (`-prune` drops entries for versions no longer in
   `aqua.yaml`.)
4. Verify and install: `aqua -c aqua.yaml i -l` must succeed (it verifies
   checksums), then spot-check `node --version` etc.
5. Run the quality gates (`pnpm install --frozen-lockfile && pnpm typecheck &&
   pnpm lint && pnpm test`) before committing. Commit `aqua.yaml`,
   `aqua-checksums.json`, and the synced files together.

Notes on `aqua update` behavior: packages with an explicit `version:` field or
`update: enabled: false` are skipped; `-r` updates only registries, `-p` only
packages; it only touches the first config found (another reason to stay at the
repo root or use `-c`).

## Workflow: add a new tool

1. `aqua g -i <owner>/<repo>` inserts the package (latest version, pinned) into
   `aqua.yaml`. Without args it opens an interactive fuzzy finder; add `-s` to
   pick the version. Only packages in the standard registry install without
   extra setup — aqua v2 allows ONLY the standard registry unless a policy file
   (`aqua-policy.yaml` + `aqua policy allow`) permits others.
2. Regenerate checksums and install (steps 3–5 above).

## Checksum semantics (why the file is required)

- `enabled: true` turns verification on; `require_checksum: true` makes a
  missing entry a hard failure instead of best-effort (both default to false).
- `aqua update-checksum` (`aqua upc`) creates/updates `aqua-checksums.json` for
  all packages, all platforms, plus the registry itself. Checksums come from the
  tool's published checksum files when available (gh's checksums.txt, node's
  SHASUMS), otherwise from hashing the downloaded asset.
- `aqua i` also appends missing checksums for the current platform as it
  installs, but only `upc` covers all platforms — CI runs linux, so a
  darwin-only update is not enough. Always run `upc`.
- If `aqua-checksums.json` ever gets noisy, `checksum.supported_envs`
  (e.g. `[darwin, linux]`) limits recorded platforms.

## CI / Renovate reference

- aqua-installer usage (pin both the action SHA and `aqua_version`; the action
  runs `aqua i -l` by default via `aqua_opts`):
  ```yaml
  - uses: actions/cache@<sha> # pin
    with:
      path: ~/.local/share/aquaproj-aqua
      key: aqua-${{ runner.os }}-${{ hashFiles('aqua.yaml') }}
  - uses: aquaproj/aqua-installer@<sha> # e.g. v4.0.5
    with:
      aqua_version: v2.60.0
  ```
- Renovate: `{ "extends": ["github>aquaproj/aqua-renovate-config#2.13.0"] }`
  updates package versions and the registry ref in `aqua.yaml`, but **cannot
  update `aqua-checksums.json`**. Checksums need a follow-up: run
  `aqua upc -prune` on the Renovate branch manually, or automate with
  `aquaproj/update-checksum-action` / autofix.ci (the docs now lean autofix.ci
  for fork-PR security).

## Command quick reference

| Command | Effect |
|---|---|
| `aqua i -l` | Create shim links only; binaries download lazily on first run |
| `aqua i` | Install everything in the config now |
| `aqua i -a` | Also install global-config (`AQUA_GLOBAL_CONFIG`) packages |
| `aqua g -i <pkg>` | Search registry and insert pinned package into aqua.yaml |
| `aqua up` / `aqua update <cmd>` | Bump versions in aqua.yaml (no install) |
| `aqua upc -prune` | Regenerate aqua-checksums.json, dropping stale entries |
| `aqua which <cmd>` | Absolute path of the resolved binary (`-v` for version) |
| `aqua list -i` | List installed packages |

Config discovery: `-c`/`AQUA_CONFIG` wins; otherwise aqua searches
`.?aqua.ya?ml` and `.?aqua/aqua.ya?ml` from cwd **upward to filesystem root and
reads every match it finds** — the root cause of the worktree gotcha above.

Never use floating versions: registry `ref` must be a tag or commit (never a
branch), and packages must be pinned — "latest" breaks reproducibility and CI
without any code change (official docs' core rationale).

## Sources

- Usage/commands: https://aquaproj.github.io/docs/reference/usage/
- Config & discovery: https://aquaproj.github.io/docs/reference/config/
- Checksum: https://aquaproj.github.io/docs/reference/config/checksum/ and
  https://aquaproj.github.io/docs/guides/checksum/
- update command: https://aquaproj.github.io/docs/guides/update-command/
- Renovate: https://aquaproj.github.io/docs/guides/renovate/
- aqua-installer: https://aquaproj.github.io/docs/products/aqua-installer/
  (inputs verified against action.yaml in aquaproj/aqua-installer)
- Policy: https://aquaproj.github.io/docs/guides/policy-as-code/
