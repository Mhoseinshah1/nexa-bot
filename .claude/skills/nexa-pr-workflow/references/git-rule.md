# The git rule and PR detail (moved verbatim from SKILL.md, token diet)

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

## 2. Check before you push or open a PR — a migration collision

A migration collision is the most common merge break here (the Mirza importer
and three `fix10/*` PRs all claimed 0240). Fix it on the branch that merges
second: after `git merge origin/main`, run
`bash scripts/claude/renumber-migration.sh` (`--dry-run` first to see the plan),
which renumbers, regenerates the journal and snapshot with the tooling and
proves the SQL byte-identical (`nexa-migrations` § Renumbering) — never
hand-edit `_journal.json`. Then `pnpm db:check` and the migration suites.

## 4. CI and reviews — reading CI over REST

- Read CI with `nexa-ci-watch` (`bash scripts/claude/ci-status.sh <pr>`,
  `--fail-logs`, `--gate`, `--codex`). GraphQL is blocked here, so `gh pr view`,
  `gh pr checks` and `gh run …` fail with 403: use `gh api repos/{owner}/{repo}/…`
  REST (`pulls/{n}`, `commits/{sha}/check-runs`, `actions/jobs/{id}/logs`,
  `actions/runs/{id}/rerun-failed-jobs`, `pulls/{n}/ccr/review_threads`).

## 7. Release candidates

A release is a tag on a `main` commit whose **push** CI run is green;
`release.yml` refuses anything else and never republishes a version.
Preparing notes is fine; pushing a `v*` tag is the owner's decision. With a
Docker daemon, the deployment smokes (`nexa-test-selection` § Heavy suites) are
the local check of a release candidate; CI's Ubuntu job runs them anyway.
Version, notes and deploy steps: `docs/deployment.md` (§ releases, update,
rollback).
