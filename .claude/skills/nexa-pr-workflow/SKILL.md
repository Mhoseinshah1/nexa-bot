---
name: nexa-pr-workflow
description: The NEXA branch → PR → CI → review → merge cycle — syncing with main, detecting migration-number collisions and conflicts before they reach a PR, stacking dependent PRs, reading CI, and preparing (never performing, without the owner's explicit approval) a merge commit. Use when starting work on a branch, opening or updating a PR, handling CI or review feedback, or preparing a merge or a release candidate.
---

# Branch, PR and merge in NEXA

`CLAUDE.md` § Git is the authority. Merging, tagging, releasing and deploying
are the owner's call — "the work looks finished" is never approval. Read
`references/git-rule.md` for the full rule, REST endpoints, release detail.

## 0. The rule in short

Work on the session's task branch. **Never push implementation directly to
`main`**, and never force-push anything. `main` moves only through a PR the
owner explicitly approved after review, with CI green on the exact reviewed
head, merged as a merge commit. Absent that approval, leave the PR open and say
it is ready. A round prompt that says to push, open a PR and merge on green IS
that approval, for that round's PRs only (`nexa-round-pipeline`).

## 1. Start from the real main

```bash
git fetch origin main
git log --oneline -1 origin/main
git status -sb
```

- If the session branch's PR is already merged, restart it from `origin/main`
  (same name) instead of stacking on merged history.
- Otherwise bring main in with a **merge** (`git merge origin/main`), never a
  rebase of a pushed branch.

## 2. Check before you push or open a PR

```bash
bash .claude/skills/nexa-pr-workflow/scripts/branch-check.sh   # read-only
```

Reports ahead/behind, a dirty tree, trial-merge conflicts, a `packages/contracts`
change (its own commit, with the reason), and any migration this branch adds
that collides with or sits at or below `origin/main`'s highest. A
collision is fixed on the branch that merges second: after `git merge
origin/main`, `bash scripts/claude/renumber-migration.sh` (`--dry-run` first),
never a hand-edited `_journal.json` (`nexa-migrations` § Renumbering); then
`pnpm db:check` and the migration suites.

## 3. Open the PR

- Title: conventional prefix as in history (`fix(payments): …`, `feat(web): …`,
  `test(…)`, `docs(…)`, `chore(…)`).
- Body: what changed and why, how it was tested (only tests that exist and were
  run — cite commands, never discarded probes), what is **not** in the PR,
  open owner decisions, overlaps/stacking ("stacked on #N", "carries #N").
- No model names in commits, PR titles or bodies.
- Do not create a PR unless asked; then say it is ready and stop. A round
  prompt that says to push and open a PR is that ask (`nexa-round-pipeline`).
- A citation or falsification pin count (`pnpm check:citations`) rises only by
  exactly the citations this PR adds. Never raise it to hide a missing one.

## 4. CI and reviews

- CI runs on the PR's merge ref (`docs/ci.md`); pushes to non-main branches do
  not run CI. Read the failing job's log before touching code.
- Read CI with `nexa-ci-watch` (`bash scripts/claude/ci-status.sh <pr>`).
  GraphQL is blocked: `gh pr view`, `gh pr checks`, `gh run …` fail with 403;
  use `gh api repos/{owner}/{repo}/…` REST.
- Request the Codex review yourself (`@codex review`, at most twice per PR) and
  act on that one review only (`nexa-round-pipeline` §3).
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
  earlier one lands.
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

A release is a tag on a `main` commit whose **push** CI run is green. Preparing
notes is fine; pushing a `v*` tag is the owner's decision. Deploy steps:
`docs/deployment.md`.
