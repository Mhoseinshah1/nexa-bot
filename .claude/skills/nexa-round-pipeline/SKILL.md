---
name: nexa-round-pipeline
description: The owner's standing rules for a NEXA work round — parallel agents in worktrees, the 25-line subagent report, the lead's review, the push → one CI checker → one Codex review → one fix commit → green → merge-commit pipeline, safety, budget, final report. Use when a round prompt says "Follow nexa-round-pipeline", when planning a multi-agent round, or when deciding whether a PR may be merged.
---

# A NEXA round, start to finish

The round prompt names tasks and models; the rest is here. `CLAUDE.md`,
`nexa-pr-workflow`, `nexa-test-selection` still apply. Read
`references/round-details.md` for agent-setup commands, §1a holds, §4 detail;
`references/agent-review-lessons.md` for incidents.

## 1. Agents

- Each implementer: own `git worktree add -b <branch> <dir> <base>`; never two
  agents in one checkout. **At most 3 implementer agents run at the same time**
  unless the round prompt sets another number.
- Models come from the round prompt; **Sonnet stays the default**. Light work
  (read-only fact collection, README, formatting): the cheapest agent.
- Integration suites run against **separate databases**, one integration run at
  a time round-wide (§1a). Nobody idles on CI.
- **Fresh agent per PR** for merge-main, renumber, gate and fix work, returning
  the 25-line report (§2); the lead runs none of those steps nor reads logs.
- Setup commands: `references/round-details.md`. A **private database per
  agent**, BOTH `TEST_DATABASE_URL` and `DATABASE_URL` set to it; drop it at
  round end.

## 1a. Test load: one runner, no pause

**No global test pause, ever.** EVERY test, typecheck, lint, format, `db:check`
or verify-stage run, from every worktree, goes through the runner, in the
foreground (Bash timeout 600000; split file lists):

```bash
bash scripts/claude/run-gate.sh [--integration] [--max-wait <s>] <command...>
```

Max 2 runs at once, one integration run round-wide; the rest queue and resume
by themselves. Agents quote its digest, not raw output. Exit 75 = gave up
waiting: keep coding, re-run later. Nobody bypasses it or waits for a manual
"resume". The lead's tool is a priority hold (`--hold lead`, `--release lead`),
not a pause: short named reason, released when gone. Never wait on a
background command blindly (3 min of empty output: `pgrep -af`).

**Local gate = affected suites only** (`nexa-test-selection`: tiers, the
`pnpm test:integration <files>` trap); the **full integration suite runs on CI
only**. A money PR keeps `pnpm verify` once at the end and its guard suites.

## 2. Lead review

- **Subagent report: at most 25 lines**: files changed; tests added and their
  mutation checks; decisions taken; open problems. No code, logs or narration.
- The lead reads each report once and the full diff once, line by line, and
  confirms no reviewer mutation is left (`git status`, `git diff`, deletions).
- **Non-money shortcut** (`nexa-test-selection`): a PR touching no money,
  ledger, payment, gateway, pricing, provisioning or migration code may use the
  affected suites as its local gate and skip the lead's one-pass review; CI
  still runs the full suite on the exact head, Codex is still read and fixed
  (§3), the pre-commit `git status` + `git diff` read is never skipped. Money
  PRs, and any unclear PR, keep `pnpm verify`, guard suites and the lead review.
- Progress lines only on a merge, a breakage or a decision.

## 3. PR pipeline

Push → open the PR → request Codex → **one** CI checker (`nexa-ci-watch`) →
act on the **one** Codex review → fix all its findings in **one** commit → green
CI on that head → merge with a **merge commit**. No second review round; never
request a review after the fix commit.

Waiting for CI is ONE foreground blocking call with a timeout
(`bash scripts/claude/ci-status.sh --wait <pr> --max 540`, under the Bash
tool's 600 s limit; `nexa-ci-watch`), never an agent polling in a loop.

**The lead (or the CI checker) requests Codex itself, at once** (owner,
2026-10-31) — REST only, exactly this text, nothing else in the comment:

```bash
gh api repos/Mhoseinshah1/nexa-bot/issues/<pr>/comments -f body='@codex review'
```

- When: right after opening the PR (or pushing the head to review); after a
  re-push that changes the head while that head still needs its one review;
  once more if Codex still "runs" 1 h after the comment — then report it and
  keep working on other PRs. **At most 2 `@codex review` comments per PR.**
- Clean = a Codex receipt "Didn't find any major issues" whose reviewed commit
  is the head, or Codex's 👍 newer than the head's push (`--codex`: `receipt=<head>:clean`
  or `thumbsup=head`); treat it as findings=none.
- Opening a PR also triggers Codex, so a head may get two reviews: act on the
  FIRST complete review of that head only; ignore the other (no reply, no fix).

A round prompt that says to push, open a PR and merge on green **is** the
explicit owner approval `nexa-pr-workflow` §6 requires, for that round's PRs,
on the exact head where CI is fully green and the Codex findings are fixed.
Nothing else is approval.

## 4. Multi-PR rounds

- Merge in the stated order; after each merge, merge `origin/main` into the
  next branch (a merge, never a rebase).
- Renumber its migrations (`nexa-migrations` § Renumbering): rebuild
  `packages/contracts`, run `bash scripts/claude/renumber-migration.sh`
  (`identical=no` or non-zero exit stops the merge), then `pnpm db:check` and
  the migration suites. SQL stays byte-identical; the PR body says so.
- Small unrelated changes may share one PR (one CI + one Codex cycle) when each
  is small and none is money or a migration.

## 5. Invariants

- A `packages/contracts` change is its own commit, with the reason.
- Every new rule has a test that fails when the rule is reverted.
- A citation/falsification pin count rises only by exactly the citations this
  PR adds. Never raise it to hide a missing reference.

## 6. Safety

- No customer message from a migration, an import or a backfill.
- Never push to `main`. Never force-push. Never push a tag.
- The owner's test-server checklist always ends with
  `sudo botctl roles disable provisioner monitor`.
- Before integration tests, `bash scripts/dev-services.sh`: an unreachable
  Postgres or Redis is not a test result.
- Repo-wide checks (lint, boundaries) run from a clean checkout; stale
  `.claude/worktrees/*` copies break them.

## 7. Ambiguity

Work without asking. Take the reading that moves no money and sends no
customer message; record it under "Decisions taken".

## 8. Budget

Near the session limit: finish and merge what is done, write a handoff
(`nexa-handoff`), list the rest. A round always ends with a handoff; never
leave a half-done change pushed without one. Refresh it after every merged PR
and at ~50 % context; after a compact, re-read the round prompt and handoff.

## 9. End of round

Remove every worktree and temporary test database the round created.

- **Per-PR report** (link and merge commit; what changed; the Codex fixes;
  tests and their mutation checks; decisions taken; the owner's test checklist
  with exact `botctl` commands, ending as in §6) goes into the PR description
  and `docs/round-reports/<round>.md`. Nothing is dropped from it.
- The chat final message is a summary of at most 20 lines with links.
- End the report file with a short **usage table**: PRs, agents used, model per
  agent (as its tier: lead / default / money; model names only in chat, never in
  the repository), CI cycles, and any usage numbers the CLI shows.
