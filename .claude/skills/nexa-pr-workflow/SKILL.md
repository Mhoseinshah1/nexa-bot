---
name: nexa-pr-workflow
description: The NEXA branch → PR → CI → review → merge cycle — syncing with main, detecting migration-number collisions and conflicts before they reach a PR, stacking dependent PRs, reading CI, and preparing (never performing, without the owner's explicit approval) a merge commit. Use when starting work on a branch, opening or updating a PR, handling CI or review feedback, or preparing a merge or a release candidate.
---

# Branch, PR and merge in NEXA

`CLAUDE.md` § Git is the authority; its full text is §0. Merging, tagging,
releasing and deploying are the owner's call — "the work looks finished" is
never approval. This skill is the procedure around those rules.

## 0. The rule in full (moved from CLAUDE.md § Git)

Work on the session's task branch. **Never push implementation directly to
`main`**, and never force-push anything.

`main` moves only through a pull request that the owner has explicitly approved
after review, with CI green on the exact reviewed head. Phase 1 was merged that
way — reviewed to a clean round, then merged as a merge commit on the owner's
instruction, so the reviewed history stays reachable.

So: normal feature work happens on a branch and reaches `main` through a PR.
Merging one is the owner's call, never a step you take because the work looks
finished. Absent that explicit approval, leave the PR open and say it is
ready. A round prompt that says to push, open a PR and merge on green IS that
approval, for that round's PRs only (`nexa-round-pipeline`).

## 1. Start from the real main

```bash
git fetch origin main
git log --oneline -1 origin/main
git status -sb
```

- On the session's branch: if its PR is already merged, restart the branch from
  `origin/main` (same name) instead of stacking on merged history.
- Otherwise bring main in with a **merge** (`git merge origin/main`), never a
  rebase of a pushed branch.

## 2. Check before you push or open a PR

```bash
bash .claude/skills/nexa-pr-workflow/scripts/branch-check.sh   # read-only
```

Reports ahead/behind, a dirty tree, a trial-merge conflict list, a
`packages/contracts` change (must be its own commit, with the reason), and any
migration this branch adds whose number collides with, or sits at or below,
`origin/main`'s highest. Self-test: `scripts/branch-check.test.sh`.

A migration collision is the most common merge break here (the Mirza importer
and three `fix10/*` PRs all claimed 0240). Fix it on the branch that merges
second: after `git merge origin/main`, run
`bash scripts/claude/renumber-migration.sh` (`--dry-run` first to see the plan),
which renumbers, regenerates the journal and snapshot with the tooling and
proves the SQL byte-identical (`nexa-migrations` § Renumbering) — never
hand-edit `_journal.json`. Then `pnpm db:check` and the migration suites.

## 3. Open the PR

- Title: conventional prefix as in history (`fix(payments): …`, `feat(web): …`,
  `test(…)`, `docs(…)`, `chore(…)`).
- Body: what changed and why, how it was tested (only tests that exist and were
  run — cite commands, never discarded probes), what is **not** in the PR,
  open owner decisions, overlaps/stacking ("stacked on #N", "carries #N").
- No model names in commits, PR titles or bodies.
- Do not create a PR unless asked; when you do, say it is ready and stop. A
  round prompt that says to push and open a PR is that ask
  (`nexa-round-pipeline`).
- A citation or falsification pin count (`pnpm check:citations`) rises only by
  exactly the number of citations this PR adds. Never raise it to hide a
  missing reference.

## 4. CI and reviews

- CI runs on the PR's merge ref (`docs/ci.md`); pushes to non-main branches do
  not run CI. Read the failing job's log before touching code.
- Read CI with `nexa-ci-watch` (`bash scripts/claude/ci-status.sh <pr>`,
  `--fail-logs`, `--gate`, `--codex`). GraphQL is blocked here, so `gh pr view`,
  `gh pr checks` and `gh run …` fail with 403: use `gh api repos/{owner}/{repo}/…`
  REST (`pulls/{n}`, `commits/{sha}/check-runs`, `actions/jobs/{id}/logs`,
  `actions/runs/{id}/rerun-failed-jobs`, `pulls/{n}/ccr/review_threads`).
- Codex reviews automatically when the PR opens; read that one review, never
  request another.
- Diagnose every red: this PR's bug, or red on `main` too (then port the fix
  that exists, and say so once on the PR). "Flake" is not a root cause; at most
  one re-run, only to confirm.
- Never skip, quarantine or weaken a test to get green (`nexa-test-selection`).
- Review comments: implement small local asks; reply with a proposal for large
  ones; a fix is reviewed as hard as the bug (CLAUDE.md § Reviewing with agents).
- Before any commit that follows agent work: `git status`, read every line of
  `git diff`, confirm no reviewer mutation is left behind.

## 5. Stacked and dependent PRs

- Merge order follows the stack; the later PR merges `main` in after each
  earlier one lands ("Merge main into <branch> (after #N)").
- Two PRs touching the same migration range, `main.recovery.ts`, `app.tsx` or
  a contracts file need an agreed order — record it in both PR bodies.

## 6. Preparing a merge (only on explicit approval)

When the owner explicitly says to merge a specific PR — or a round prompt
pre-approves "merge on green" for its PRs, which is the same explicit approval
(`nexa-round-pipeline` §3), valid only once CI is fully green on the exact head
and the Codex findings are fixed:

1. Re-fetch; confirm the head SHA is the one reviewed and CI is green on it.
2. `branch-check.sh` is clean (no conflict, no migration collision).
3. Merge as a **merge commit** (history stays reachable), message
   `Merge pull request #N: <title>`.
4. Watch the push CI run on `main`; a red main is the next task.

## 7. Release candidates

A release is a tag on a `main` commit whose **push** CI run is green;
`release.yml` refuses anything else and never republishes a version.
Preparing notes is fine; pushing a `v*` tag is the owner's decision. With a
Docker daemon, the deployment smokes (`nexa-test-selection` § Heavy suites) are
the local check of a release candidate; CI's Ubuntu job runs them anyway.
Version, notes and deploy steps: `docs/deployment.md` (§ releases, update,
rollback).
