---
name: pr-ci-health
description: Prevent and diagnose "PR created but GitHub Actions never start" situations. Use on EVERY commit/push/PR-creation flow in this repo (including commit-commands:commit-push-pr) — rebase onto origin/main before pushing — and whenever `gh pr checks` shows "no checks reported", checks stay absent after a push, or CI seems stuck without any runs.
---

# PR CI Health: prevent & diagnose missing GitHub Actions runs

A PR that conflicts with `main` cannot get a test merge commit
(`refs/pull/N/merge`), so `pull_request`-triggered workflows **never start** —
the PR sits at "no checks reported" indefinitely (this happened on PR #13).
This skill bakes prevention into every push and gives the diagnosis flow for
when checks still fail to appear.

## Prevention — before every push / PR creation

1. `git fetch origin main`
2. Check divergence: `git rev-list --left-right --count origin/main...HEAD`
   (left = commits you are behind)
3. If behind: `git rebase origin/main` — **git merge is forbidden**
4. If conflicts: resolve one by one, `git rebase --continue`, then run quality
   gates (`pnpm typecheck && pnpm lint && pnpm test`) before pushing
5. Push (`--force-with-lease` if the branch was already pushed), then monitor:
   `sleep 10 && gh pr checks --watch` in foreground, timeout 600000ms

## Diagnosis — "no checks reported" after PR creation or push

Work through these in order; at the end, report what was checked and what the
cause was.

1. **Are runs really absent?** `gh run list --branch <branch> --limit 5`
   - Runs exist as queued/pending → CI is just slow; keep watching.
2. **Merge conflict?** (most common) `gh pr view <N> --json mergeable,mergeStateStatus`
   - `CONFLICTING` → rebase onto `origin/main`, resolve, run quality gates,
     `git push --force-with-lease`, then wait for checks to register:
     `until gh run list --branch <branch> --limit 1 | grep -q .; do sleep 5; done`
     and re-run `gh pr checks --watch`.
   - `UNKNOWN` → GitHub is computing mergeability asynchronously; re-query
     2-3 times a few seconds apart before concluding.
3. **GitHub Actions incident?**
   `curl -s https://www.githubstatus.com/api/v2/components.json` — check the
   "Actions" component. If degraded, do NOT retrigger; report the incident and
   suggest waiting for recovery.
4. **Retrigger (last resort)**: empty commit to fire a `synchronize` event —
   `git commit --allow-empty -m 'chore: retrigger CI'` + push. Still nothing?
   `gh pr close <N> && gh pr reopen <N>`.
